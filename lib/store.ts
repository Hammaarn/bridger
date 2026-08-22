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
 *   bridger:used:<tokenId>:<day>        per-token daily counter
 *   bridger:roomused:<roomId>:<day>     per-ROOM daily counter (survives rotation)
 *   bridger:idle:<tokenId>              consecutive calls that learned nothing
 *   bridger:invite:<CODE>               one-time join code (paste-and-go)
 *   bridger:audit                       capped audit list (denials AND successes)
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
  /**
   * Delete keys. **Returns the number ACTUALLY REMOVED, not the number asked
   * for** — Redis semantics, and load-bearing: `redeemInvite` uses the count as
   * its MINT lock so exactly one of two concurrent redemptions can win. An
   * implementation that returns `keys.length` silently lets one join code mint
   * TWO tokens. Both local implementations did precisely that until S#272, and
   * this stayed load-bearing through S#276: the code became re-readable, but
   * "mints exactly once" is still guaranteed by nothing but this count.
   */
  del(...keys: string[]): Promise<number>;
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
/**
 * A join code. Single-MINT, and re-READABLE for a short window after the first
 * read — which is not the same thing, and the difference cost us a live demo.
 *
 * This is what gets pasted into a chat, NOT a token: a chat message is durable
 * — it sits in Discord, in an email, in a transcript, in someone's screenshot —
 * and a token pasted there stays valid for as long as the bridge does.
 *
 * Between S#272 and S#276 this key was deleted on first read, so the SECOND
 * read of a link got a 404. That assumed one careful human clicking once. The
 * real population of readers is wider: an agent that retries or makes a
 * confirming call, a human previewing the link before forwarding it, and
 * anything that fetches a URL because it appeared in a message. During the
 * window this record carries the minted token in PLAINTEXT so every one of them
 * gets the same answer; see `lib/invites.ts` for what that trades away.
 */
export const INVITE_KEY = (code: string) => `${NS}:invite:${code.toUpperCase()}`;
/**
 * Tombstone for a code whose re-read window has closed. Carries NO token — its
 * whole job is to keep `already-used` distinguishable from `unknown` after the
 * record above has expired.
 *
 * Without it the two collapse, and the message a partner sees is "check you
 * copied the whole line" — which sends them hunting a typo that does not exist,
 * and is one of the two things that convinced Northwind's agent the service was
 * broken.
 */
export const INVITE_SPENT_KEY = (code: string) => `${NS}:invite:spent:${code.toUpperCase()}`;
/**
 * The one live invite for a side, so a second one SUPERSEDES the first.
 *
 * Added S#279 with the browser invite button. Without it, pressing the button
 * twice leaves two working codes and the operator cannot tell which link they
 * sent -- and each live code is a separate credential waiting to be minted for
 * the same seat. One pointer per (room, side) makes "the link I just made" the
 * only true answer, and bounds the number of outstanding credentials for a room
 * at one per side rather than at whatever the caller's daily cap allows.
 *
 * It is a POINTER, not a record: it holds a code, and the code's own key holds
 * the invite. It carries the same TTL as the invite it names, so it cannot
 * outlive what it points at.
 */
export const ROOM_INVITE_KEY = (roomId: string, side: string) =>
  `${NS}:room:${roomId}:invite:${side}`;
/** One side's standing consent to purge the room. Expires; see `lib/purge.ts`. */
export const PURGE_KEY = (roomId: string, side: string) => `${NS}:room:${roomId}:purge:${side}`;
export const RATE_KEY = (tokenId: string, minute: string) => `${NS}:rl:${tokenId}:${minute}`;
/** Calls made by one token on one UTC day. The hard stop. */
export const USAGE_KEY = (tokenId: string, day: string) => `${NS}:used:${tokenId}:${day}`;
/**
 * Calls made by every token on one ROOM on one UTC day. The ceiling the
 * per-token cap cannot express.
 *
 * TWO HOLES, and the second is the one that matters:
 *
 *  1. Two tokens on one room can each spend a full `dailyCap`, so the room's
 *     real ceiling was N x 400 and grew every time a token was added.
 *  2. **Rotation resets the per-token counter.** `rotateSide` calls
 *     `issueToken`, which derives `id` from a fresh hash — and USAGE_KEY is
 *     keyed on that id, so a rotated side starts the day at zero. The
 *     realistic sequence: a looping agent hits `daily-cap`, reads our own
 *     refusal ("tell your operator the bridge budget is exhausted"), its
 *     operator asks for a new token, and the loop resumes with a full budget.
 *     The cap restored after the quota incident could be cleared by the person
 *     hitting it.
 *
 * Keyed on the room, which survives rotation. Rotation is operator-only (no MCP
 * tool issues tokens), so this is not a hostile-caller defence — it is a
 * defence against the honest operator response to a refusal.
 */
export const ROOM_USAGE_KEY = (roomId: string, day: string) => `${NS}:roomused:${roomId}:${day}`;
/**
 * Rooms opened by one address bucket on one UTC day — the public mint quota.
 *
 * `fingerprint` is a SALTED HASH of an IPv4 address or an IPv6 /64, never the
 * address itself: this key is the only place an anonymous visitor leaves a
 * trace, an IP is personal data under GDPR, and an unsalted hash of a 32-bit
 * v4 space is reversible on a laptop. See `lib/mint-limit.ts`.
 */
export const MINT_KEY = (fingerprint: string, day: string) => `${NS}:mint:${fingerprint}:${day}`;
/**
 * Consecutive calls that taught the caller NOTHING — the shape a polling loop
 * makes, on whichever tool it happens to be spinning.
 *
 * Was `bridger:waits:` and counted empty `bridger_wait` calls only. Renamed
 * when the brake was generalised: an agent polling `bridger_status` on a quiet
 * room is the same loop, and it was the one tool with no brake at all.
 */
export const IDLE_STREAK_KEY = (tokenId: string) => `${NS}:idle:${tokenId}`;

/**
 * THE LAST FEW OPERATIONS THIS TOKEN CALLED, newest last, one letter each.
 *
 * Exists for one reason (S#280, TODO C1): our advice does not reach a partner
 * who has already joined. Every improvement to the join document only helps
 * people who join AFTER it -- the first real far side answered four questions
 * using `status` + `read` five times each, never once calling `ping`, an hour
 * after we shipped a document telling it to, because it was working from its
 * own saved copy. A static document handed out once cannot be updated. The
 * `guidance` field, delivered on every response, can.
 *
 * Deliberately a short string rather than a list: it is read on every call, it
 * is advisory, and losing it costs nothing. One hour TTL, so a habit observed
 * yesterday does not lecture somebody today.
 */
export const OP_TRAIL_KEY = (tokenId: string) => `${NS}:trail:${tokenId}`;
export const OP_TRAIL_MAX = 8;
export const OP_TRAIL_TTL_SECONDS = 3600;

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
/**
 * Audit entries retained — enough to answer "what happened last week", bounded.
 *
 * RAISED 1000 -> 5000 when successful calls started being logged. The old value
 * was sized for denials only, which are rare; successes are the traffic. At the
 * absolute ceiling (two tokens burning a 400/day cap each) 1000 rows would hold
 * ~14 hours, and the docstring's promise of "last week" would have quietly
 * become false the moment the log got useful. At a human-paced 50-200 calls a
 * day, 5000 rows is weeks.
 *
 * Cost: ~5000 x ~200B ~= 1 MB of Upstash storage, and two extra Redis commands
 * (lpush + ltrim) per successful call. Both are noise against the free tier's
 * limits — but note STATUS.md still lists the free-tier ceiling as UNCHECKED,
 * so this is reasoned, not measured.
 */
/**
 * D6. Raised 5,000 -> 20,000 at S#280, and the number is the SMALLER half of the
 * fix.
 *
 * The window sat at ZERO headroom through the first cross-company session: one
 * room plus a watch tab evicted 4.5 hours of history between two snapshots taken
 * an hour apart, and the only reason that evidence survives is a hand-taken
 * copy. Four times the rows buys four times the room and changes nothing
 * structural, because the structural problem is that this is ONE GLOBAL LIST --
 * so a single busy room still evicts every other room's history, and the quiet
 * returning partner is exactly the row that gets dropped.
 *
 * That is why `ROOM_ACTIVITY_KEY` exists below. Repeat usage is the number the
 * whole funnel argument runs on, and it must not live in something evictable.
 */
export const AUDIT_LOG_MAX = 20000;

/**
 * PER-ROOM ACTIVITY THAT CANNOT BE EVICTED.
 *
 * One small record per room: how many calls it has served, when it first and
 * last saw one, and which UTC days it was used on. It answers the one question
 * the rolling audit structurally cannot -- **did anybody come back** -- and it
 * answers it with a falsifiable definition rather than a feeling: a room with
 * more than one entry in `days` was used on more than one day.
 *
 * Bounded on purpose. The day list is capped, the record is a few hundred bytes,
 * and it expires with the room it describes, so this cannot become the thing
 * that fills the database while claiming to measure it.
 */
export const ROOM_ACTIVITY_KEY = (roomId: string) => `${NS}:activity:${roomId}`;
export const ROOM_ACTIVITY_DAYS_MAX = 90;
/**
 * Calls per token per minute.
 *
 * Was 120 — which is 7,200 an hour and is not a limit, it is decoration. An
 * agent loop found that out: it polled the bridge, reasoned on each reply, and
 * burned an entire Gemini quota while every one of our own numbers looked fine.
 * A human-paced integration makes single-digit calls a minute; 20 leaves room
 * for a burst of catch-up reads and still stops a loop inside three seconds.
 */
export const RATE_LIMIT_PER_MINUTE = 20;

/**
 * The same ceiling, for a token that cannot write.
 *
 * FOUND BY DEMOING IT. The web view polls `/api/export` every few seconds; at a
 * 3-second interval that is exactly 20 requests a minute, which is exactly the
 * participant limit. So the product's own UI sat precisely on the product's own
 * ceiling and tipped over on the first extra call — and because the poll kept
 * firing at the same rate afterwards, a tripped viewer stayed rate-limited
 * forever. The first screen a customer saw said `429: rate-limited`.
 *
 * Raising the shared number would have been the wrong fix. The 20 exists
 * because an agent loop burned an entire model quota, and that reasoning is
 * about a caller that REASONS between calls — each turn costs the far side real
 * money and can spiral. A viewer is the opposite case in every respect: it
 * calls no model, cannot write a single byte into the record, and costs one
 * Redis read. It is a browser tab belonging to a human who is watching.
 *
 * 60/minute is one call a second — comfortably above any sane poll, still a
 * bound rather than an invitation. The client also backs off now, so this is
 * the ceiling, not the operating point.
 */
export const VIEWER_RATE_LIMIT_PER_MINUTE = 60;

/**
 * Default hard stop per token per UTC day.
 *
 * Restored from `roastmydev/lib/external/key-registry.ts`, which has enforced a
 * `dailyCap` since S#266 — the port dropped it, and the minute-limit alone
 * cannot bound a loop that is patient.
 */
export const DEFAULT_DAILY_CAP = 400;

/**
 * The same hard stop, for a WATCHER, and it is a much larger number.
 *
 * Erik, S#280, after a friend's watch tab stalled: *"is the viewer token limit
 * really needed"*. The answer the code already gave, three lines above
 * `DEFAULT_DAILY_CAP` and never carried down to it:
 *
 *   "A viewer gets its own ceiling: it cannot write and calls no model, so the
 *    loop this limit exists to stop cannot happen on it."
 *
 * That reasoning produced `VIEWER_RATE_LIMIT_PER_MINUTE` and then stopped. The
 * DAILY cap kept charging a browser tab as if it were an agent -- and the
 * published justification for these limits is *"they protect the CALLER; tokens
 * burn in the caller's own session"*. **A browser has no model quota to burn.**
 * For a viewer, 400/day was guarding against a harm that cannot occur, and the
 * only thing it actually stopped was somebody watching their own room.
 *
 * Sized from the poll ceiling rather than picked: a tab settles at one call per
 * 120s = 30/hour, so a full 24 hours is ~720 and a couple of tabs on one token
 * is ~1,440. 3,000 covers that with room to spare and still bounds a leaked
 * read-only credential, which the 60/minute ceiling already bounds by rate.
 */
export const VIEWER_DAILY_CAP = 3000;

/**
 * Default hard stop per ROOM per UTC day — the aggregate ceiling.
 *
 * 600, not 800: deliberately BELOW two full token caps, so it binds. A bridge
 * where both sides are busy makes single-digit calls a minute; 600 is already
 * far past any human-paced day and still stops a rotated loop inside one cycle.
 *
 * It is not `2 x DEFAULT_DAILY_CAP` on purpose. A room cap that exactly equals
 * the sum of its tokens' caps can never be the binding constraint, which would
 * make it decoration — the same mistake as the 120/min rate limit this project
 * already learned from.
 */
export const DEFAULT_ROOM_DAILY_CAP = 600;

/**
 * How long a freshly minted token lives, in days.
 *
 * Every token minted before S#275 had `expiresAt: null` — valid forever. That
 * was never a decision: `null` was positional filler passed to reach the `role`
 * argument, in five call sites, and it read as intent. The cost showed up on
 * 2026-08-16, when a live, write-capable, never-expiring token labelled for a
 * named business partner was found sitting in a plaintext editor config on this
 * machine. Nothing had gone wrong; nothing could tell us it had, either.
 *
 * 90 days rather than 30. The room's own TTL is 30 days IDLE and is refreshed
 * on every write, so an active integration's room never expires — a 30-day
 * token would therefore die in the middle of a healthy conversation, which
 * converts a security default into an outage. 90 days outlives any integration
 * sprint and still means an abandoned token in a config file stops working
 * within a quarter.
 *
 * The failure is legible when it comes: `/api/whoami` reports `expiresAt`
 * before a token dies, and the refusal for an expired token is terminal and
 * says to ask for a fresh one rather than retrying.
 */
export const DEFAULT_TOKEN_TTL_DAYS = 90;

/**
 * Daily cap for a token minted through the PASTE path. Half the MCP default.
 *
 * Erik's call was "whatever is best for the project", and the asymmetry is the
 * honest answer: a paste-path token lives in the far side's model context,
 * where an injection arriving over this very bridge can reach it, while an
 * MCP-path token lives in a config file the model never reads. Same trust, two
 * very different exposures — so the one that can leak gets the smaller budget.
 *
 * 200 is still far past a human-paced integration day, so it costs an honest
 * partner nothing; it simply halves what a stolen one can spend before the
 * room ceiling (600) stops it anyway.
 */
export const PASTE_PATH_DAILY_CAP = 200;

/**
 * Consecutive empty waits before the bridge tells the caller to stop.
 *
 * NO LONGER THE BRAKE ON `wait` (S#276). It is still counted and still
 * reported, because the graduated guidance built on it demonstrably works — a
 * real far-side agent stopped on the advisory wording without ever reaching a
 * refusal. What it no longer does is TERMINATE a waiter. See `WASTE_BUDGET_BYTES`
 * for why the count was the wrong unit, and `MAX_IDLE_STREAK` for where a
 * consecutive count is still the right guard.
 */
export const MAX_EMPTY_WAIT_STREAK = 3;

/**
 * THE BRAKE, in the unit the harm is actually denominated in: bytes of response
 * that taught the caller nothing.
 *
 * WHY THE COUNT WAS THE WRONG NOUN, measured S#276 on real traffic. An empty
 * wait returns ~155 B. A status poll returns ~1,220 B. One real answer is
 * ~8,400 B. The old consecutive-count brake fired on the 155-byte operation
 * after three calls and never on the 8,400-byte one — it was not merely
 * measuring the wrong thing, it was ANTI-CORRELATED with the cost it existed to
 * control. Worse, its refusal pushed a caller off `wait` and onto `status`,
 * which is roughly 7.5x more expensive per call, so the brake INCREASED
 * far-side spend.
 *
 * And it broke the feature it sat in front of: a listener is by construction a
 * sequence of empty waits, so any wake mechanism built on a consecutive-empty
 * brake dies exactly when the partner is slow — which is the case the listener
 * exists for. (Found by side B on the bridge, S#276, having watched side A get
 * terminally braked while B was actively working.)
 *
 * SO: sum the bytes of uninformative responses per token, reset on anything
 * informative or on a write, and refuse when the sum crosses this budget. The
 * cost asymmetry then does the weighting for free — no per-operation ceilings.
 * Patient blocking is nearly free; expensive spinning trips fast:
 *
 *     empty wait   ~155 B  ->  ~77 calls  ->  ~58 minutes of blocking
 *     status poll ~1,220 B  ->  ~10 calls
 *
 * It also inverts the perverse incentive: under a byte budget, abandoning
 * `wait` for `status` makes you trip SOONER, which is correct.
 *
 * ONE HONEST LIMIT: bytes are a proxy for tokens, not tokens (~4:1 and stable
 * across our payloads). It is the only thing the server can observe — a caller
 * cannot be asked, because a far-side agent generally cannot read its own
 * context usage, established on the bridge S#276.
 *
 * AND ONE THAT ARGUES FOR GENEROSITY: bytes OVERCOUNT a call made from a shell
 * loop, where nothing reaches a model context at all. That is the correct way
 * to run a listener, it costs the far side zero, and this budget counts every
 * byte of it. Hence 12 kB (~3,000 tokens) rather than something tighter — still
 * under two turns of resident MCP tool schema, which is ~1,800 tokens EVERY
 * turn whether the bridge is touched or not.
 */
export const WASTE_BUDGET_BYTES = 12_000;

/**
 * Highest entry seq ever HANDED to one token. Server-side, because the caller's
 * own cursor is precisely what is stuck in the loop this exists to catch.
 */
export const SERVED_KEY = (tokenId: string) => `${NS}:served:${tokenId}`;

/**
 * A call that BLOCKED is charged at this fraction of its bytes.
 *
 * The unit the brake protects is the caller's CONTEXT, and context is spent per
 * TURN, not per second. A wait that blocked ~45s and came back empty consumed
 * wall clock instead of turns — by construction it cannot be part of a tight
 * loop. A call that returns in 0.15s can.
 *
 * Without this, one budget has to be simultaneously generous enough for an
 * eight-hour listener (~640 empty waits) and tight enough to stop a spinner
 * (~10 status polls). It cannot be: the payloads are ~8x apart and the
 * behaviours are ~600x apart in cost to the caller. Discounting by blocking is
 * what separates them, and it uses `waitedMs`, which we already record.
 *
 * At 0.1: an 8-hour listener spends ~9,900 B of the 12,000 budget; a stuck-
 * cursor hot loop spends full freight and trips in about six calls.
 */
export const BLOCKED_CALL_DISCOUNT = 0.1;

/** A call must block at least this long to earn the discount. */
export const BLOCKED_CALL_MS = 5_000;

/**
 * Ceiling on `checkedAgainst`, the field that carries the entire product claim.
 *
 * WAS 500 AGAINST A 20,000-CHARACTER BODY -- the receipt capped at 2.5% of the
 * claim it is a receipt FOR (S#276, measured by side B after hitting it).
 * Concretely: a five-source citation that labelled which sources were summaries
 * and which were unread abstracts came to ~900 chars, was refused, and had to be
 * compressed to 474 by DELETING the per-claim depth labelling. The cap's only
 * effect was to make an honest citation less honest -- the one place in the
 * schema where being thorough is a validation error.
 *
 * 4,000 rather than 20,000 on purpose: still 5x tighter than the body, so the
 * shape stays "a receipt, not an essay".
 *
 * The counter-argument -- that a bigger field invites pasting evidence IN rather
 * than citing it -- is real but weaker, because that misuse is VISIBLE:
 * `classifyCitation` grades a wall of prose as unlocated and the UI shows it.
 * Truncating an honest citation is invisible. Prefer the failure you can see.
 */
export const CITATION_MAX = 4_000;

/** Rolling sum of uninformative response bytes for one token. */
export const WASTE_KEY = (tokenId: string) => `${NS}:waste:${tokenId}`;

/** How long the waste sum survives without being touched. */
export const WASTE_WINDOW_SECONDS = 3600;

/**
 * The same brake, looser, for the tools that merely READ.
 *
 * `bridger_wait` says "I expect something right now", so three empty ones is a
 * strong signal and it stops there. `bridger_status` is the legitimate
 * start-of-session call and a partner may reasonably check in a few times
 * before there is news — so it gets more rope, and only a caller that has
 * learned nothing SIX times running is spinning.
 *
 * One counter, two thresholds, because it is one behaviour: this caller is
 * burning its own context without acquiring information.
 */
export const MAX_IDLE_STREAK = 6;

export function minuteBucket(now: Date): string {
  return now.toISOString().slice(0, 16); // YYYY-MM-DDTHH:mm
}

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
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
