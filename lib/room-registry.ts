/**
 * Room + token registry — the whole auth surface of Bridger.
 *
 * PORTED, NOT INVENTED
 * --------------------
 * This is a port of `roastmydev/lib/external/key-registry.ts`, which has been
 * in production since S#266. The properties carried over deliberately, each
 * because it was learned the hard way there:
 *
 *  - **Only `sha256(token)` is stored.** The token is printed once, by `open`,
 *    and is never written anywhere we control. A dump of this registry cannot
 *    be used to call the bridge.
 *  - **Fail CLOSED.** If the registry cannot be read and no cached record is in
 *    hand, authentication fails. The alternative — serving on a Redis blip —
 *    means an unauthenticated party can post into a partner's decision record.
 *  - **Revocation lands inside one cache window.** A short in-process cache
 *    keeps a blip from dropping a partner mid-integration; past that window we
 *    stop. A revoked token must never keep working, so the grace is bounded and
 *    not a moment longer.
 *  - **An env kill switch** stops the bridge without touching Redis.
 *
 * WHY TOKENS ARE NOT ENV VARS
 * ---------------------------
 * Because revocation would then be a deploy. A partner relationship ends; the
 * token has to die on demand, from a CLI, in seconds.
 *
 * ONE ROOM, TWO TOKENS
 * --------------------
 * `createRoom` mints both sides at once. You keep yours; the other is the one
 * you paste to your partner. Which side a caller is on is a property of the
 * token they present, so no request ever has to claim an identity — it proves
 * one. That is what makes `bridger_ask` unable to post as the other party.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  AUDIT_LOG,
  AUDIT_LOG_MAX,
  KILL_SWITCH,
  RATE_KEY,
  RATE_LIMIT_PER_MINUTE,
  DEFAULT_DAILY_CAP,
  DEFAULT_ROOM_DAILY_CAP,
  USAGE_KEY,
  ROOM_USAGE_KEY,
  WAIT_STREAK_KEY,
  utcDay,
  ROOM_KEY,
  ROOM_TOKENS_KEY,
  ROOM_TTL_SECONDS,
  type Store,
  TOKEN_KEY,
  coerceJson,
  minuteBucket,
} from "./store";

// ── shapes ───────────────────────────────────────────────────────

export type SideId = "a" | "b";

/**
 * What a token may do.
 *
 * `participant` writes to the record and speaks as its side. `viewer` reads and
 * nothing else.
 *
 * WHY THIS EXISTS, WITH THE INCIDENT ATTACHED
 * -------------------------------------------
 * Until this existed every token could write, and the read-only web view had no
 * token of its own — so watching a bridge meant pasting a *participant* token
 * into a browser tab. Anyone seeing that screen, or that tab's storage, could
 * then post as that side. The UI made authorship cheap to steal, and the UI was
 * the reason someone would put a token somewhere visible in the first place.
 *
 * A viewer is still bound to a side, because "unread" and "whose turn" are only
 * meaningful from a point of view. It borrows the perspective; it cannot use it.
 */
export type TokenRole = "participant" | "viewer";

export interface TokenRecord {
  /** First 12 chars of the sha256. Safe to log; the rate-limit bucket. */
  id: string;
  roomId: string;
  side: SideId;
  /** Human label for this side, e.g. "judgemysite". */
  label: string;
  /** Short uppercase code used to namespace this side's entry IDs, e.g. "JMS". */
  code: string;
  /**
   * Defaults to `participant` when absent so every token minted before roles
   * existed keeps working exactly as it did. A missing field must never
   * silently downgrade a partner mid-integration.
   */
  role: TokenRole;
  /**
   * Hard stop per UTC day.
   *
   * RESTORED, and the omission is worth recording: `key-registry.ts` — the file
   * this was ported from — has enforced a `dailyCap` in production since S#266,
   * and the port dropped it while the DECISIONS entry claimed the properties
   * were taken wholesale "because those were each learned from a real
   * incident". They were. Then an agent loop on the other side of the bridge
   * burned an entire model quota, and the only thing standing between it and
   * infinity was a 120/minute rate limit.
   */
  dailyCap: number;
  active: boolean;
  createdAt: string;
  /** ISO date, or null for no expiry. */
  expiresAt: string | null;
}

export interface RoomSide {
  label: string;
  code: string;
  joinedAt: string | null;
}

export interface RoomRecord {
  id: string;
  /** What this bridge is for, e.g. "judgemysite x trigvanta — live review API". */
  topic: string;
  createdAt: string;
  closed: boolean;
  sides: Record<SideId, RoomSide>;
  /**
   * Aggregate hard stop per UTC day, across every token on this room.
   *
   * Survives rotation, which is the point — see `ROOM_USAGE_KEY`. A room stored
   * before this field existed parses to `DEFAULT_ROOM_DAILY_CAP` rather than
   * Infinity, on the same reasoning as `TokenRecord.dailyCap`: an uncapped
   * bridge is the bug, so the missing field must fail toward the limit.
   */
  dailyCap: number;
}

export type DenyReason =
  | "bridge-disabled"
  | "no-token"
  | "unknown-token"
  | "revoked"
  | "expired"
  | "room-missing"
  | "room-closed"
  | "rate-limited"
  | "daily-cap"
  | "room-daily-cap"
  | "registry-unavailable";

/**
 * What the caller is told, in terms an AGENT will act on.
 *
 * The distinction that matters is retryable vs terminal. A generic 401 reads to
 * an agent as "something went wrong, try again" — which is the worst possible
 * reply to a runaway loop, because it invites exactly one more turn, and then
 * one more. These messages say STOP in the first word and state plainly that
 * retrying cannot succeed.
 */
export const DENY_MESSAGE: Record<DenyReason, string> = {
  "bridge-disabled":
    "STOP. The bridge has been disabled by its operator. Do not call any bridger tool again in this session — retrying cannot succeed. Tell your operator the bridge is switched off.",
  "rate-limited":
    "STOP. You are calling the bridge too fast and have been rate limited. Do not retry in a loop. The other side is a human-paced integration; if you have nothing new to say, stop calling and report what you have.",
  "daily-cap":
    "STOP. This token has spent its call budget for today. Do not call any bridger tool again — every further attempt will be refused and will waste your own context. Tell your operator the bridge budget is exhausted.",
  // Deliberately does NOT suggest asking for a new token. `daily-cap` says
  // "tell your operator the budget is exhausted", and the honest operator
  // response to that is to rotate — which used to hand the loop a fresh 400.
  // This message closes that path in words as well as in the counter.
  "room-daily-cap":
    "STOP. This bridge has spent its call budget for today, across every token on it. Do not call any bridger tool again, and do not ask for a replacement token — a new token will be refused the same way until the budget resets at 00:00 UTC. Tell your operator the bridge is done for the day.",
  revoked:
    "STOP. This token has been revoked. Do not retry; ask your operator for a new one.",
  expired: "STOP. This token has expired. Do not retry; ask your operator for a new one.",
  "room-closed": "STOP. This bridge has been closed. Do not retry.",
  "room-missing": "STOP. This room no longer exists. Do not retry.",
  "unknown-token": "STOP. This token is not recognised. Do not retry.",
  "no-token": "No bridge token was presented.",
  "registry-unavailable":
    "The bridge cannot reach its registry and is refusing requests. This may be temporary; do not retry more than once.",
};

export type AuthOutcome =
  | { ok: true; token: TokenRecord; room: RoomRecord }
  | { ok: false; reason: DenyReason };

/** Human-readable reason + the HTTP status it should surface as. */
export const DENY_STATUS: Record<DenyReason, number> = {
  "bridge-disabled": 503,
  "no-token": 401,
  "unknown-token": 401,
  revoked: 401,
  expired: 401,
  "room-missing": 404,
  "room-closed": 410,
  "rate-limited": 429,
  "daily-cap": 429,
  "room-daily-cap": 429,
  "registry-unavailable": 503,
};

/** Refusals a caller must never retry. Used to shape the response, not just log it. */
export const TERMINAL_DENIALS: ReadonlySet<DenyReason> = new Set<DenyReason>([
  "bridge-disabled",
  "daily-cap",
  "room-daily-cap",
  "revoked",
  "expired",
  "room-closed",
  "room-missing",
  "unknown-token",
]);

/** How long a fetched record is trusted without re-reading. Revocation lands within this. */
export const CACHE_TTL_MS = 30_000;

export const TOKEN_PREFIX = "br_live_";

// ── primitives ───────────────────────────────────────────────────

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function mintTokenString(): string {
  return TOKEN_PREFIX + randomBytes(24).toString("hex");
}

export function newRoomId(): string {
  return randomBytes(6).toString("hex");
}

/**
 * Derive the entry-ID namespace from a side's label: "JudgeMySite" -> "JMS".
 *
 * Author-namespaced IDs are what make the ledger merge-free — two sides writing
 * at the same moment cannot collide, because neither can mint the other's
 * prefix. Falls back to a padded slice when the label has no word boundaries.
 */
export function deriveCode(label: string): string {
  const words = label
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "XXX";

  if (words.length >= 2) {
    // "Big Red Widget Co" -> BRW
    return initialsOf(words.slice(0, 3).map((w) => w[0]).join(""));
  }
  // One word: prefer its internal capitals when there are at least two
  // ("JudgeMySite" -> JMS), otherwise just take the first three letters
  // ("Trigvanta" -> TRI). Requiring TWO capitals is the fix for a real bug:
  // a single leading capital used to yield "T" and pad to "TXX".
  const caps = words[0].replace(/[^A-Z]/g, "");
  return initialsOf(caps.length >= 2 ? caps : words[0]);
}

function initialsOf(s: string): string {
  return s.toUpperCase().padEnd(3, "X").slice(0, 3);
}

/**
 * Guarantee the two sides never share a code.
 *
 * Entry IDs are namespaced by code, and the whole merge-free property rests on
 * them being distinct — two partners both called "Acme" would otherwise mint
 * colliding IDs and silently overwrite each other's questions. Walks the
 * alphabet on the last character, then falls back to a fixed pair.
 */
export function disambiguateCode(code: string, taken: string): string {
  if (code !== taken) return code;
  const head = code.slice(0, 2);
  for (const c of "BCDEFGHIJKLMNOPQRSTUVWXYZ23456789") {
    const candidate = head + c;
    if (candidate !== taken) return candidate;
  }
  return "ZZ9";
}

export const otherSide = (s: SideId): SideId => (s === "a" ? "b" : "a");

// ── cache ────────────────────────────────────────────────────────

type CacheEntry<T> = { record: T | null; fetchedAt: number };
const tokenCache = new Map<string, CacheEntry<TokenRecord>>();
const roomCache = new Map<string, CacheEntry<RoomRecord>>();

/** Test seam; also called after any mutation so a revoke is visible immediately. */
export function clearRegistryCache(): void {
  tokenCache.clear();
  roomCache.clear();
}

// ── parsing ──────────────────────────────────────────────────────

export function parseToken(raw: unknown): TokenRecord | null {
  const obj = coerceJson(raw);
  if (!obj || typeof obj !== "object") return null;
  const r = obj as Partial<TokenRecord>;
  if (typeof r.id !== "string" || typeof r.roomId !== "string") return null;
  if (r.side !== "a" && r.side !== "b") return null;
  return {
    id: r.id,
    roomId: r.roomId,
    side: r.side,
    label: typeof r.label === "string" ? r.label : "",
    code: typeof r.code === "string" ? r.code : "XXX",
    // Only the exact string "viewer" restricts. Anything else — including a
    // missing field on a pre-roles token, or a corrupted value — resolves to
    // participant, which is how it behaved before roles existed.
    role: r.role === "viewer" ? "viewer" : "participant",
    // A token minted before caps existed gets the default rather than
    // Infinity — the whole point is that an un-capped token is the bug.
    dailyCap: Number.isFinite(r.dailyCap) ? Number(r.dailyCap) : DEFAULT_DAILY_CAP,
    active: r.active !== false,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
    expiresAt: typeof r.expiresAt === "string" ? r.expiresAt : null,
  };
}

/** True when this token may write to the record. */
export const canWrite = (t: TokenRecord): boolean => t.role !== "viewer";

/** The refusal a viewer gets — says what it is and how to get past it. */
export const VIEWER_REFUSAL =
  "This is a VIEWER token: it can read the record but not write to it. " +
  "Ask whoever opened the bridge for a participant token (`bridger rotate --side <a|b>`).";

export function parseRoom(raw: unknown): RoomRecord | null {
  const obj = coerceJson(raw);
  if (!obj || typeof obj !== "object") return null;
  const r = obj as Partial<RoomRecord>;
  if (typeof r.id !== "string") return null;
  const side = (s: unknown): RoomSide => {
    const v = (s ?? {}) as Partial<RoomSide>;
    return {
      label: typeof v.label === "string" ? v.label : "",
      code: typeof v.code === "string" ? v.code : "XXX",
      joinedAt: typeof v.joinedAt === "string" ? v.joinedAt : null,
    };
  };
  return {
    id: r.id,
    topic: typeof r.topic === "string" ? r.topic : "",
    createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
    closed: r.closed === true,
    sides: { a: side(r.sides?.a), b: side(r.sides?.b) },
    // A room minted before room caps existed gets the default, never Infinity.
    dailyCap: Number.isFinite(r.dailyCap) ? Number(r.dailyCap) : DEFAULT_ROOM_DAILY_CAP,
  };
}

// ── authorisation ────────────────────────────────────────────────

export interface AuthContext {
  presentedToken: string | null;
  now: Date;
  /**
   * Whether this call spends budget.
   *
   * A request passes through authorisation TWICE — once in the outer budget
   * gate, which needs to shape a terminal refusal, and once inside
   * `withMcpAuth`, whose `verifyToken` can only answer yes or no. Charging in
   * both places would double every counter and halve every cap, so exactly one
   * of them charges. Defaults true so a caller that forgets fails safe (too
   * strict) rather than unmetered.
   */
  charge?: boolean;
}

/**
 * Resolve a presented token to a room and a side, or say precisely why not.
 *
 * Order is deliberate and mirrors the JudgeMySite original: the kill switch is
 * checked before anything else so one flag stops the bridge regardless of token
 * state, and the rate-limit counter is incremented LAST — a request refused for
 * a closed room must not consume the caller's budget.
 */
export async function authorize(store: Store | null, ctx: AuthContext): Promise<AuthOutcome> {
  if (envKillSwitch()) return { ok: false, reason: "bridge-disabled" };
  if (!ctx.presentedToken) return { ok: false, reason: "no-token" };
  if (!store) return { ok: false, reason: "registry-unavailable" };

  try {
    if (await store.get(KILL_SWITCH)) return { ok: false, reason: "bridge-disabled" };
  } catch {
    // A kill switch we cannot read is one we must assume is ON: if this read
    // failed, the token record and the rate limiter are equally unreadable.
    return { ok: false, reason: "registry-unavailable" };
  }

  const hash = hashToken(ctx.presentedToken);
  const token = await loadCached(store, tokenCache, TOKEN_KEY(hash), hash, parseToken, ctx.now);
  if (token === undefined) return { ok: false, reason: "registry-unavailable" };
  if (token === null) return { ok: false, reason: "unknown-token" };
  if (!token.active) return { ok: false, reason: "revoked" };
  if (token.expiresAt && new Date(token.expiresAt).getTime() <= ctx.now.getTime()) {
    return { ok: false, reason: "expired" };
  }

  const room = await loadCached(
    store,
    roomCache,
    ROOM_KEY(token.roomId),
    token.roomId,
    parseRoom,
    ctx.now,
  );
  if (room === undefined) return { ok: false, reason: "registry-unavailable" };
  if (room === null) return { ok: false, reason: "room-missing" };
  if (room.closed) return { ok: false, reason: "room-closed" };

  // Counters are charged LAST, once every other gate has passed: a request
  // refused for a closed room must not spend the caller's budget.
  if (ctx.charge !== false) {
    try {
      const bucket = RATE_KEY(token.id, minuteBucket(ctx.now));
      const perMinute = await store.incr(bucket);
      if (perMinute === 1) await store.expire(bucket, 120);
      if (perMinute > RATE_LIMIT_PER_MINUTE) return { ok: false, reason: "rate-limited" };

      const day = utcDay(ctx.now);
      const dayKey = USAGE_KEY(token.id, day);
      const perDay = await store.incr(dayKey);
      // 48h so a counter always outlives its own UTC day whenever it started;
      // the key name already scopes it to one day.
      if (perDay === 1) await store.expire(dayKey, 172_800);
      if (perDay > token.dailyCap) return { ok: false, reason: "daily-cap" };

      // The aggregate ceiling, charged LAST so the narrowest limit is the one
      // that gets reported: a caller over its own cap should be told "your
      // token is done", not "the whole bridge is done", because those two
      // refusals send its operator to different places.
      const roomKey = ROOM_USAGE_KEY(room.id, day);
      const roomPerDay = await store.incr(roomKey);
      if (roomPerDay === 1) await store.expire(roomKey, 172_800);
      if (roomPerDay > room.dailyCap) return { ok: false, reason: "room-daily-cap" };
    } catch {
      return { ok: false, reason: "registry-unavailable" };
    }
  }

  return { ok: true, token, room };
}

/**
 * Consecutive empty `bridger_wait` calls for a token.
 *
 * `bump` returns the new streak; any other tool call resets it. A streak past
 * `MAX_EMPTY_WAIT_STREAK` means the caller is polling an empty bridge, which is
 * the exact shape of the loop that burned a quota — the wait tool answers
 * honestly ("nothing yet") and an agent reads that as a reason to wait again.
 */
export async function bumpWaitStreak(store: Store, tokenId: string): Promise<number> {
  try {
    const key = WAIT_STREAK_KEY(tokenId);
    const n = await store.incr(key);
    if (n === 1) await store.expire(key, 3600);
    return n;
  } catch {
    return 0; // never let bookkeeping refuse a call that was otherwise fine
  }
}

export async function resetWaitStreak(store: Store, tokenId: string): Promise<void> {
  try {
    await store.set(WAIT_STREAK_KEY(tokenId), 0);
  } catch {
    /* best-effort */
  }
}

/**
 * `undefined` = could not read (registry unavailable).
 * `null`      = read successfully, no such record.
 */
async function loadCached<T>(
  store: Store,
  cache: Map<string, CacheEntry<T>>,
  key: string,
  cacheKey: string,
  parse: (raw: unknown) => T | null,
  now: Date,
): Promise<T | null | undefined> {
  const cached = cache.get(cacheKey);
  if (cached && now.getTime() - cached.fetchedAt < CACHE_TTL_MS) return cached.record;

  try {
    const record = parse(await store.get(key));
    cache.set(cacheKey, { record, fetchedAt: now.getTime() });
    return record;
  } catch {
    // Serve a stale record rather than drop a partner over one blip — but only
    // inside a bounded window, because a revoked token must never keep working.
    if (cached && now.getTime() - cached.fetchedAt < CACHE_TTL_MS * 2) return cached.record;
    return undefined;
  }
}

/** Break-glass: one env var stops the bridge without touching Redis. */
export function envKillSwitch(): boolean {
  return process.env.BRIDGER_DISABLED === "true";
}

// ── mutations ────────────────────────────────────────────────────

export interface CreatedRoom {
  room: RoomRecord;
  /** Yours. Shown once. */
  ownerToken: string;
  /** The one you send to your partner. Shown once. */
  peerToken: string;
}

/**
 * Create a room and mint both sides' tokens in one call.
 *
 * Both tokens are returned in plaintext exactly once, here. Only their hashes
 * are persisted, so this return value is the sole opportunity to capture them —
 * the CLI prints them and never stores them.
 */
export async function createRoom(
  store: Store,
  opts: { topic: string; ownerLabel: string; peerLabel: string; now: Date },
): Promise<CreatedRoom> {
  const roomId = newRoomId();
  const iso = opts.now.toISOString();

  const ownerCode = deriveCode(opts.ownerLabel);
  const peerCode = disambiguateCode(deriveCode(opts.peerLabel), ownerCode);

  const room: RoomRecord = {
    id: roomId,
    topic: opts.topic,
    createdAt: iso,
    closed: false,
    sides: {
      a: { label: opts.ownerLabel, code: ownerCode, joinedAt: iso },
      b: { label: opts.peerLabel, code: peerCode, joinedAt: null },
    },
    dailyCap: DEFAULT_ROOM_DAILY_CAP,
  };

  await store.set(ROOM_KEY(roomId), JSON.stringify(room));
  const ownerToken = await issueToken(store, room, "a", opts.now);
  const peerToken = await issueToken(store, room, "b", opts.now);
  await store.expire(ROOM_KEY(roomId), ROOM_TTL_SECONDS);

  clearRegistryCache();
  return { room, ownerToken, peerToken };
}

/** Mint one token for a side and register it. Returns the plaintext, once. */
export async function issueToken(
  store: Store,
  room: RoomRecord,
  side: SideId,
  now: Date,
  expiresAt: string | null = null,
  role: TokenRole = "participant",
): Promise<string> {
  const raw = mintTokenString();
  const hash = hashToken(raw);
  const record: TokenRecord = {
    id: hash.slice(0, 12),
    roomId: room.id,
    side,
    label: room.sides[side].label,
    code: room.sides[side].code,
    role,

    dailyCap: DEFAULT_DAILY_CAP,
    active: true,
    createdAt: now.toISOString(),
    expiresAt,
  };
  await store.set(TOKEN_KEY(hash), JSON.stringify(record));
  await store.sadd(ROOM_TOKENS_KEY(room.id), hash);
  await store.expire(TOKEN_KEY(hash), ROOM_TTL_SECONDS);
  await store.expire(ROOM_TOKENS_KEY(room.id), ROOM_TTL_SECONDS);
  clearRegistryCache();
  return raw;
}

/**
 * Revoke every token on a side and mint a fresh one.
 *
 * Rotation revokes rather than deletes: the old hash stays with `active: false`
 * so a caller still holding it gets `revoked` — a precise answer — instead of
 * `unknown-token`, which reads like a typo and sends them hunting the wrong bug.
 */
export async function rotateSide(
  store: Store,
  room: RoomRecord,
  side: SideId,
  now: Date,
): Promise<string> {
  // Only participants. Rotating the working token because it leaked should not
  // silently blind whoever was watching the room on a viewer link — that is a
  // different decision, and it belongs to whoever makes it deliberately.
  await revokeSide(store, room, side, "participant");
  return issueToken(store, room, side, now);
}

/**
 * Deactivate tokens belonging to a side. Idempotent.
 *
 * `role` narrows it; omitting it revokes everything on that side, which is the
 * right default for "this partner is gone".
 */
export async function revokeSide(
  store: Store,
  room: RoomRecord,
  side: SideId,
  role?: TokenRole,
): Promise<number> {
  const hashes = await store.smembers(ROOM_TOKENS_KEY(room.id));
  let revoked = 0;
  for (const hash of hashes) {
    const record = parseToken(await store.get(TOKEN_KEY(hash)));
    if (!record || record.side !== side || !record.active) continue;
    if (role && record.role !== role) continue;
    await store.set(TOKEN_KEY(hash), JSON.stringify({ ...record, active: false }));
    revoked += 1;
  }
  clearRegistryCache();
  return revoked;
}

/** Mark the room closed. Tokens stay resolvable so callers get `room-closed`, not `unknown-token`. */
export async function closeRoom(store: Store, room: RoomRecord): Promise<void> {
  await store.set(ROOM_KEY(room.id), JSON.stringify({ ...room, closed: true }));
  clearRegistryCache();
}

/** Record that a side has connected — drives `peer never joined` in status. */
export async function markJoined(
  store: Store,
  room: RoomRecord,
  side: SideId,
  now: Date,
): Promise<RoomRecord> {
  if (room.sides[side].joinedAt) return room;
  const next: RoomRecord = {
    ...room,
    sides: { ...room.sides, [side]: { ...room.sides[side], joinedAt: now.toISOString() } },
  };
  await store.set(ROOM_KEY(room.id), JSON.stringify(next));
  clearRegistryCache();
  return next;
}

// ── audit ────────────────────────────────────────────────────────

export interface AuditEntry {
  ts: string;
  tokenId: string | null;
  roomId: string | null;
  side: SideId | null;
  tool: string;
  status: "ok" | "deny" | "error";
  reason?: DenyReason | string;
  durationMs?: number;
}

/**
 * Append one line to a capped list. Never throws: a bridge that 500s because
 * its logger is down is a worse outcome than a missing log line.
 */
export async function writeAudit(store: Store | null, entry: AuditEntry): Promise<void> {
  if (!store) return;
  try {
    await store.lpush(AUDIT_LOG, JSON.stringify(entry));
    await store.ltrim(AUDIT_LOG, 0, AUDIT_LOG_MAX - 1);
  } catch {
    /* logging is best-effort by design */
  }
}
