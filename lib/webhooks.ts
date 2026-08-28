/**
 * WAKE-UP HOOKS — the first outbound request this service has ever made.
 *
 * WHAT THIS CHANGES ABOUT BRIDGER, said first because it is the important part.
 * ---------------------------------------------------------------------------
 * Until now the server made no outbound calls at all, and `/api/about` said so:
 * *"Every byte this service receives was placed there by a tool call the caller
 * chose to make; it cannot reach into a session and take anything."* The first
 * clause is still true. The second is still true. But "makes no outbound
 * requests" stops being true here, and the disclosure in `/api/about` is
 * updated in the same commit rather than left to rot — a service whose trust
 * argument is "read the server that is asking you to trust it" does not get to
 * quietly grow a capability its own description denies.
 *
 * WHAT IT STILL CANNOT DO.
 * ---------------------------------------------------------------------------
 * **This does not make your model start a turn, and nothing can.** A webhook
 * wakes a PROCESS that is already listening — a gateway bot, a CI runner, a
 * daemon with an HTTPS endpoint. It cannot cause Claude Code or Cursor to begin
 * inference; for those, the client-side stop hook in
 * `integrations/claude-code/` is the mechanism, and it works precisely because
 * it runs on the operator's own machine on the operator's own quota.
 *
 * WE SEND METADATA, NEVER CONTENT, AND THAT IS NOT AN OPTIMISATION.
 * ---------------------------------------------------------------------------
 * The payload carries `seq`, `type`, `side` and a timestamp. It never carries a
 * title or a body. In a two-party room the far side consented to US reading
 * their text; they did not consent to it being POSTed to a third-party URL they
 * have never seen. So a misconfigured or leaked hook URL discloses THAT
 * something happened, never WHAT. The woken process reads the room itself, with
 * its own credential, through the path that wraps partner text in containment
 * markers. Same doorbell principle as the Claude Code hook.
 *
 * THE SSRF SURFACE, AND WHY THE GUARD IS WHERE IT IS.
 * ---------------------------------------------------------------------------
 * An operator-supplied URL that the server then fetches is a server-side
 * request forgery primitive by construction. Three defences, and the second is
 * the one people forget:
 *
 *   1. **Validate at registration** — https, no credentials in the URL, and a
 *      hostname that is not obviously internal.
 *   2. **Re-resolve and re-check at DELIVERY.** A name that resolved to a
 *      public address at registration can resolve to 169.254.169.254 an hour
 *      later. Checking only at registration is checking the wrong moment.
 *   3. **Never follow redirects.** A 302 to a private address defeats both of
 *      the above, so delivery uses `redirect: "manual"` and treats a redirect
 *      as a failed delivery.
 *
 * Honest residual: between our DNS lookup and the socket connect there is a
 * window a determined attacker with control of a DNS zone could exploit
 * (classic rebinding). Closing it properly requires connecting to a pinned
 * address, which `fetch` does not expose. The window is small, the payload is
 * metadata, and the attacker must already hold a participant credential in a
 * room. Stated rather than hidden.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import type { SideId } from "./room-registry";
import {
  MAX_WEBHOOKS_PER_ROOM,
  MAX_WEBHOOK_FAILURES,
  ORPHAN_TTL_SECONDS,
  WEBHOOKS_KEY,
  WEBHOOK_CACHE_MS,
  WEBHOOK_TIMEOUT_MS,
  type Store,
} from "./store";

export interface RoomWebhook {
  id: string;
  /** Whose hook. Only the OTHER side's writes wake it — never your own. */
  side: SideId;
  url: string;
  /** Held in plaintext because signing requires it. See `SECURITY.md`. */
  secret: string;
  createdAt: string;
  /** Consecutive failures. Reset on success; the hook is dropped at the cap. */
  failCount: number;
  lastStatus?: string;
  lastAt?: string;
}

export class WebhookRejected extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "WebhookRejected";
    this.reason = reason;
  }
}

// ── the URL guard ───────────────────────────────────────────────────────────

const BLOCKED_HOST_SUFFIXES = [
  "localhost",
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
];

/** Allow plain http and private targets. For self-hosters on a LAN only. */
export const allowInsecureTargets = () => process.env.BRIDGER_WEBHOOK_ALLOW_HTTP === "1";

/**
 * Is this a public, routable address? Everything else is refused.
 *
 * Written as an allow-nothing-by-default check over the documented special-use
 * ranges rather than a blocklist of the two or three everyone remembers —
 * carrier-grade NAT (100.64/10) and the v4-mapped v6 form are the ones that
 * usually slip through.
 */
export function isPublicAddress(addr: string): boolean {
  const kind = isIP(addr);
  if (kind === 4) {
    const p = addr.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [a, b] = p as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;         // CGNAT
    if (a === 169 && b === 254) return false;                   // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0) return false;                     // IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return false;       // benchmarking
    if (a >= 224) return false;                                 // multicast, reserved, broadcast
    return true;
  }
  if (kind === 6) {
    const v6 = addr.toLowerCase().replace(/^\[|\]$/g, "");
    if (v6 === "::" || v6 === "::1") return false;
    // v4-mapped (::ffff:a.b.c.d) is an IPv4 address wearing a v6 hat.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
    if (mapped) return isPublicAddress(mapped[1]);
    if (/^f[cd]/.test(v6)) return false;                        // unique local fc00::/7
    if (/^fe[89ab]/.test(v6)) return false;                     // link-local fe80::/10
    if (/^ff/.test(v6)) return false;                           // multicast
    return true;
  }
  return false;
}

/**
 * Registration-time validation. Throws `WebhookRejected` with a reason a human
 * can act on — a silent refusal here reads as "the feature is broken".
 */
export function assertDeliverableUrl(raw: unknown): URL {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new WebhookRejected("url-missing", "A webhook needs a URL.");
  }
  if (raw.length > 2000) {
    throw new WebhookRejected("url-too-long", "That URL is longer than 2000 characters.");
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new WebhookRejected("url-unparseable", "That is not a URL we can parse.");
  }
  const insecureOk = allowInsecureTargets();
  if (url.protocol !== "https:" && !(insecureOk && url.protocol === "http:")) {
    throw new WebhookRejected(
      "url-not-https",
      "A webhook URL must be https. We are about to send a signed request to it from our servers.",
    );
  }
  if (url.username || url.password) {
    throw new WebhookRejected(
      "url-has-credentials",
      "Put the credential in your endpoint's own check, not in the URL — a URL travels through logs.",
    );
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!insecureOk) {
    if (BLOCKED_HOST_SUFFIXES.some((s) => host === s || host.endsWith(s))) {
      throw new WebhookRejected("url-internal", `We cannot deliver to ${url.hostname} — it is not a public address.`);
    }
    if (isIP(host) && !isPublicAddress(host)) {
      throw new WebhookRejected("url-private-ip", `We cannot deliver to ${url.hostname} — it is not a public address.`);
    }
  }
  return url;
}

/**
 * Delivery-time re-check. See defence 2 in the header: a name that was public
 * at registration can point at a private address by the time we send.
 */
export async function resolvesToPublicAddress(hostname: string): Promise<boolean> {
  if (allowInsecureTargets()) return true;
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(host)) return isPublicAddress(host);
  try {
    const addrs = await lookup(host, { all: true });
    if (!addrs.length) return false;
    return addrs.every((a) => isPublicAddress(a.address));
  } catch {
    return false;
  }
}

// ── signing ─────────────────────────────────────────────────────────────────

export const signBody = (secret: string, body: string): string =>
  "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");

/**
 * Constant-time comparison, exported so a receiving endpoint written against
 * this file has a correct implementation to copy. `===` on an HMAC leaks its
 * prefix through timing.
 */
export function verifySignature(secret: string, body: string, presented: string): boolean {
  const expected = Buffer.from(signBody(secret, body), "utf8");
  const got = Buffer.from(String(presented ?? ""), "utf8");
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}

// ── storage ─────────────────────────────────────────────────────────────────

const cache = new Map<string, { at: number; hooks: RoomWebhook[] }>();

/** Drop the local cached view. Called on every mutation. */
export function clearWebhookCache(roomId?: string): void {
  if (roomId) cache.delete(roomId);
  else cache.clear();
}

function parse(raw: unknown): RoomWebhook[] {
  if (raw == null) return [];
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? (v as RoomWebhook[]) : [];
  } catch {
    return [];
  }
}

export async function listWebhooks(store: Store, roomId: string): Promise<RoomWebhook[]> {
  return parse(await store.get(WEBHOOKS_KEY(roomId)));
}

/** The cached read used on the write path. See `WEBHOOK_CACHE_MS`. */
export async function listWebhooksCached(
  store: Store,
  roomId: string,
  now: number = Date.now(),
): Promise<RoomWebhook[]> {
  const hit = cache.get(roomId);
  if (hit && now - hit.at < WEBHOOK_CACHE_MS) return hit.hooks;
  const hooks = await listWebhooks(store, roomId);
  cache.set(roomId, { at: now, hooks });
  return hooks;
}

async function save(store: Store, roomId: string, hooks: RoomWebhook[]): Promise<void> {
  if (hooks.length) await store.setex(WEBHOOKS_KEY(roomId), ORPHAN_TTL_SECONDS, JSON.stringify(hooks));
  else await store.del(WEBHOOKS_KEY(roomId));
  clearWebhookCache(roomId);
}

export async function registerWebhook(
  store: Store,
  roomId: string,
  input: { side: SideId; url: string; secret?: string },
  now: Date = new Date(),
): Promise<{ hook: RoomWebhook; secret: string; replaced: boolean }> {
  const url = assertDeliverableUrl(input.url);
  const hooks = await listWebhooks(store, roomId);

  // One hook per seat by default: a seat replacing its own registration is the
  // common case (a new tunnel URL), and silently accumulating stale endpoints
  // is how a room ends up POSTing to four dead hosts on every write.
  const mine = hooks.findIndex((h) => h.side === input.side);
  const secret = input.secret?.trim() || randomBytes(24).toString("base64url");
  const hook: RoomWebhook = {
    id: "wh_" + randomBytes(8).toString("hex"),
    side: input.side,
    url: url.toString(),
    secret,
    createdAt: now.toISOString(),
    failCount: 0,
  };
  let replaced = false;
  if (mine >= 0) {
    hook.id = hooks[mine].id;
    hooks[mine] = hook;
    replaced = true;
  } else {
    if (hooks.length >= MAX_WEBHOOKS_PER_ROOM) {
      throw new WebhookRejected("too-many", `This room already has ${MAX_WEBHOOKS_PER_ROOM} webhooks.`);
    }
    hooks.push(hook);
  }
  await save(store, roomId, hooks);
  return { hook, secret, replaced };
}

export async function unregisterWebhook(
  store: Store,
  roomId: string,
  match: { side: SideId; id?: string },
): Promise<boolean> {
  const hooks = await listWebhooks(store, roomId);
  // A seat may only remove its OWN hook. Anything else would let one party
  // silently deafen the other.
  const next = hooks.filter((h) => !(h.side === match.side && (!match.id || h.id === match.id)));
  if (next.length === hooks.length) return false;
  await save(store, roomId, next);
  return true;
}

async function recordOutcome(
  store: Store,
  roomId: string,
  id: string,
  ok: boolean,
  status: string,
  now: Date,
): Promise<void> {
  const hooks = await listWebhooks(store, roomId);
  const i = hooks.findIndex((h) => h.id === id);
  if (i < 0) return;
  const failCount = ok ? 0 : (hooks[i].failCount ?? 0) + 1;
  if (failCount >= MAX_WEBHOOK_FAILURES) {
    await save(store, roomId, hooks.filter((h) => h.id !== id));
    return;
  }
  hooks[i] = { ...hooks[i], failCount, lastStatus: status, lastAt: now.toISOString() };
  await save(store, roomId, hooks);
}

// ── delivery ────────────────────────────────────────────────────────────────

export interface WakePayload {
  event: "entry";
  room: string;
  seq: number;
  type: string;
  /** Which seat wrote. Never the recipient's own — see `dispatchWake`. */
  side: SideId;
  at: string;
  /** Deliberately absent: title, body, and every other piece of content. */
  next: string;
}

/** One attempt. Never throws — the caller is a write path that must not fail. */
export async function deliverOnce(
  hook: RoomWebhook,
  payload: WakePayload,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: string }> {
  let url: URL;
  try {
    url = new URL(hook.url);
  } catch {
    return { ok: false, status: "bad-url" };
  }
  if (!(await resolvesToPublicAddress(url.hostname))) {
    return { ok: false, status: "private-address" };
  }
  const body = JSON.stringify(payload);
  try {
    const res = await fetchImpl(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "bridger-webhook/1",
        "X-Bridger-Signature": signBody(hook.secret, body),
        "X-Bridger-Room": payload.room,
        "X-Bridger-Webhook-Id": hook.id,
      },
      body,
      // A 302 to a private address defeats every check above.
      redirect: "manual",
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400) return { ok: false, status: `redirect-${res.status}` };
    return { ok: res.ok, status: String(res.status) };
  } catch (e) {
    return { ok: false, status: (e as Error)?.name || "fetch-failed" };
  }
}

/**
 * Wake the OTHER side's hooks for a newly appended entry.
 *
 * Never throws and never blocks a write on a slow endpoint — the caller passes
 * this to a scheduler. A room with no hooks costs one cached read and returns.
 */
export async function dispatchWake(
  store: Store,
  roomId: string,
  entry: { seq: number; type: string; side: SideId; ts: string },
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  let hooks: RoomWebhook[];
  try {
    hooks = await listWebhooksCached(store, roomId, now.getTime());
  } catch {
    return 0;
  }
  // Your own writes never wake you. Without this, an agent that replies wakes
  // itself and the room feeds on its own tail.
  const targets = hooks.filter((h) => h.side !== entry.side);
  if (!targets.length) return 0;

  const payload: WakePayload = {
    event: "entry",
    room: roomId,
    seq: entry.seq,
    type: entry.type,
    side: entry.side,
    at: entry.ts,
    next: "Read the room with your own credential. This notice carries no content by design.",
  };

  const results = await Promise.all(
    targets.map(async (h) => {
      const out = await deliverOnce(h, payload, fetchImpl);
      try {
        await recordOutcome(store, roomId, h.id, out.ok, out.status, now);
      } catch {
        /* bookkeeping must never break delivery */
      }
      return out.ok;
    }),
  );
  return results.filter(Boolean).length;
}

/**
 * What a caller is allowed to see. The secret is shown ONCE at registration and
 * never again — every later read reports only that one is set, which is the
 * same rule tokens follow.
 */
export const redactWebhook = (h: RoomWebhook) => ({
  id: h.id,
  side: h.side,
  url: h.url,
  createdAt: h.createdAt,
  failCount: h.failCount ?? 0,
  lastStatus: h.lastStatus ?? null,
  lastAt: h.lastAt ?? null,
  secretSet: Boolean(h.secret),
});
