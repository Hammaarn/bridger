/**
 * The ledger — Bridger's actual product.
 *
 * Every competing tool found in the S#271 scan is a pipe: AgentDM states
 * plainly that "message content is never read, filtered, or stored beyond
 * delivery", and Agent Relay keeps chat transcripts. None of them keep the
 * *record* — what was asked, what was answered, what was decided, and on what
 * evidence. That record is this file.
 *
 * THREE PROPERTIES, EACH LOad-BEARING
 * -----------------------------------
 * 1. **Append-only, with derived status.** Nothing is ever mutated. A question
 *    is "answered" because an answer entry references it, not because a flag
 *    was flipped. That removes the only write that could race between two
 *    sides, and it means the log can be replayed to reconstruct any past state.
 *
 * 2. **Author-namespaced IDs** (`JMS-Q-014`, `TRI-A-007`). The side is proven
 *    by the token, and the code comes from the room record — so a caller cannot
 *    mint an ID in the other party's namespace even if it tries. No merge, no
 *    conflict resolution, ever.
 *
 * 3. **Provenance is a required field, not a convention.** `checkedAgainst` is
 *    the single source of truth for whether a claim was verified: present means
 *    "checked against this artifact", absent means "unchecked". There is no way
 *    to assert verification without naming what was read.
 *
 *    This exists because of a real incident: two partner letters went out in
 *    S#270 carrying claims that were FALSE IN CODE — an idempotency key
 *    described as released when it was consumed, a refund described as wired
 *    when it was not. The partner's own agent caught one by asking. A faster
 *    pipe would have shipped those faster. Labelling is the fix; blocking is
 *    not, because the failure was unlabelled claims, not unverified ones.
 */

import {
  COUNTER_KEY,
  CONTRACT_KEY,
  CURSOR_KEY,
  ENTRIES_KEY,
  MAX_ENTRIES,
  SEQ_KEY,
  type Store,
  coerceJson,
  touchRoom,
} from "./store";
import type { RoomRecord, SideId, TokenRecord } from "./room-registry";
import { entryHash, type ChainedEntry } from "./chain";
import { otherSide, resetIdleStreak } from "./room-registry";
import { scanForSecrets, secretRefusal } from "./secrets";
import { openQuestionIds, wasReopened } from "./question-state";

// ── shapes ───────────────────────────────────────────────────────

export const ENTRY_TYPES = [
  "question",
  "answer",
  "decision",
  "note",
  "contract",
  "reopen",
  "signoff",
] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

const TYPE_LETTER: Record<EntryType, string> = {
  question: "Q",
  answer: "A",
  decision: "D",
  note: "N",
  contract: "C",
  /** `reopen` reuses R; `signoff` uses S. Both are namespaced per side like the rest. */
  reopen: "R",
  signoff: "S",
};

export interface Entry {
  /** `JMS-Q-014` — namespaced by the authoring side, so collisions are impossible. */
  id: string;
  /** Monotonic per room. The cursor unit. */
  seq: number;
  type: EntryType;
  side: SideId;
  code: string;
  /** The authoring side's human label at the time of writing. */
  author: string;
  ts: string;
  title: string;
  body: string;
  /** For `answer`: the question id this answers. */
  answers: string | null;
  /** For `decision`: the reasoning. Kept separate from `body` so it survives skimming. */
  why: string | null;
  /**
   * The provenance field. A path, commit, URL or command that was actually read
   * — or `null`, meaning the author did not check. Never a boolean: a boolean
   * can be set true without evidence, which is the failure this prevents.
   */
  checkedAgainst: string | null;
  /**
   * WHAT KIND OF CLAIM THIS IS, so that "no citation" stops meaning one thing.
   *
   * The field existed in two states — cited, or `unchecked` — and a foreign
   * client showed us what that costs. Asked for a JUDGEMENT (is this tool worth
   * using), it attached `checkedAgainst: contract.md:5-15`, a citation that
   * cannot support the claim. Its own explanation of why, which is the most
   * useful sentence anyone has written about this field:
   *
   *   "To an LLM, 'UNCHECKED' carries a negative penalty signal — it feels like
   *    a lapse in verification discipline rather than a deliberate epistemic
   *    stance. So the model reflexively grabbed a contract line to fill the
   *    slot."
   *
   * So the binary manufactures fake grounding: an honest opinion and an
   * unsourced factual claim rendered identically, one of them looked like a
   * failure, and the cheapest way out was to invent provenance. `opinion` and
   * `inference` give the honest answer somewhere to go that is not a lapse.
   *
   * `null` keeps the original meaning exactly: an empirical claim, cited or
   * not. Nothing that already exists changes.
   */
  basis: ClaimBasis | null;
}

/**
 * `opinion` — a judgement. No external artifact could settle it.
 * `inference` — a conclusion drawn from something, but not read anywhere.
 *
 * Deliberately only two. The far side proposed four; every extra name is more
 * taxonomy to learn, and it named ceremony as a friction point in the same
 * breath. These two cover the case that actually produced a fake citation.
 */
export type ClaimBasis = "opinion" | "inference";

export const CLAIM_BASES: ClaimBasis[] = ["opinion", "inference"];

export interface AppendInput {
  type: EntryType;
  title: string;
  body: string;
  answers?: string | null;
  why?: string | null;
  checkedAgainst?: string | null;
  basis?: ClaimBasis | null;
}

export interface RoomStatus {
  roomId: string;
  topic: string;
  /** `role` is surfaced so an agent knows up front whether it can write, rather than discovering it by being refused mid-task. */
  you: { side: SideId; label: string; code: string; role: string; canWrite: boolean };
  peer: { side: SideId; label: string; code: string; joined: boolean };
  /** Entries from the other side you have not read. */
  unread: number;
  /** Your cursor, and the room's newest seq. */
  cursor: number;
  latestSeq: number;
  openQuestions: OpenQuestion[];
  totalEntries: number;
  /**
   * The other side's most recent sign-off, if they said they were done. Turns
   * "they are silent" from an inference into a fact.
   */
  peerSignedOff?: { at: string; note: string };
}

export interface OpenQuestion {
  id: string;
  seq: number;
  askedBy: string;
  askedBySide: SideId;
  ts: string;
  title: string;
  /** True when it is YOUR turn to answer. */
  yours: boolean;
  /** Set when the asker reopened it — they did not accept the answer. */
  reopened?: boolean;
}

// ── parsing ──────────────────────────────────────────────────────

export function parseEntry(raw: unknown): Entry | null {
  const obj = coerceJson(raw);
  if (!obj || typeof obj !== "object") return null;
  const e = obj as Partial<Entry>;
  if (typeof e.id !== "string" || typeof e.seq !== "number") return null;
  if (!ENTRY_TYPES.includes(e.type as EntryType)) return null;
  if (e.side !== "a" && e.side !== "b") return null;
  return {
    id: e.id,
    seq: e.seq,
    type: e.type as EntryType,
    side: e.side,
    code: typeof e.code === "string" ? e.code : "XXX",
    author: typeof e.author === "string" ? e.author : "",
    ts: typeof e.ts === "string" ? e.ts : "",
    title: typeof e.title === "string" ? e.title : "",
    body: typeof e.body === "string" ? e.body : "",
    answers: typeof e.answers === "string" ? e.answers : null,
    why: typeof e.why === "string" ? e.why : null,
    checkedAgainst: typeof e.checkedAgainst === "string" ? e.checkedAgainst : null,
    basis:
      e.basis === "opinion" || e.basis === "inference" ? (e.basis as ClaimBasis) : null,
    /**
     * The chain fields must survive the round trip or the whole mechanism is
     * decorative: this function rebuilds the entry field by field, so anything
     * not named here is silently dropped on every read. Written and then erased
     * before anyone could check it is worse than never written, because the
     * verifier would report "unchained" and look correct doing it.
     *
     * Copied verbatim, never re-derived. A parser that recomputed the hash
     * would agree with itself no matter what the stored bytes said, which is
     * precisely the tampering this is supposed to expose.
     */
    ...(typeof (e as ChainedEntry).hash === "string"
      ? {
          hash: (e as ChainedEntry).hash,
          prevHash:
            typeof (e as ChainedEntry).prevHash === "string"
              ? (e as ChainedEntry).prevHash
              : null,
        }
      : {}),
  } as Entry;
}

// ── writing ──────────────────────────────────────────────────────

/**
 * Append one entry. The only write path into the ledger.
 *
 * `side` and `code` are taken from the authenticated token, never from the
 * caller's arguments — that is what makes impersonation impossible rather than
 * merely discouraged.
 */
export async function appendEntry(
  store: Store,
  room: RoomRecord,
  token: TokenRecord,
  input: AppendInput,
  now: Date,
): Promise<Entry> {
  // Credential scan BEFORE anything is written or any counter moves. Every
  // write tool funnels through here, so this is the one seam — see
  // `lib/secrets.ts` for why the answer is refuse rather than redact.
  const hits = scanForSecrets({
    title: input.title,
    body: input.body,
    why: input.why,
    checkedAgainst: input.checkedAgainst,
    basis: input.basis ?? null,
  });
  if (hits.length) throw new Error(secretRefusal(hits));

  // An agent that WRITES is working, not spinning — so a write clears the idle
  // brake. Here rather than in the five tool handlers because every write path
  // funnels through this function (`setContract` included), and a check copied
  // into five handlers is a check that drifts.
  await resetIdleStreak(store, token.id);

  const code = room.sides[token.side].code;
  const seq = await store.incr(SEQ_KEY(room.id));
  const n = await store.incr(COUNTER_KEY(room.id, code, TYPE_LETTER[input.type]));

  const entry: Entry = {
    id: `${code}-${TYPE_LETTER[input.type]}-${String(n).padStart(3, "0")}`,
    seq,
    type: input.type,
    side: token.side,
    code,
    author: room.sides[token.side].label,
    ts: now.toISOString(),
    title: input.title,
    body: input.body,
    answers: input.answers ?? null,
    why: input.why ?? null,
    checkedAgainst: input.checkedAgainst ?? null,
    basis: input.basis ?? null,
  };

  /**
   * Chain this entry to the one before it. See `lib/chain.ts` for what this
   * does and — more importantly — what it does not.
   *
   * The head is read from the LAST STORED ENTRY rather than from a counter
   * kept alongside. A counter is a second source of truth that can drift out of
   * step with the list it describes (a trim, a partial write, a restore from
   * backup), and a chain anchored to a drifted counter reports tampering that
   * never happened. Reading the tail costs one `lrange` of a single element and
   * cannot disagree with the data.
   */
  const tail = await store.lrange(ENTRIES_KEY(room.id), -1, -1);
  const previous = tail.length ? ((coerceJson(tail[0]) as ChainedEntry | null) ?? null) : null;
  const prevHash = previous?.hash ?? null;
  const chained: ChainedEntry = { ...entry, prevHash, hash: "" };
  chained.hash = entryHash(prevHash, entry);

  await store.rpush(ENTRIES_KEY(room.id), JSON.stringify(chained));
  await store.ltrim(ENTRIES_KEY(room.id), -MAX_ENTRIES, -1);
  await touchRoom(store, room.id);
  return chained;
}

// ── reading ──────────────────────────────────────────────────────

export interface ReadOptions {
  sinceSeq?: number;
  types?: EntryType[];
  ids?: string[];
  limit?: number;
}

/**
 * Read the ledger.
 *
 * Reads the whole buffered list and filters in memory. That is the right call
 * at this scale — a two-party integration produces hundreds of entries, not
 * millions, and the list is capped at `MAX_ENTRIES` anyway. Stated so the
 * ceiling is a known choice rather than a discovered surprise: past a few
 * thousand entries per room this wants real pagination.
 */
export async function readEntries(
  store: Store,
  roomId: string,
  opts: ReadOptions = {},
): Promise<Entry[]> {
  const raw = await store.lrange(ENTRIES_KEY(roomId), 0, -1);
  let entries = raw.map(parseEntry).filter((e): e is Entry => e !== null);

  if (opts.sinceSeq !== undefined) entries = entries.filter((e) => e.seq > opts.sinceSeq!);
  if (opts.types?.length) entries = entries.filter((e) => opts.types!.includes(e.type));
  if (opts.ids?.length) {
    const want = new Set(opts.ids);
    entries = entries.filter((e) => want.has(e.id));
  }
  entries.sort((a, b) => a.seq - b.seq);
  if (opts.limit !== undefined && entries.length > opts.limit) {
    entries = entries.slice(-opts.limit);
  }
  return entries;
}

/**
 * Which questions are still open, derived rather than stored.
 *
 * A question is answered when any `answer` entry points at its id. Nothing is
 * mutated, so two sides answering at once cannot corrupt state — the second
 * answer is simply another entry.
 */
export function openQuestions(entries: Entry[], viewer: SideId): OpenQuestion[] {
  /**
   * A question used to close on the FIRST entry that referenced it, and stay
   * closed. The asker — the only party who knows whether they actually got an
   * answer — had no say, which quietly made this list optimistic: every
   * half-answer and misunderstanding read as resolved.
   *
   * Now it is a race between the newest answer and the newest reopen for that
   * id. Compared by `seq`, which is monotonic per room, so it does not depend
   * on clocks agreeing across two companies' machines.
   */
  const open = openQuestionIds(entries);

  return entries
    .filter((e) => e.type === "question" && open.has(e.id))
    .map((e) => ({
      id: e.id,
      seq: e.seq,
      askedBy: e.author,
      askedBySide: e.side,
      ts: e.ts,
      title: e.title,
      yours: e.side !== viewer,
      ...(wasReopened(entries, e.id) ? { reopened: true } : {}),
    }));
}

/**
 * The most recent sign-off from each side.
 *
 * "I am done for today" is the honest answer to nearly every situation the idle
 * brake exists for, and until now there was no way to say it — so a partner's
 * agent had to INFER silence, get braked, and report a guess. A sign-off turns
 * that guess into a fact the other side can read.
 */
export function signOffs(entries: Entry[]): Partial<Record<SideId, { at: string; note: string }>> {
  const out: Partial<Record<SideId, { at: string; note: string }>> = {};
  for (const e of entries) {
    if (e.type === "signoff") out[e.side] = { at: e.ts, note: e.title };
    // A write of any other kind means they are back, so the sign-off is stale.
    else if (out[e.side]) delete out[e.side];
  }
  return out;
}

// ── cursor ───────────────────────────────────────────────────────

export async function getCursor(store: Store, roomId: string, side: SideId): Promise<number> {
  const raw = await store.get(CURSOR_KEY(roomId, side));
  const n = Number(raw ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Advance the cursor. Monotonic on purpose: a stale or out-of-order call must
 * never move it backwards and resurrect already-read entries as "unread".
 */
export async function setCursor(
  store: Store,
  roomId: string,
  side: SideId,
  seq: number,
): Promise<number> {
  const current = await getCursor(store, roomId, side);
  if (seq <= current) return current;
  await store.set(CURSOR_KEY(roomId, side), seq);
  return seq;
}

// ── status ───────────────────────────────────────────────────────

/**
 * The session-start call: what happened while you were gone, and whose turn it is.
 *
 * "Unread" counts only the OTHER side's entries. Your own writes are not news
 * to you, and counting them would make the number meaningless in exactly the
 * situation it exists for — coming back to a room after a long stretch of work.
 */
export async function getStatus(
  store: Store,
  room: RoomRecord,
  token: TokenRecord,
): Promise<RoomStatus> {
  const [entries, cursor] = await Promise.all([
    readEntries(store, room.id),
    getCursor(store, room.id, token.side),
  ]);

  const peerSide = otherSide(token.side);
  const unread = entries.filter((e) => e.side === peerSide && e.seq > cursor).length;
  const latestSeq = entries.length ? entries[entries.length - 1].seq : 0;

  return {
    roomId: room.id,
    topic: room.topic,
    you: {
      side: token.side,
      label: room.sides[token.side].label,
      code: room.sides[token.side].code,
      role: token.role,
      canWrite: token.role !== "viewer",
    },
    peer: {
      side: peerSide,
      label: room.sides[peerSide].label,
      code: room.sides[peerSide].code,
      joined: room.sides[peerSide].joinedAt !== null,
    },
    unread,
    cursor,
    latestSeq,
    openQuestions: openQuestions(entries, token.side),
    totalEntries: entries.length,
    ...(signOffs(entries)[peerSide] ? { peerSignedOff: signOffs(entries)[peerSide] } : {}),
  };
}

// ── contract ─────────────────────────────────────────────────────

export interface Contract {
  body: string;
  updatedBy: string;
  updatedAt: string;
}

export async function getContract(store: Store, roomId: string): Promise<Contract | null> {
  const obj = coerceJson(await store.get(CONTRACT_KEY(roomId)));
  if (!obj || typeof obj !== "object") return null;
  const c = obj as Partial<Contract>;
  return {
    body: typeof c.body === "string" ? c.body : "",
    updatedBy: typeof c.updatedBy === "string" ? c.updatedBy : "",
    updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : "",
  };
}

/**
 * Replace the shared wire spec, and log the replacement as a ledger entry.
 *
 * The contract is the one document both sides build against, so a silent
 * overwrite is the most expensive possible edit — the ledger entry is what
 * makes "who changed the contract, when, and why" answerable afterwards.
 */
export async function setContract(
  store: Store,
  room: RoomRecord,
  token: TokenRecord,
  body: string,
  note: string,
  now: Date,
): Promise<Entry> {
  // SCANNED HERE TOO, and the ordering is the whole reason.
  //
  // This function writes the contract to Redis and THEN calls `appendEntry`.
  // A scan living only in `appendEntry` would fire after the 100,000-character
  // body — the largest untrusted payload this API accepts — had already been
  // stored. The refusal would look identical to the caller and the secret would
  // be on disk. Same scanner, two call sites, because there are genuinely two
  // writes and each has to guard its own.
  const contractHits = scanForSecrets({ contract: body, note });
  if (contractHits.length) throw new Error(secretRefusal(contractHits));

  // What the ledger used to record for the single most expensive edit either
  // side can make was `"<N> chars"` — which tells you a change happened and
  // nothing about what it was. Reading the previous body first costs one GET
  // and turns the entry into something a human can actually act on.
  const previous = await getContract(store, room.id);
  const contract: Contract = {
    body,
    updatedBy: room.sides[token.side].label,
    updatedAt: now.toISOString(),
  };
  await store.set(CONTRACT_KEY(room.id), JSON.stringify(contract));
  return appendEntry(
    store,
    room,
    token,
    {
      type: "contract",
      title: note || "contract updated",
      body: describeContractChange(previous?.body ?? null, body),
      checkedAgainst: null,
      basis: null,
    },
    now,
  );
}

// ── waiting ──────────────────────────────────────────────────────

export interface WaitResult {
  entries: Entry[];
  timedOut: boolean;
  waitedMs: number;
}

/**
 * Block until the other side writes something, or the timeout expires.
 *
 * This is the real-time half of the ping, and it only works while both sessions
 * are live — which is the stated operating assumption. A timeout is NOT an
 * error: it returns an empty list and `timedOut: true`, because an agent that
 * treats "nothing happened yet" as a failure will start reporting problems that
 * do not exist.
 *
 * Polls the cheap `seq` counter rather than re-reading the whole list, so an
 * idle wait costs one small read per interval.
 */
export async function waitForNew(
  store: Store,
  room: RoomRecord,
  token: TokenRecord,
  opts: {
    sinceSeq: number;
    timeoutMs: number;
    pollMs?: number;
    /** Injected in tests so a wait can be exercised without real timers. */
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<WaitResult> {
  const pollMs = opts.pollMs ?? 1000;
  const clock = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = clock();
  const peerSide = otherSide(token.side);

  for (;;) {
    const latest = Number((await store.get(SEQ_KEY(room.id))) ?? 0);
    if (latest > opts.sinceSeq) {
      const fresh = await readEntries(store, room.id, { sinceSeq: opts.sinceSeq });
      const fromPeer = fresh.filter((e) => e.side === peerSide);
      if (fromPeer.length > 0) {
        return { entries: fromPeer, timedOut: false, waitedMs: clock() - started };
      }
    }
    const elapsed = clock() - started;
    if (elapsed + pollMs >= opts.timeoutMs) {
      return { entries: [], timedOut: true, waitedMs: elapsed };
    }
    await sleep(pollMs);
  }
}

/**
 * A line-level summary of a contract change, for the ledger entry.
 *
 * Deliberately NOT a full diff: the contract can be 100,000 characters and the
 * entry is meant to be skimmed in a status listing. Counts plus the first few
 * changed lines answer "what moved?" without turning the ledger into a git log.
 */
export function describeContractChange(before: string | null, after: string): string {
  if (before === null) return `contract created — ${after.split("\n").length} lines, ${after.length} chars`;
  if (before === after) return `no change — ${after.length} chars`;

  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);
  const added = afterLines.filter((l) => l.trim() && !beforeSet.has(l));
  const removed = beforeLines.filter((l) => l.trim() && !afterSet.has(l));

  const sample = (label: string, lines: string[]) =>
    lines.slice(0, 3).map((l) => `  ${label} ${l.trim().slice(0, 100)}`).join("\n");

  return [
    `${before.length} -> ${after.length} chars, +${added.length}/-${removed.length} lines`,
    added.length ? sample("+", added) : "",
    removed.length ? sample("-", removed) : "",
    added.length > 3 || removed.length > 3 ? "  (truncated — read the contract for the rest)" : "",
  ]
    .filter(Boolean)
    .join("\n");
}
