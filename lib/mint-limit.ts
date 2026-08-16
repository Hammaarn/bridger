/**
 * WHO MAY OPEN A ROOM, AND HOW OFTEN.
 *
 * Until S#275 opening a room required `UPSTASH_REDIS_REST_*` in the operator's
 * environment, so "who may create" answered itself: whoever holds the database
 * credentials. The browser flow removes that gate on purpose — Erik's call, and
 * the right one: *"the room is the platform and the tokens generated from that
 * room are the connectors."* A creation button behind a login is not a platform.
 *
 * WHAT THIS IS, STATED HONESTLY. A cost-of-abuse measure, not a security
 * boundary. Anyone with a VPN, a phone hotspot or a $5 proxy defeats a per-IP
 * cap in about ten seconds, and nothing here pretends otherwise. What it does
 * buy is real: it stops a script from minting ten thousand rooms into Erik's
 * Upstash on a bored afternoon, which is the actual failure mode of an open
 * mint endpoint. The defence that scales is on the other side — a room costs
 * almost nothing until a second party connects, and an unclaimed one expires
 * fast (`UNCLAIMED_ROOM_TTL_SECONDS`).
 *
 * WHY THE ADMIN BYPASS IS A TOKEN AND NOT AN IP. The obvious reading of "my dev
 * one should be unlimited" is an IP allowlist. It would work until Erik's ISP
 * rotated his address, and then it would fail as a rate limit on his own
 * product — a symptom that looks like a bug in this file rather than a stale
 * constant. Identity survives a DHCP lease; location does not.
 * `BRIDGER_ADMIN_IPS` still exists as a convenience for a fixed office range,
 * and is documented as the fragile half.
 *
 * WE DO NOT STORE IP ADDRESSES. An IP is personal data under GDPR, Bridger is
 * operated from Sweden, and this endpoint is reachable by anyone — so the
 * counter is keyed on a SALTED hash of the address bucket, never the address.
 * The salt matters more than it looks: IPv4 is a 32-bit space, so an unsalted
 * SHA-256 of an address is reversible by brute force in seconds on a laptop,
 * and an "anonymised" counter would in fact be a log of who visited. With
 * `BRIDGER_IP_SALT` set it is not reversible; without it we fall back to the
 * Upstash token, which is already a server-only secret, and warn if neither
 * exists.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { MINT_KEY, utcDay, type Store } from "./store";

/** Rooms one fingerprint may open per UTC day. Erik's number. */
export const ROOMS_PER_DAY_PER_IP = 3;

/**
 * How long a room nobody ever joined survives.
 *
 * The per-IP cap bounds how fast junk arrives; this bounds how long it stays.
 * A real room gets a second party within minutes and is then on the normal
 * 30-day idle TTL like any other. Two hours is generous for a human who opens
 * a room, gets distracted, and comes back — and short enough that a burst of
 * abandoned rooms costs nothing by the end of the afternoon.
 */
export const UNCLAIMED_ROOM_TTL_SECONDS = 2 * 60 * 60;

export type MintVerdict =
  | { ok: true; reason: "admin" | "within-quota"; used: number; limit: number | null }
  | { ok: false; reason: "mint-quota"; used: number; limit: number; resetsAt: string };

/**
 * The client's address as this platform reports it.
 *
 * Next 16 removed `NextRequest.ip` (it is absent from
 * `next/dist/server/web/spec-extension/request.d.ts` in 16.3.0 — checked, not
 * remembered), so this reads headers directly.
 *
 * ORDER MATTERS AND IS NOT ARBITRARY. `x-real-ip` is set by Vercel's own edge
 * and cannot be influenced by the caller, so it wins. `x-forwarded-for` is the
 * fallback and its LEFTMOST entry is the original client — but that header is
 * caller-writable on a platform that does not overwrite it, which is precisely
 * why it is second and why the docstring at the top of this file does not claim
 * this is a security boundary. A spoofed header buys a fresh quota; so does a
 * VPN, more easily.
 */
export function clientIp(req: Request): string | null {
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const fwd = req.headers.get("x-forwarded-for");
  const first = fwd?.split(",")[0]?.trim();
  return first || null;
}

/**
 * Collapse an address to the unit we actually want to count.
 *
 * IPv6 IS THE TRAP. A residential ISP hands a single customer a /64 at minimum
 * — 18 quintillion addresses — and many hand out a /56 or /48. Counting exact
 * v6 addresses is therefore identical to having no limit at all for anyone on
 * a modern connection, while v4 users get the real cap. That asymmetry is
 * invisible in testing (a laptop on v4 sees the limit work perfectly) and total
 * in production. So v6 collapses to its /64 prefix; v4 counts exactly.
 */
export function ipBucket(raw: string): string {
  const ip = raw.trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  // IPv4-mapped IPv6 (`::ffff:203.0.113.5`) is a v4 client; count it as one.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) return `v4:${mapped[1]}`;
  if (!ip.includes(":")) return `v4:${ip}`;

  // Expand `::` so the first four hextets can be taken positionally.
  const [head, tail] = ip.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const full =
    tail === undefined
      ? left
      : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  const prefix = full.slice(0, 4).map((h) => (h === "" ? "0" : h.replace(/^0+(?=.)/, "")));
  while (prefix.length < 4) prefix.push("0");
  return `v6:${prefix.join(":")}::/64`;
}

/**
 * A stable, non-reversible name for a bucket.
 *
 * Truncated to 128 bits: collision-irrelevant at this scale, and it keeps the
 * Redis key short. See the file header for why the salt is load-bearing.
 */
export function fingerprint(bucket: string): string {
  const salt = process.env.BRIDGER_IP_SALT ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? "";
  if (!salt && process.env.NODE_ENV === "production") {
    // Not fatal -- a missing salt degrades privacy, it does not break counting,
    // and failing room creation over it would be the wrong trade. Loud, though.
    console.warn(
      "[mint-limit] no BRIDGER_IP_SALT and no Upstash token: IP hashes are brute-forceable",
    );
  }
  // LENGTH-PREFIXED, and that is domain separation rather than decoration:
  // without it, salt "ab" + bucket "cd" and salt "a" + bucket "bcd" hash to the
  // same value, so one salt could be made to impersonate another. A delimiter
  // byte would also work, but the salt is arbitrary env text that may contain
  // any delimiter we picked -- a length cannot be forged by its own content.
  const material = `${salt.length}:${salt}${bucket}`;
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

/** Constant-time compare that does not leak length through an early return. */
function secretEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Is this the operator?
 *
 * The header name is deliberately not `Authorization`: that header already
 * carries room tokens on every other route, and overloading it would mean a
 * misrouted room token could be tested against the admin secret. Separate
 * secrets get separate headers.
 */
export function isAdminRequest(req: Request): boolean {
  const presented = req.headers.get("x-bridger-admin")?.trim();
  const expected = process.env.BRIDGER_ADMIN_TOKEN?.trim();
  if (presented && expected && secretEquals(presented, expected)) return true;

  // The fragile half, kept because a fixed address is genuinely convenient.
  const allow = (process.env.BRIDGER_ADMIN_IPS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allow.length) return false;
  const ip = clientIp(req);
  if (!ip) return false;
  const bucket = ipBucket(ip);
  return allow.some((entry) => ipBucket(entry) === bucket);
}

/** Midnight UTC after `now`, ISO — what a refused caller is told to wait for. */
function nextUtcMidnight(now: Date): string {
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}

/**
 * Charge one room against today's quota.
 *
 * INCREMENTS FIRST, then compares. The read-then-write shape has a race in
 * which two simultaneous requests both read 2, both decide they are allowed,
 * and both create — and on an endpoint whose entire job is to bound creation,
 * that race is the bug. `incr` is atomic, so the fourth caller of the day gets
 * 4 and is refused whatever the concurrency.
 *
 * A refused attempt therefore still burns a slot. That is deliberate: making
 * refusals free means a script can probe the boundary indefinitely at no cost.
 */
export async function chargeMint(store: Store, req: Request, now: Date): Promise<MintVerdict> {
  if (isAdminRequest(req)) return { ok: true, reason: "admin", used: 0, limit: null };

  const ip = clientIp(req);
  // No address at all: a local dev request, or a platform that did not set the
  // headers. Counting every such caller into one shared bucket would make the
  // whole product unusable behind an unknown proxy; treating them as unlimited
  // would be a hole. They share a bucket, which is the honest middle.
  const bucket = ip ? ipBucket(ip) : "unknown";
  const key = MINT_KEY(fingerprint(bucket), utcDay(now));

  const used = await store.incr(key);
  // Set the TTL every time rather than only on the first increment: a missed
  // expire on a `1` would otherwise strand the counter forever, permanently
  // banning that bucket. Cheap, and it fails safe.
  await store.expire(key, 48 * 60 * 60);

  if (used > ROOMS_PER_DAY_PER_IP) {
    return {
      ok: false,
      reason: "mint-quota",
      used,
      limit: ROOMS_PER_DAY_PER_IP,
      resetsAt: nextUtcMidnight(now),
    };
  }
  return { ok: true, reason: "within-quota", used, limit: ROOMS_PER_DAY_PER_IP };
}
