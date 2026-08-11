/**
 * The narrow slice of Redis that Bridger needs.
 *
 * WHY AN INTERFACE AND NOT THE CLIENT
 * -----------------------------------
 * Every module takes this as a parameter instead of importing Upstash directly,
 * so the registry and the ledger are testable with an in-memory fake and no
 * network. This is lifted from `roastmydev/lib/external/key-registry.ts`, where
 * the same seam is what let the auth path be tested at all.
 *
 * KEY LAYOUT
 * ----------
 *   bridger:disabled                    kill switch (any truthy value stops the bridge)
 *   bridger:tok:<sha256>                TokenRecord   — the hash, never the token
 *   bridger:room:<roomId>               RoomRecord
 *   bridger:room:<roomId>:entries       LIST, rpush-appended; the index IS the seq
 *   bridger:room:<roomId>:cursor:<side> last seq this side has read
 *   bridger:room:<roomId>:contract      the shared wire spec (one document)
 *   bridger:rl:<tokenId>:<minute>       per-token rate-limit bucket
 *   bridger:audit                       capped audit list
 *
 * RETENTION, STATED PRECISELY
 * ---------------------------
 * Redis cannot expire individual members of a list, so retention is an
 * **idle TTL on the room**: every write refreshes it, and a room with no
 * activity for `ROOM_TTL_SECONDS` disappears with its entries. That is not
 * "each entry lives 30 days" — an active room keeps its whole history, and a
 * dead one is fully collected. It is the better behaviour for the use case,
 * but it IS a different rule than per-entry expiry, so it is written down here
 * rather than left to be discovered.
 *
 * Local `bridger/` folders are the permanent record. The server is a buffer.
 */

export interface Store {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  /** Append. The resulting index is the entry's sequence number. */
  rpush(key: string, ...values: unknown[]): Promise<number>;
  lpush(key: string, ...values: unknown[]): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<unknown[]>;
  llen(key: string): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<unknown>;
  srem(key: string, ...members: string[]): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
}

// ── key builders ─────────────────────────────────────────────────

const NS = "bridger";

export const KILL_SWITCH = `${NS}:disabled`;
export const AUDIT_LOG = `${NS}:audit`;
export const TOKEN_KEY = (hash: string) => `${NS}:tok:${hash}`;
export const ROOM_KEY = (roomId: string) => `${NS}:room:${roomId}`;
export const ENTRIES_KEY = (roomId: string) => `${NS}:room:${roomId}:entries`;
export const CURSOR_KEY = (roomId: string, side: string) => `${NS}:room:${roomId}:cursor:${side}`;
export const CONTRACT_KEY = (roomId: string) => `${NS}:room:${roomId}:contract`;
export const ROOM_TOKENS_KEY = (roomId: string) => `${NS}:room:${roomId}:tokens`;
export const RATE_KEY = (tokenId: string, minute: string) => `${NS}:rl:${tokenId}:${minute}`;
/**
 * Monotonic per-room sequence. Deliberately NOT the list index: the entries
 * list is trimmed at `MAX_ENTRIES`, which shifts indices, and a cursor that
 * silently re-read old entries after a trim would be worse than no cursor.
 */
export const SEQ_KEY = (roomId: string) => `${NS}:room:${roomId}:seq`;
/** Per-side, per-type counter behind human-readable IDs like `JMS-Q-014`. */
export const COUNTER_KEY = (roomId: string, code: string, letter: string) =>
  `${NS}:room:${roomId}:n:${code}:${letter}`;

/**
 * Server-side buffer ceiling. Local `bridger/` folders hold the permanent
 * record, so trimming the oldest entries here loses nothing that was pulled.
 */
export const MAX_ENTRIES = 5000;

/** Idle TTL. Refreshed on every write to the room. */
export const ROOM_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Audit entries retained — enough to answer "what happened last week", bounded. */
export const AUDIT_LOG_MAX = 1000;
/** Calls per token per minute. Generous for a human-paced integration, cheap as a runaway-loop stop. */
export const RATE_LIMIT_PER_MINUTE = 120;

export function minuteBucket(now: Date): string {
  return now.toISOString().slice(0, 16); // YYYY-MM-DDTHH:mm
}

/**
 * Upstash returns parsed objects for JSON values and raw strings otherwise.
 * Both shapes reach us, so every read goes through this.
 */
export function coerceJson(raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Refresh the room's idle TTL. Best-effort: a missed expire call means the room
 * lives longer than intended, which is never the dangerous direction.
 */
export async function touchRoom(store: Store, roomId: string): Promise<void> {
  try {
    await Promise.all([
      store.expire(ROOM_KEY(roomId), ROOM_TTL_SECONDS),
      store.expire(ENTRIES_KEY(roomId), ROOM_TTL_SECONDS),
      store.expire(CONTRACT_KEY(roomId), ROOM_TTL_SECONDS),
      store.expire(ROOM_TOKENS_KEY(roomId), ROOM_TTL_SECONDS),
    ]);
  } catch {
    /* best-effort by design */
  }
}

// ── the real client ──────────────────────────────────────────────

/**
 * Build the configured store, or `null` when there isn't one.
 *
 * Two backends, and the selection is explicit in both directions:
 *
 *  - `BRIDGER_STORE=file` → a local JSON file. For bridging two sessions on
 *    one machine, where a hosted database would be infrastructure for its own
 *    sake. Opt-in only.
 *  - Upstash credentials → Redis. The hosted, two-machine case.
 *
 * **A missing configuration returns `null` and never silently degrades to
 * files.** `null` is a first-class value here, not an error: the caller fails
 * CLOSED on it (see `authorize` in room-registry). A hosted deploy that quietly
 * fell back to per-instance local files would look healthy while every
 * serverless instance kept its own disappearing ledger — so the fallback does
 * not exist, and a bridge that cannot read its own token registry serves
 * nothing.
 */
export function createStore(): Store | null {
  if (process.env.BRIDGER_STORE === "file") {
    // Required lazily so the hosted path never loads the fs backend, and to
    // keep the module graph acyclic at runtime.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createFileStore } = require("./file-store") as typeof import("./file-store");
    return createFileStore();
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  // Imported lazily so unit tests never load the client or touch the network.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Redis } = require("@upstash/redis") as typeof import("@upstash/redis");
  const redis = new Redis({ url, token });

  return {
    get: (k) => redis.get(k),
    set: (k, v) => redis.set(k, v),
    // Upstash types `del` as a non-empty tuple, but the Redis command itself is
    // genuinely variadic. Narrow cast for that one signature; deleting nothing
    // short-circuits so an empty call is a no-op rather than a runtime error.
    del: async (...k) =>
      k.length === 0 ? 0 : (redis.del as unknown as (...keys: string[]) => Promise<number>)(...k),
    incr: (k) => redis.incr(k),
    expire: (k, s) => redis.expire(k, s),
    rpush: (k, ...v) => redis.rpush(k, ...v),
    lpush: (k, ...v) => redis.lpush(k, ...v),
    ltrim: (k, s, e) => redis.ltrim(k, s, e),
    lrange: (k, s, e) => redis.lrange(k, s, e),
    llen: (k) => redis.llen(k),
    // Same tuple-typing quirk as `del`: SADD requires >=1 member in the types,
    // and is variadic in the protocol.
    sadd: async (k, ...m) =>
      m.length === 0
        ? 0
        : (redis.sadd as unknown as (key: string, ...members: string[]) => Promise<number>)(k, ...m),
    srem: (k, ...m) => redis.srem(k, ...m),
    smembers: (k) => redis.smembers(k),
  };
}
