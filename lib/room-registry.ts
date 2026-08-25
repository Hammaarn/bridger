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
  MAX_LABEL,
  MAX_TOPIC,
  RoomTextRejected,
  sanitiseRoomMetadata,
  sanitiseRoomText,
} from "./room-text";
import { EMPTY_PLAN, parsePlan, type Plan } from "./plan";
import { defaultColourFor } from "./seats";
import {
  AUDIT_LOG,
  AUDIT_LOG_MAX,
  AUDIT_TRIM_SLACK,
  PLAN_KEY,
  ROOM_ACTIVITY_KEY,
  ROOM_ACTIVITY_DAYS_MAX,
  KILL_SWITCH,
  RATE_KEY,
  RATE_LIMIT_PER_MINUTE,
  VIEWER_RATE_LIMIT_PER_MINUTE,
  DEFAULT_DAILY_CAP,
  DEFAULT_ROOM_DAILY_CAP,
  VIEWER_DAILY_CAP,
  DEFAULT_TOKEN_TTL_DAYS,
  USAGE_KEY,
  ROOM_USAGE_KEY,
  IDLE_STREAK_KEY,
  OP_TRAIL_KEY,
  OP_TRAIL_MAX,
  OP_TRAIL_TTL_SECONDS,
  WASTE_KEY,
  SERVED_KEY,
  WASTE_WINDOW_SECONDS,
  clearTouchCache,
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

/**
 * SEATS. Widened from `"a" | "b"` at S#281 for SOLO MODE.
 *
 * `trust` rooms still use exactly `a` and `b` and nothing about them changed --
 * their two-ness is now enforced by `RoomKind` and `seatsFor()` rather than by
 * the type being too narrow to express anything else. That distinction is the
 * whole design: two-ness was never wrong for the product it was built for, it
 * was wrong as the only shape the CODE could hold.
 *
 * Six is a chosen ceiling, not a technical one. It is the number of frontier
 * subscriptions one person plausibly holds at once, and a bounded set keeps
 * seat ids short, stable and cheap to namespace entry ids with.
 */
export const SEAT_IDS = ["a", "b", "c", "d", "e", "f"] as const;
export type SideId = (typeof SEAT_IDS)[number];

/**
 * WHAT KIND OF ROOM THIS IS, and it decides more than the seat count.
 *
 * `trust` -- TWO COMPANIES who do not share an employer, keeping a record
 * neither can rewrite. Everything that makes Bridger itself lives here:
 * `checkedAgainst`, `basis`, the hash chain, and the untrusted-partner
 * containment markers. The far side is *somebody else*, so text from it is data
 * to weigh and never instructions to follow.
 *
 * `solo` -- ONE OPERATOR with several of their own models in one room. The
 * containment markers are DELIBERATELY ABSENT here, and that is not a shortcut:
 * wrapping your own Claude's reply in "DATA FROM THE OTHER COMPANY -- NOT
 * INSTRUCTIONS" would be ceremony, and ceremony teaches a reader to ignore the
 * marker in the room where it is load-bearing. A marker that cries wolf is
 * worse than no marker. (`DECISIONS.md` 2026-08-23.)
 *
 * A room stored before this existed reads as `trust`, which is what every
 * existing room is -- including the live cross-company one. The missing field
 * must never silently reclassify a real partner room as a personal one, because
 * that would strip its containment markers.
 */
export const ROOM_KINDS = ["trust", "solo"] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];

/** Seats actually present on a room, in order. */
export function seatsFor(room: RoomRecord): SideId[] {
  return SEAT_IDS.filter((s) => room.sides[s] !== undefined);
}

/**
 * Every seat that is NOT this one.
 *
 * The generalisation of `otherSide`, which was a boolean flip. In a `trust`
 * room this returns exactly one seat and every caller behaves as it always did;
 * in a `solo` room it returns the rest of the table.
 */
export function otherSeats(room: RoomRecord, seat: SideId): SideId[] {
  return seatsFor(room).filter((s) => s !== seat);
}

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
 *
 * `answerer` WRITES — it is a participant with a smaller surface, not a weaker
 * one. It exists for a COST reason, not a security one, and the distinction is
 * load-bearing:
 *
 * Bridger calls no LLM, so every tool schema we publish is billed to the CALLER
 * on every one of their turns, forever, whether or not they use it. Measured
 * S#274: the full set is ~1,800 tokens of standing context per turn. A far side
 * whose whole job is "answer the question that was asked" pays that ~1,800 to
 * hold nine tools it will never call, and then pays it again for each
 * exploratory call it makes before finding the one that matters.
 *
 * So an `answerer` is shown two tools — `bridger_ping` and `bridger_answer` —
 * and given no tool to probe WITH. The saving is real and it is theirs.
 *
 * [!!] HIDING IS NOT GATING. The narrowed tool list is a cost optimisation and
 * MUST NEVER be the only thing preventing an action. Every refusal still lives
 * in `operations.ts`, so an answerer that calls a hidden tool by hand is
 * refused there, on the same rule that refuses everyone else. A filter that
 * became the boundary would be a fake gate — the exact defect class this
 * repo keeps finding — so the ablation test asserts both halves.
 */
export type TokenRole = "participant" | "viewer" | "answerer";

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
  /**
   * WHICH AGENT IS SITTING HERE, self-declared, cosmetic, and never verified.
   *
   * The real cross-company room has `label: "claude"` on BOTH sides -- checked
   * against production S#280, not remembered. Two parties, same name. The S#280
   * rails fixed POSITION and COLOUR, and left the fact that neither party can be
   * named apart from the other.
   *
   * `label` is who the party IS (a company, a team). `agent` is what is TYPING
   * (claude, gemini, gpt, a human). They are different questions and one field
   * was answering neither well.
   *
   * **This is a claim by the side that set it, and nothing here checks it.** A
   * client can declare anything -- the transport has no way to know what model
   * is on the other end, and pretending otherwise would be the exact failure
   * this product exists to avoid. So it renders as a self-declared badge and is
   * never given a verification affordance. It is a courtesy for reading a room,
   * not evidence about who you are talking to.
   */
  agent?: string | null;
  /**
   * WHICH COLOUR THIS SEAT PICKED, by palette id (see `lib/seats.ts`).
   *
   * An id rather than a hex, for two reasons that are really one: a hex chosen
   * by a user is a hex that can be invisible in one of the two themes, and a
   * palette id resolves to a DIFFERENT rendering per theme. Storing the colour
   * itself would freeze one theme's answer into the record.
   *
   * Absent means "the default for this seat position", which is what every room
   * created before S#281 gets -- and for seats `a` and `b` that default is what
   * a trust room already looked like.
   */
  colour?: string | null;
  /**
   * THIS SIDE'S REPOSITORY, so its citations can be opened rather than trusted.
   *
   * Self-declared and never verified, exactly like `agent` -- nothing here
   * knows whether a side owns the repo it names. Stored as the operator typed
   * it and VALIDATED AT THE EDGE by `parseRepo`, which rejects anything that is
   * not `https://<known forge>/owner/name`. A rejected value simply produces no
   * links, which is what the room did before this existed.
   */
  repo?: string | null;
  /**
   * Branch, tag or commit for the links above. A SHA is the only ref that makes
   * a permalink permanent; a branch moves and takes the line numbers with it.
   */
  repoRef?: string | null;
}

export interface RoomRecord {
  id: string;
  /** What this bridge is for, e.g. "judgemysite x Northwind — live review API". */
  topic: string;
  createdAt: string;
  closed: boolean;
  /**
   * Present seats only. `trust` rooms always carry exactly `a` and `b`; a
   * `solo` room carries between 2 and `MAX_SOLO_SEATS`.
   */
  sides: Partial<Record<SideId, RoomSide>>;
  /**
   * See `RoomKind`. Absent means `trust` -- every room that existed before this
   * field is a two-company room, and defaulting the other way would strip a
   * real partner room of its containment markers.
   */
  kind: RoomKind;
  /**
   * Aggregate hard stop per UTC day, across every token on this room.
   *
   * Survives rotation, which is the point — see `ROOM_USAGE_KEY`. A room stored
   * before this field existed parses to `DEFAULT_ROOM_DAILY_CAP` rather than
   * Infinity, on the same reasoning as `TokenRecord.dailyCap`: an uncapped
   * bridge is the bug, so the missing field must fail toward the limit.
   */
  dailyCap: number;
  /**
   * F1. `plan` while the two sides are still working out what the job is;
   * `build` once they are doing it.
   *
   * **Shapes guidance and layout, never permissions.** Every operation works in
   * every phase. A room in `plan` that refused a `decide` would be a workflow
   * engine, and people route around workflow engines — the phase is here to
   * tell an agent what is most useful next, not to stop it doing something.
   *
   * A room stored before this existed reads as `build`, not `plan`: the rooms
   * that already exist are mid-work, and dropping them into a planning phase
   * would start advising two parties to plan something they have half shipped.
   */
  phase: RoomPhase;
}

export const ROOM_PHASES = ["plan", "build"] as const;
export type RoomPhase = (typeof ROOM_PHASES)[number];

/**
 * F2 room shapes live in `room-shapes.ts`, NOT here.
 *
 * They are the one part of the room model a browser needs, and this file
 * imports the store — so keeping them here dragged `node:fs` into the client
 * bundle and broke the dev build. Re-exported for callers that already had one
 * import; new code should reach for `room-shapes` directly.
 */
export { ROOM_SHAPES, shapeForPhase, defaultShapeFor, type RoomShape } from "./room-shapes";


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
/**
 * HTTP status per refusal — and the ONE invariant that governs this table.
 *
 * **429 IS RESERVED FOR REFUSALS THAT ARE GENUINELY RETRYABLE LATER, AND EVERY
 * 429 OR 503 MUST CARRY `Retry-After`.** `terminal` in the body must never
 * disagree with the status.
 *
 * Why this is not pedantry (S#276). 429 is the canonical *come back shortly*
 * status: HTTP clients, SDK retry middleware and agent frameworks retry it
 * automatically with backoff. `daily-cap` and `room-daily-cap` used to return
 * 429 while being TERMINAL, so the two refusals whose entire job is to end a
 * runaway loop were encoded as "please try again" — and that instruction is
 * obeyed by the transport layer, underneath the model, before a single token of
 * our carefully-worded refusal text can be read by anything able to understand
 * it. `refusalBody` was written knowing a looping agent reads a bare 4xx as
 * "try again" (see `http-gate.ts`); the missing half was that the status code
 * is read by machinery the message never reaches.
 *
 * `bridge-disabled` and `registry-unavailable` stay 503 because that is what is
 * true — the service really is unavailable, and monitoring should see it — but
 * they now carry `Retry-After` so a naive client backs off instead of hammering.
 */
export const DENY_STATUS: Record<DenyReason, number> = {
  "bridge-disabled": 503,
  "no-token": 401,
  "unknown-token": 401,
  revoked: 401,
  expired: 401,
  "room-missing": 404,
  "room-closed": 410,
  // The ONLY genuinely retryable refusal here: the window really does reopen,
  // in under a minute, and `Retry-After` says exactly when.
  "rate-limited": 429,
  // Terminal. Was 429 until S#276, which told every conformant client to retry
  // the cap that exists to stop it.
  "daily-cap": 403,
  "room-daily-cap": 403,
  "registry-unavailable": 503,
};

/**
 * Seconds a client should wait before retrying, per reason. Absent = no
 * `Retry-After` header, which is only correct for statuses that do not invite
 * a retry in the first place.
 *
 * `rate-limited` is computed from the clock rather than fixed, because the
 * limiter is a per-minute bucket: the honest answer is "when this minute ends".
 */
export function retryAfterSeconds(reason: DenyReason, now: Date): number | null {
  if (reason === "rate-limited") {
    // The bucket rolls at the top of the next minute. Never advertise 0.
    return Math.max(1, 60 - now.getUTCSeconds());
  }
  // A stopped bridge or an unreachable registry needs a human, not a backoff.
  // Long enough that a retry loop is not a load problem while it waits.
  if (reason === "bridge-disabled" || reason === "registry-unavailable") return 3600;
  return null;
}

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
  // ("Northwind" -> TRI). Requiring TWO capitals is the fix for a real bug:
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

/**
 * THE TRUST-ROOM PEER. Correct only where there are exactly two seats.
 *
 * Kept rather than deleted because in a `trust` room "the peer" is a real,
 * singular thing and pretending otherwise would make that code worse. Every
 * caller that must also work in a `solo` room uses `otherSeats` instead.
 */
export const otherSide = (s: SideId): SideId => (s === "a" ? "b" : "a");

// ── cache ────────────────────────────────────────────────────────

type CacheEntry<T> = { record: T | null; fetchedAt: number };
let killSwitchCache: { on: boolean; at: number } | null = null;
const tokenCache = new Map<string, CacheEntry<TokenRecord>>();
const roomCache = new Map<string, CacheEntry<RoomRecord>>();

/**
 * Test seam; also called after any mutation so a revoke is visible immediately.
 *
 * The kill-switch reading is cleared here too (S#281). It lives in a separate
 * variable but it is the same KIND of thing -- a cached answer about registry
 * state -- and a second reset function would be one more thing every caller has
 * to remember, which is how a cache-invalidation bug is born.
 */
export function clearRegistryCache(): void {
  tokenCache.clear();
  roomCache.clear();
  killSwitchCache = null;
  // The TTL-refresh cache lives in `store.ts` (S#283) for the same reason the
  // kill switch lives in its own variable: it is the same KIND of thing, and
  // one reset is the only way a test never has to know where each cache sits.
  clearTouchCache();
}

// ── parsing ──────────────────────────────────────────────────────

export function parseToken(raw: unknown): TokenRecord | null {
  const obj = coerceJson(raw);
  if (!obj || typeof obj !== "object") return null;
  const r = obj as Partial<TokenRecord>;
  if (typeof r.id !== "string" || typeof r.roomId !== "string") return null;
  // Any seat in the vocabulary. Widened from `a|b` at S#281 for solo rooms --
  // and it stays a WHITELIST rather than a string check, so a corrupted or
  // hand-crafted `side` still fails closed instead of naming a seat that does
  // not exist.
  const side = SEAT_IDS.find((id) => id === r.side);
  if (!side) return null;
  return {
    id: r.id,
    roomId: r.roomId,
    side,
    label: typeof r.label === "string" ? r.label : "",
    code: typeof r.code === "string" ? r.code : "XXX",
    // Only an EXACT known string selects a narrowed role. Anything else —
    // including a missing field on a pre-roles token, or a corrupted value —
    // resolves to participant, which is how it behaved before roles existed.
    // Keep this shape when adding a role: an unrecognised value must widen to
    // participant, never silently downgrade a partner mid-integration.
    role: r.role === "viewer" ? "viewer" : r.role === "answerer" ? "answerer" : "participant",
    // A token minted before caps existed gets the default rather than
    // Infinity — the whole point is that an un-capped token is the bug.
    dailyCap: Number.isFinite(r.dailyCap) ? Number(r.dailyCap) : DEFAULT_DAILY_CAP,
    active: r.active !== false,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
    expiresAt: typeof r.expiresAt === "string" ? r.expiresAt : null,
  };
}

/**
 * True when this token may write to the record.
 *
 * `answerer` writes — that is its entire purpose. Only `viewer` is read-only,
 * so this stays a viewer test rather than a participant whitelist: a role added
 * later without touching this line gets write access, which is the safe default
 * here (the narrow roles are about surface area, not privilege).
 */
export const canWrite = (t: TokenRecord): boolean => t.role !== "viewer";

/** True when this token should be shown the minimal, non-probing tool surface. */
export const isAnswerer = (t: TokenRecord): boolean => t.role === "answerer";

/** The refusal a viewer gets — says what it is and how to get past it. */
export const VIEWER_REFUSAL =
  "This is a VIEWER token: it can read the record but not write to it. " +
  "Ask whoever opened the bridge for a participant token (`bridger rotate --side <a|b>`).";

/**
 * One seat, asserted rather than guarded at 55 call sites.
 *
 * The invariant is real: a token is only ever minted for a seat that exists, and
 * `parseRoom` always materialises `a` and `b`. So a missing seat is corrupt
 * state, not a user error -- and the honest response to corrupt state is to fail
 * loudly here rather than to render a room with a blank participant in it.
 *
 * Every caller sits under a route that turns a throw into a 500, which is the
 * correct status for "our stored data is wrong".
 */
export function seat(room: RoomRecord, id: SideId): RoomSide {
  const s = room.sides[id];
  if (!s) throw new Error(`room ${room.id} has no seat "${id}"`);
  return s;
}

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
      // A room minted before this field existed reads as `null`, not as a
      // guess. We do not know what was sitting there and will not invent it.
      agent: typeof v.agent === "string" && v.agent ? v.agent : null,
      colour: typeof v.colour === "string" && v.colour ? v.colour : null,
      repo: typeof v.repo === "string" && v.repo ? v.repo : null,
      repoRef: typeof v.repoRef === "string" && v.repoRef ? v.repoRef : null,
    };
  };
  return {
    id: r.id,
    topic: typeof r.topic === "string" ? r.topic : "",
    createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
    closed: r.closed === true,
    // Only seats that are actually present. `a` and `b` are always materialised
    // so a `trust` room parses exactly as it always did -- including a legacy
    // room whose stored JSON predates every field below.
    sides: Object.fromEntries(
      SEAT_IDS.filter((id) => id === "a" || id === "b" || r.sides?.[id] !== undefined).map(
        (id) => [id, side(r.sides?.[id])],
      ),
    ) as Partial<Record<SideId, RoomSide>>,
    // Absent means `trust`. Every room that existed before this field is a
    // two-company room, and defaulting the other way would strip a real
    // partner room of its containment markers. See `RoomKind`.
    kind: r.kind === "solo" ? "solo" : "trust",
    // A room minted before room caps existed gets the default, never Infinity.
    dailyCap: Number.isFinite(r.dailyCap) ? Number(r.dailyCap) : DEFAULT_ROOM_DAILY_CAP,
    // Pre-F1 rooms are mid-work, not mid-planning. See `RoomRecord.phase`.
    phase: r.phase === "plan" ? "plan" : "build",
  };
}

// ── authorisation ────────────────────────────────────────────────

export interface AuthContext {
  presentedToken: string | null;
  now: Date;
  /**
   * Override the per-minute ceiling. Absent takes the role's own.
   *
   * Exists for `/api/since`, which is held to a much TIGHTER limit than the
   * interactive routes — it is for patient listeners, and saying so in the
   * limit is more honest than allowing an interactive rate on a route whose
   * whole argument is that its caller can wait.
   */
  rateCeiling?: number;
  /**
   * Skip the bookkeeping that exists to advise a looping AGENT.
   *
   * Drops the daily counters, the room-daily counter, the op trail and the idle
   * streak — roughly four Redis commands per call — leaving the kill switch,
   * the token/room reads (cached) and the per-minute limiter. That is what
   * makes a poll cost two commands instead of six, and at ten thousand polls a
   * night the difference is the free tier.
   *
   * ONLY for a route that does no work worth advising on. A `minimal` write
   * would be a hole: the trail and the streak are how a runaway gets told to
   * stop, and the daily cap is how it gets stopped.
   */
  minimal?: boolean;
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
 * How long a kill-switch READING may be reused.
 *
 * Deliberately short. The switch is the break-glass control, so the cost of
 * staleness is measured in how long a stopped bridge keeps answering -- and the
 * asymmetry below keeps that bounded to this window even in the worst case.
 */
export const KILL_SWITCH_CACHE_MS = 5_000;

/**
 * Read the kill switch, reusing a recent reading.
 *
 * ASYMMETRIC ON PURPOSE: only an OFF reading is cached. An ON reading is
 * returned and then re-read next call, so RESTARTING the bridge is immediate
 * while STOPPING it is delayed by at most one window. Cache the ON and a
 * restart would appear not to work, which is the direction that produces panic.
 */
async function killSwitchOn(store: Store, now: Date): Promise<boolean> {
  const t = now.getTime();
  if (killSwitchCache && !killSwitchCache.on && t - killSwitchCache.at < KILL_SWITCH_CACHE_MS) {
    return false;
  }
  const on = Boolean(await store.get(KILL_SWITCH));
  killSwitchCache = { on, at: t };
  return on;
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

  // Cached for KILL_SWITCH_CACHE_MS. This read ran on literally every call and
  // is almost always the same answer -- one command per request, forever, to
  // learn "no" (S#281). The cache is short and FAILS TOWARDS STOPPING: a cached
  // ON is trusted for its whole window, a cached OFF is re-read every few
  // seconds, so the panic button's worst case is a few seconds of delay rather
  // than a bridge that cannot be stopped.
  try {
    if (await killSwitchOn(store, ctx.now)) return { ok: false, reason: "bridge-disabled" };
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
      // A viewer gets its own ceiling: it cannot write and calls no model, so
      // the loop this limit exists to stop cannot happen on it. See
      // `VIEWER_RATE_LIMIT_PER_MINUTE` for the incident that found this.
      const ceiling =
        ctx.rateCeiling ??
        (token.role === "viewer" ? VIEWER_RATE_LIMIT_PER_MINUTE : RATE_LIMIT_PER_MINUTE);
      if (perMinute > ceiling) return { ok: false, reason: "rate-limited" };

      const day = utcDay(ctx.now);
      /**
       * THE MINIMAL PATH STOPS HERE, and everything below is what it skips.
       *
       * The per-minute limiter above has already run, so a runaway is bounded.
       * What follows -- the daily counters, the room aggregate, the op trail
       * and the idle streak -- is bookkeeping that exists to ADVISE a looping
       * agent and to protect a caller's model quota. A listening daemon has
       * neither problem: it is not looping by mistake, and it burns no tokens
       * at all. Charging it four extra Redis commands to record that is the
       * cost this route was built to remove. See `app/api/since/route.ts`.
       */
      if (ctx.minimal) return { ok: true, token, room };

      const dayKey = USAGE_KEY(token.id, day);
      const perDay = await store.incr(dayKey);
      // 48h so a counter always outlives its own UTC day whenever it started;
      // the key name already scopes it to one day.
      if (perDay === 1) await store.expire(dayKey, 172_800);
      // The viewer's own, much larger ceiling -- the same reasoning that gave it
      // a separate per-MINUTE limit, finally carried to the per-DAY one. A
      // token that carries an explicitly narrowed `dailyCap` (a link-minted
      // one) keeps it: that cap was chosen for how the credential TRAVELS, not
      // for what the role can do.
      const dailyCeiling =
        token.role === "viewer" && token.dailyCap === DEFAULT_DAILY_CAP
          ? VIEWER_DAILY_CAP
          : token.dailyCap;
      if (perDay > dailyCeiling) return { ok: false, reason: "daily-cap" };

      // THE AGGREGATE CEILING, AND WHY A WATCHER IS NOT CHARGED TO IT.
      //
      // Charged LAST so the narrowest limit is the one reported: a caller over
      // its own cap should hear "your token is done", not "the whole bridge is
      // done", because those send its operator to different places.
      //
      // Viewers are excluded outright, and that is the half of the S#280
      // incident that matters. The room budget is what the WORK runs on. Left
      // in, a browser tab left open overnight spends the room's 600 and then
      // both sides' agents are refused with `room-daily-cap` -- whose message
      // tells them not even to ask for a replacement token. That converts an
      // isolated annoyance (the watch tab stalls) into an outage of the actual
      // integration, caused by somebody looking at it. Merely RAISING the
      // viewer's own cap without this would have made tonight's failure worse,
      // not better.
      //
      // Safe because a viewer cannot write, calls no model, is bounded by
      // 60/minute and by `VIEWER_DAILY_CAP`, and exists only where an operator
      // minted one.
      if (token.role !== "viewer") {
        const roomKey = ROOM_USAGE_KEY(room.id, day);
        const roomPerDay = await store.incr(roomKey);
        if (roomPerDay === 1) await store.expire(roomKey, 172_800);
        if (roomPerDay > room.dailyCap) return { ok: false, reason: "room-daily-cap" };
      }
    } catch {
      return { ok: false, reason: "registry-unavailable" };
    }
  }

  return { ok: true, token, room };
}

/**
 * Consecutive calls that returned the caller nothing new.
 *
 * `bump` returns the new streak. It is reset by ACQUIRING INFORMATION — a wait
 * or read that returns entries, a status with unread — or by WRITING, because
 * an agent that posts is doing work rather than spinning.
 *
 * **The old docstring here claimed "any other tool call resets it", and that
 * was never true**: `resetWaitStreak` had exactly one call site, inside
 * `bridger_wait`. The code was SAFER than its comment, which is the dangerous
 * direction to be wrong in — the next reader "fixes" the code to match the
 * comment and opens the hole. Corrected S#272 rather than implemented.
 *
 * A streak means the caller is polling a quiet bridge, which is the exact shape
 * of the loop that burned a quota: every tool answers honestly, and an honest
 * "nothing yet" reads to an agent as a reason to ask again.
 */
export async function bumpIdleStreak(store: Store, tokenId: string): Promise<number> {
  try {
    const key = IDLE_STREAK_KEY(tokenId);
    const n = await store.incr(key);
    if (n === 1) await store.expire(key, 3600);
    return n;
  } catch {
    return 0; // never let bookkeeping refuse a call that was otherwise fine
  }
}

/**
 * Add uninformative response bytes to this token's rolling waste sum.
 *
 * NOT ATOMIC, and that is a deliberate call. The `Store` interface has `incr`
 * (by one) and no `incrby`, so this is read-add-write. Two concurrent calls can
 * lose one increment, which UNDERCOUNTS waste — the failure direction is
 * "slightly more rope for the caller", never a spurious refusal. Adding
 * `incrby` would mean touching three backends including `file-store.ts`, which
 * is outside the lane this was built in; the accuracy is not worth it for a
 * budget counter whose whole job is order-of-magnitude discrimination.
 */
/**
 * FIELD GUIDANCE: teach the habit on the wire, because the document cannot.
 *
 * C1, and it is the single most important thing the first real cross-company
 * session taught us. We fixed the join document to point at `ping` and shipped
 * it. An hour later the same far side answered a new question with `status` +
 * `read`, five times each, never calling `ping` once -- it was working from
 * `content.md`, its own copy saved at join time. The fix never reached it, and
 * the better we make that document the wider the gap grows between partners who
 * joined before it and partners who joined after.
 *
 * `guidance` already rides on every response. That is the live channel, and it
 * was only ever used for the idle brake. This puts the advice there too.
 *
 * ONE RULE, not a taxonomy. The rule is the observed behaviour: a caller
 * alternating status and read, with a ping available and unused, is spending
 * roughly eight times the bytes to learn the same thing. When somebody hits a
 * different wall in the field, that becomes the second rule -- written from
 * evidence, the way this one was.
 */
export async function noteOp(store: Store, tokenId: string, code: string): Promise<string> {
  try {
    const key = OP_TRAIL_KEY(tokenId);
    const prev = String((await store.get(key)) ?? "");
    const next = (prev + code).slice(-OP_TRAIL_MAX);
    // One SETEX rather than SET + conditional EXPIRE (S#281). The old form
    // saved a command on the common path by only expiring the FIRST write --
    // but a plain SET clears the TTL, so every subsequent write stripped the
    // expiry the first one set. The trail was immortal in practice; the
    // conditional was not an optimisation, it was the bug.
    await store.setex(key, OP_TRAIL_TTL_SECONDS, next);
    return next;
  } catch {
    return ""; // advisory bookkeeping never refuses a call that was otherwise fine
  }
}

/**
 * Reads a trail and returns advice, or null. Pure, so the rule is testable
 * without a store -- and so the rule can be read in one place rather than
 * inferred from where it fires.
 */
export function trailGuidance(trail: string): string | null {
  const s = trail.split("").filter((c) => c === "s").length;
  const r = trail.split("").filter((c) => c === "r").length;
  const pinged = trail.includes("p");
  if (pinged) return null;
  if (s >= 2 && r >= 2) {
    return (
      "You are using status + read where one bridger_ping would do. Ping returns " +
      "the questions waiting on you, anything new from the other side, and whether " +
      "they have signed off -- in a single call, for roughly an eighth of the bytes. " +
      "After it there is nothing further to look up."
    );
  }
  return null;
}


export async function bumpWaste(store: Store, tokenId: string, bytes: number): Promise<number> {
  try {
    const key = WASTE_KEY(tokenId);
    const prev = Number(await store.get(key)) || 0;
    const next = prev + Math.max(0, Math.floor(bytes));
    // SETEX, and it fixes the same latent bug as `noteOp`: SET clears the TTL,
    // so expiring only when `prev === 0` meant every later bump un-expired the
    // counter. A waste counter that never resets refuses an honest caller
    // forever. (S#281)
    await store.setex(key, WASTE_WINDOW_SECONDS, next);
    return next;
  } catch {
    return 0; // bookkeeping never refuses a call that was otherwise fine
  }
}

/**
 * The highest entry seq this token has ever been HANDED, tracked server-side.
 *
 * WHY NOT JUST TRUST THE CALLER'S CURSOR (S#276, found by side B on the bridge).
 * "Did this caller learn something" was `entries.length > 0`, which is a
 * property of the response rather than of the caller's knowledge. A client whose
 * cursor never advances — one that never passes `markRead` — is served the SAME
 * entries on every call, instantly, forever. Every one of those responses looked
 * informative, so every one reset the waste budget, so the brake could not see
 * the loop at all. At ~2 kB of entries per call returning in ~0.15s, that is the
 * most expensive loop in the product and the only thing bounding it was the
 * per-minute limiter.
 *
 * It is also a hole this session OPENED: defaulting `wait` to the caller's
 * cursor fixed a deadlock and, in the same stroke, made a stuck cursor return
 * instantly rather than block.
 *
 * The caller's cursor is exactly what is broken in that scenario, so the
 * high-water mark is kept HERE, where the caller cannot influence it.
 */
export async function noteServed(store: Store, tokenId: string, maxSeq: number): Promise<boolean> {
  try {
    const key = SERVED_KEY(tokenId);
    const prev = Number(await store.get(key)) || 0;
    if (maxSeq <= prev) return false; // re-serving what it already had is not learning
    await store.setex(key, WASTE_WINDOW_SECONDS, maxSeq); // S#281: was SET + EXPIRE
    return true;
  } catch {
    return true; // bookkeeping failure must not manufacture a refusal
  }
}

/** Read the waste sum without adding to it — so a refusal can precede the work. */
export async function peekWaste(store: Store, tokenId: string): Promise<number> {
  try {
    const n = Number(await store.get(WASTE_KEY(tokenId)));
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/** Learning something, or writing, clears the debt. */
export async function resetWaste(store: Store, tokenId: string): Promise<void> {
  try {
    await store.set(WASTE_KEY(tokenId), 0);
  } catch {
    /* best-effort */
  }
}

/**
 * Read the streak WITHOUT advancing it.
 *
 * Exists so a caller already over the limit can be refused before doing the
 * expensive thing, rather than after. Bumping here would double-count every
 * call and bring the refusal forward by one, changing the escalation; this
 * deliberately only looks.
 */
export async function peekIdleStreak(store: Store, tokenId: string): Promise<number> {
  try {
    const raw = await store.get(IDLE_STREAK_KEY(tokenId));
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0; // same posture as bumpIdleStreak: bookkeeping never refuses a good call
  }
}

export async function resetIdleStreak(store: Store, tokenId: string): Promise<void> {
  try {
    await store.set(IDLE_STREAK_KEY(tokenId), 0);
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
/**
 * MOST SEATS A SOLO ROOM MAY HAVE. See `SEAT_IDS` for why six.
 *
 * Two is the MINIMUM for a solo room too: a room with one seat is a notepad,
 * and Bridger is not one.
 */
export const MAX_SOLO_SEATS = SEAT_IDS.length;
export const MIN_SEATS = 2;

export async function createRoom(
  store: Store,
  opts: {
    topic: string;
    ownerLabel: string;
    peerLabel: string;
    now: Date;
    /** F2. Omitted keeps the existing default — see `phase` below. */
    phase?: RoomPhase;
  },
): Promise<CreatedRoom> {
  const roomId = newRoomId();
  const iso = opts.now.toISOString();

  // Sanitise HERE, not in the callers. Since S#275 a room can be opened from a
  // public browser endpoint, so `topic` and both labels are strings a stranger
  // picks that our model later reads — see `lib/room-text.ts`. Throws
  // `RoomTextRejected` on input that cannot be made safe; the mint route turns
  // that into a 400 and the CLI prints it.
  const { topic, ownerLabel, peerLabel } = sanitiseRoomMetadata(opts);

  const ownerCode = deriveCode(ownerLabel);
  const peerCode = disambiguateCode(deriveCode(peerLabel), ownerCode);

  const room: RoomRecord = {
    id: roomId,
    topic,
    createdAt: iso,
    closed: false,
    sides: {
      a: { label: ownerLabel, code: ownerCode, joinedAt: iso },
      b: { label: peerLabel, code: peerCode, joinedAt: null },
    },
    dailyCap: DEFAULT_ROOM_DAILY_CAP,
    kind: "trust",
    // A NEW trust room still DEFAULTS to `plan`, and that is the opinionated
    // half of F1: two parties opening a bridge have not yet agreed what the
    // work is -- that is the whole reason they opened one. F2 makes it a
    // choice rather than a rule; the default is unchanged, so every existing
    // caller and every existing test gets exactly what it got before.
    phase: opts.phase ?? "plan",
  };

  await store.set(ROOM_KEY(roomId), JSON.stringify(room));
  const ownerToken = await issueToken(store, room, "a", opts.now);
  const peerToken = await issueToken(store, room, "b", opts.now);
  await store.expire(ROOM_KEY(roomId), ROOM_TTL_SECONDS);

  clearRegistryCache();
  return { room, ownerToken, peerToken };
}

export interface CreatedSoloRoom {
  room: RoomRecord;
  /** One plaintext token per seat, in seat order. Shown once. */
  tokens: { side: SideId; label: string; code: string; token: string }[];
}

/**
 * Open a SOLO room -- one operator, several of their own models.
 *
 * Deliberately a separate function rather than a `kind` flag on `createRoom`.
 * The two constructors genuinely differ: `createRoom` mints an OWNER token and
 * a token you send to a stranger, and the whole invite/join ceremony hangs off
 * that asymmetry. Here every seat is yours and there is no stranger, so there
 * is no owner/peer distinction to preserve and no invitation to issue. Folding
 * them into one function with a mode flag would mean a body of `if (kind ===
 * ...)` in the one place a room's identity is decided.
 *
 * Every seat joins immediately: you are not waiting for anyone to accept.
 */
export async function createSoloRoom(
  store: Store,
  opts: { topic: string; seatLabels: string[]; now: Date; phase?: RoomPhase },
): Promise<CreatedSoloRoom> {
  const n = opts.seatLabels.length;
  if (n < MIN_SEATS || n > MAX_SOLO_SEATS) {
    throw new RoomTextRejected(
      "seats",
      `a room needs between ${MIN_SEATS} and ${MAX_SOLO_SEATS} seats; got ${n}`,
    );
  }
  const roomId = newRoomId();
  const iso = opts.now.toISOString();
  const topic = sanitiseRoomText(opts.topic, "topic", MAX_TOPIC);
  const labels = opts.seatLabels.map((l, i) => sanitiseRoomText(l, `seat ${i + 1}`, MAX_LABEL));

  // Codes namespace entry ids, so two seats sharing one would make entry ids
  // ambiguous -- and a solo room is the MOST likely place for a collision,
  // because "claude" and "claude-opus" are exactly what one person names their
  // own models. Disambiguate against everything already taken, not just the
  // previous one.
  const codes: string[] = [];
  for (const label of labels) {
    let code = deriveCode(label);
    for (const taken of codes) code = disambiguateCode(code, taken);
    codes.push(code);
  }

  const sides: Partial<Record<SideId, RoomSide>> = {};
  labels.forEach((label, i) => {
    const id = SEAT_IDS[i]!;
    // Coloured ON CREATION rather than left to the operator. A solo room's
    // whole problem is telling six of your own models apart, and a room that
    // opens monochrome asks you to solve that by hand before you can use it.
    sides[id] = {
      label,
      code: codes[i]!,
      joinedAt: iso,
      agent: null,
      colour: defaultColourFor(id).id,
    };
  });

  const room: RoomRecord = {
    id: roomId,
    topic,
    createdAt: iso,
    closed: false,
    sides,
    dailyCap: DEFAULT_ROOM_DAILY_CAP,
    kind: "solo",
    // A solo room DEFAULTS to `build`. The planning default exists because two
    // COMPANIES opening a bridge have not yet agreed what the job is; one
    // person putting three of their own models in a room has already decided.
    // Still choosable -- "plan first" is a perfectly reasonable thing to want
    // from your own three models.
    phase: opts.phase ?? "build",
  };

  await store.setex(ROOM_KEY(roomId), ROOM_TTL_SECONDS, JSON.stringify(room));

  const tokens: CreatedSoloRoom["tokens"] = [];
  for (let i = 0; i < labels.length; i++) {
    const side = SEAT_IDS[i]!;
    tokens.push({
      side,
      label: labels[i]!,
      code: codes[i]!,
      token: await issueToken(store, room, side, opts.now),
    });
  }

  clearRegistryCache();
  return { room, tokens };
}

/** Mint one token for a side and register it. Returns the plaintext, once. */
export async function issueToken(
  store: Store,
  room: RoomRecord,
  side: SideId,
  now: Date,
  /**
   * `undefined` (or omitted) takes the default lifetime. `null` means FOREVER
   * and must now be written deliberately.
   *
   * The distinction is the whole fix. This parameter used to default to `null`,
   * so every caller that wanted to reach `role` typed `null` as filler and
   * minted an immortal credential without deciding to — five call sites, none
   * of which meant it. Making "forever" require an explicit `null` turns a
   * default into a choice someone has to justify in a diff.
   */
  expiresAt?: string | null,
  role: TokenRole = "participant",
  dailyCap: number = DEFAULT_DAILY_CAP,
): Promise<string> {
  const expiry =
    expiresAt === undefined
      ? new Date(now.getTime() + DEFAULT_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()
      : expiresAt;
  const raw = mintTokenString();
  const hash = hashToken(raw);
  const record: TokenRecord = {
    id: hash.slice(0, 12),
    roomId: room.id,
    side,
    label: seat(room, side).label,
    code: seat(room, side).code,
    role,

    dailyCap,
    active: true,
    createdAt: now.toISOString(),
    expiresAt: expiry,
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
  if (seat(room, side).joinedAt) return room;
  const next: RoomRecord = {
    ...room,
    sides: { ...room.sides, [side]: { ...seat(room, side), joinedAt: now.toISOString() } },
  };
  await store.set(ROOM_KEY(room.id), JSON.stringify(next));
  clearRegistryCache();
  return next;
}

/**
 * A side names itself: who it is, and what is typing.
 *
 * Only ever your OWN side. The creating operator names both parties at mint
 * time and is guessing about the far one -- the far side is the only party that
 * knows what it actually is, and letting one side rename the other would make
 * the whole field worthless as a reading of the room.
 */
export async function setSideIdentity(
  store: Store,
  room: RoomRecord,
  sideId: SideId,
  patch: {
    label?: string;
    agent?: string | null;
    colour?: string | null;
    repo?: string | null;
    repoRef?: string | null;
  },
): Promise<RoomRecord> {
  const current = seat(room, sideId);
  const next: RoomRecord = {
    ...room,
    sides: {
      ...room.sides,
      [sideId]: {
        ...current,
        label: patch.label !== undefined ? patch.label : current.label,
        agent: patch.agent !== undefined ? patch.agent : (current.agent ?? null),
        colour: patch.colour !== undefined ? patch.colour : (current.colour ?? null),
        repo: patch.repo !== undefined ? patch.repo : (current.repo ?? null),
        repoRef: patch.repoRef !== undefined ? patch.repoRef : (current.repoRef ?? null),
      },
    },
  };
  await store.set(ROOM_KEY(room.id), JSON.stringify(next));
  clearRegistryCache();
  return next;
}

/** Move the room between phases. Nothing is gated on this; see `RoomRecord.phase`. */
export async function setRoomPhase(
  store: Store,
  room: RoomRecord,
  phase: RoomPhase,
): Promise<RoomRecord> {
  const next: RoomRecord = { ...room, phase };
  await store.set(ROOM_KEY(room.id), JSON.stringify(next));
  clearRegistryCache();
  return next;
}

/** Read the plan. A missing or corrupt record reads as an EMPTY plan, never as a throw. */
export async function readPlan(store: Store, roomId: string): Promise<Plan> {
  try {
    return parsePlan(await store.get(PLAN_KEY(roomId)));
  } catch {
    return EMPTY_PLAN;
  }
}

export async function writePlan(store: Store, roomId: string, plan: Plan): Promise<void> {
  await store.setex(PLAN_KEY(roomId), ROOM_TTL_SECONDS, JSON.stringify(plan));
  // Expires with the room it belongs to, like the contract.
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
 * What a room has actually seen, in a record nothing can evict.
 *
 * `days` holds UTC dates, so "came back" has a definition instead of a feeling:
 * a room with more than one entry was used on more than one day. That is the
 * number the funnel argument runs on, and the rolling audit structurally cannot
 * supply it -- one global list means a busy room evicts a quiet returning one.
 */
export interface RoomActivity {
  calls: number;
  firstAt: string;
  lastAt: string;
  days: string[];
}

export async function readRoomActivity(store: Store, roomId: string): Promise<RoomActivity | null> {
  try {
    const raw = await store.get(ROOM_ACTIVITY_KEY(roomId));
    if (!raw) return null;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    // Shape-check rather than trust: this record is read by the operator to
    // answer a question about the business, and a half-written value should
    // read as ABSENT rather than as zero usage.
    if (!parsed || typeof parsed.calls !== "number" || !Array.isArray(parsed.days)) return null;
    return parsed as RoomActivity;
  } catch {
    return null;
  }
}

/**
 * Append one line to a capped list, and update the room's uncapped tally.
 *
 * Never throws: a bridge that 500s because its logger is down is a worse outcome
 * than a missing log line.
 */
export async function writeAudit(store: Store | null, entry: AuditEntry): Promise<void> {
  if (!store) return;
  try {
    // LPUSH returns the new length, so the trim can be conditional instead of
    // unconditional -- it ran on every single write to enforce a bound that
    // moves once every AUDIT_TRIM_SLACK rows (S#281). Same ceiling, ~1/500th of
    // the commands. The list is allowed to overshoot by the slack and is then
    // cut back to AUDIT_LOG_MAX, so the promise "at most MAX + slack rows"
    // replaces "at most MAX rows" -- a bound either way, and the storage
    // difference is a few hundred kilobytes.
    const len = await store.lpush(AUDIT_LOG, JSON.stringify(entry));
    if (typeof len === "number" && len > AUDIT_LOG_MAX + AUDIT_TRIM_SLACK) {
      await store.ltrim(AUDIT_LOG, 0, AUDIT_LOG_MAX - 1);
    }
  } catch {
    /* logging is best-effort by design */
  }
  // Separate try: the tally is the half that answers "did they come back", so a
  // failure in the rolling log must not take it down with it.
  if (!entry.roomId) return;
  try {
    const day = entry.ts.slice(0, 10);
    const prev = await readRoomActivity(store, entry.roomId);
    const days = prev?.days ?? [];
    // `firstAt` and `lastAt` are a MINIMUM and a MAXIMUM, not "the first write"
    // and "the latest write". Caught S#280 by backdating a row in a check: an
    // out-of-order entry drove `lastAt` BACKWARDS, so a room's "last used" could
    // report earlier than its real last use. In production rows arrive in order
    // and this is unreachable -- which is exactly why it would have survived,
    // and why the operator table built on it would have been quietly wrong.
    const next: RoomActivity = {
      calls: (prev?.calls ?? 0) + 1,
      firstAt: prev && prev.firstAt < entry.ts ? prev.firstAt : entry.ts,
      lastAt: prev && prev.lastAt > entry.ts ? prev.lastAt : entry.ts,
      // Sorted, then capped from the OLD end. Appending blindly and slicing the
      // tail would drop the newest day rather than the oldest as soon as one
      // row arrived out of order.
      days: days.includes(day)
        ? days
        : [...days, day].sort().slice(-ROOM_ACTIVITY_DAYS_MAX),
    };
    // Expires WITH the room it describes, so a finished room takes its own
    // bookkeeping with it rather than leaving a tombstone behind. One command.
    await store.setex(ROOM_ACTIVITY_KEY(entry.roomId), ROOM_TTL_SECONDS, JSON.stringify(next));
  } catch {
    /* best-effort, exactly like the line above it */
  }
}
