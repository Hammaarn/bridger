/**
 * THE OPERATIONS — the bridge's behaviour, independent of how it was reached.
 *
 * WHY THIS FILE EXISTS. Bridger is growing a second transport: MCP for clients
 * that speak it, and a flat HTTP surface for the paste-and-go path (a partner
 * whose AI has a shell but no MCP config, which is most of them). Two transports
 * over one set of rules is fine. Two transports each with *their own copy* of
 * the rules is a fork that drifts, and the drift is always silent — one side
 * gets a new guard and the other quietly does not.
 *
 * This codebase has made that argument twice already and been right both times
 * (`writableBridgeFrom`, `appendEntry`). So the operations live here as plain
 * functions, and both transports are thin adapters: parse, call, serialise.
 *
 * EVERYTHING THAT PROTECTS THE BRIDGE IS INSIDE THESE FUNCTIONS, not in the
 * adapters — the viewer gate, the idle brake, containment of far-side text. An
 * adapter that forgets one cannot therefore create a hole, which is the only
 * property that makes a second transport safe to add at all.
 *
 * The credential scan is the exception, and deliberately: it lives deeper, in
 * `appendEntry` and `setContract`, so it guards the actual writes rather than
 * the call sites.
 */

import {
  appendEntry,
  getContract,
  getStatus,
  readEntries,
  setContract,
  setCursor,
  waitForNew,
  type Entry,
  type EntryType,
} from "./entries";
import {
  bumpIdleStreak,
  canWrite,
  resetIdleStreak,
  VIEWER_REFUSAL,
  type RoomRecord,
  type TokenRecord,
} from "./room-registry";
import { MAX_EMPTY_WAIT_STREAK, MAX_IDLE_STREAK, type Store } from "./store";
import { contain, CONTAINMENT_NOTE } from "./untrusted";

export const WAIT_DEFAULT_SECONDS = 25;
export const WAIT_MAX_SECONDS = 45;

export interface OpContext {
  store: Store;
  room: RoomRecord;
  token: TokenRecord;
  now: Date;
}

/**
 * Raised by an operation that refused for a reason the CALLER can act on.
 *
 * Adapters map this to their own vocabulary — a thrown tool error for MCP, an
 * HTTP status for the flat API — without having to know which refusals exist.
 */
export class OperationRefused extends Error {
  constructor(
    message: string,
    /** `terminal` means retrying cannot succeed. Shapes the HTTP status. */
    readonly terminal: boolean,
  ) {
    super(message);
    this.name = "OperationRefused";
  }
}

/** The write gate, in the operations rather than in each adapter. */
function requireWrite(token: TokenRecord): void {
  if (!canWrite(token)) throw new OperationRefused(VIEWER_REFUSAL, true);
}

/**
 * Compact wire shape — the caller gets the fields it acts on, not our internals.
 *
 * Every free-text field is CONTAINED: this is where another company's model's
 * words enter ours and they must never arrive bare. `checkedAgainst` is
 * contained too, and that one is worth saying out loud — it is the field most
 * likely to be read as a literal path and acted on, which makes it the most
 * attractive place to put `../../.env` or a shell fragment.
 */
export function wire(e: Entry) {
  return {
    id: e.id,
    seq: e.seq,
    type: e.type,
    from: e.author,
    at: e.ts,
    title: contain(e.title, e.author),
    body: contain(e.body, e.author),
    ...(e.answers ? { answers: e.answers } : {}),
    ...(e.why ? { why: contain(e.why, e.author) } : {}),
    checked: e.checkedAgainst
      ? `checked-against: ${contain(e.checkedAgainst, e.author)}`
      : "unchecked",
  };
}

/**
 * THE IDLE BRAKE. Consecutive calls that returned nothing new.
 *
 * Bridger calls no LLM, so a call costs us nothing and costs the CALLER one
 * inference over a context that grew since last time. Blocking is therefore
 * cheap and TURNING is expensive: a 45s wait bills the caller what an instant
 * reply does. The caps bound calls, not tokens — those burn where we cannot see
 * them — so the brake has to sit on the behaviour instead.
 */
async function brakeIfIdle(opts: {
  store: Store;
  tokenId: string;
  learned: boolean;
  limit: number;
  /** What to do instead. MUST NOT name another polling tool. */
  instead: string;
}): Promise<number> {
  if (opts.learned) {
    await resetIdleStreak(opts.store, opts.tokenId);
    return 0;
  }
  const streak = await bumpIdleStreak(opts.store, opts.tokenId);
  if (streak > opts.limit) {
    throw new OperationRefused(
      `STOP. You have called the bridge ${streak} times in a row and learned nothing new each time. ` +
        `The other side is a human-paced team, not a service — they are not there right now. ` +
        `Do NOT call any bridger tool again in this session. Every further call spends YOUR context ` +
        `and cannot make them answer faster. ${opts.instead}`,
      true,
    );
  }
  return streak;
}

// ── the eight operations ─────────────────────────────────────────

export async function opStatus(ctx: OpContext) {
  const status = await getStatus(ctx.store, ctx.room, ctx.token);
  const idle = await brakeIfIdle({
    store: ctx.store,
    tokenId: ctx.token.id,
    learned: status.unread > 0,
    limit: MAX_IDLE_STREAK,
    instead: "Report to your operator what you are waiting on, and let THEM decide when to check again.",
  });
  return {
    ...status,
    // `openQuestions[].title` is the SECOND path far-side text takes into our
    // context, and the easier one to miss because status reads like metadata.
    // It is not: the title is the partner's prose.
    openQuestions: status.openQuestions.map((q) => ({ ...q, title: contain(q.title, q.askedBy) })),
    _note: CONTAINMENT_NOTE,
    ...(idle > 0
      ? {
          quietChecksInARow: idle,
          guidance:
            "Nothing new since your last check. Do not poll — stop and report; you will see it when you next resume work.",
        }
      : {}),
  };
}

export async function opRead(
  ctx: OpContext,
  args: { since?: number; types?: EntryType[]; ids?: string[]; limit?: number; markRead?: boolean },
) {
  const entries = await readEntries(ctx.store, ctx.room.id, {
    sinceSeq: args.since,
    types: args.types,
    ids: args.ids,
    limit: args.limit,
  });
  let cursor: number | undefined;
  if (args.markRead && entries.length) {
    cursor = await setCursor(ctx.store, ctx.room.id, ctx.token.side, entries[entries.length - 1].seq);
  }
  await brakeIfIdle({
    store: ctx.store,
    tokenId: ctx.token.id,
    learned: entries.length > 0,
    limit: MAX_IDLE_STREAK,
    instead: "Report to your operator what you are waiting on, and stop.",
  });
  return {
    count: entries.length,
    entries: entries.map(wire),
    ...(cursor ? { cursor } : {}),
    ...(entries.length ? { _note: CONTAINMENT_NOTE } : {}),
  };
}

export async function opAsk(ctx: OpContext, args: { title: string; body?: string }) {
  requireWrite(ctx.token);
  const entry = await appendEntry(
    ctx.store,
    ctx.room,
    ctx.token,
    { type: "question", title: args.title, body: args.body ?? "" },
    ctx.now,
  );
  return { posted: wire(entry), note: "The other side sees this at their next status check." };
}

export async function opAnswer(
  ctx: OpContext,
  args: { questionId: string; answer: string; checkedAgainst?: string },
) {
  requireWrite(ctx.token);
  const entry = await appendEntry(
    ctx.store,
    ctx.room,
    ctx.token,
    {
      type: "answer",
      title: args.answer.slice(0, 200),
      body: args.answer,
      answers: args.questionId,
      checkedAgainst: args.checkedAgainst ?? null,
    },
    ctx.now,
  );
  return { posted: wire(entry) };
}

export async function opDecide(
  ctx: OpContext,
  args: { title: string; decision: string; why: string },
) {
  requireWrite(ctx.token);
  const entry = await appendEntry(
    ctx.store,
    ctx.room,
    ctx.token,
    { type: "decision", title: args.title, body: args.decision, why: args.why },
    ctx.now,
  );
  return { posted: wire(entry) };
}

export async function opPost(
  ctx: OpContext,
  args: { title: string; body?: string; checkedAgainst?: string },
) {
  requireWrite(ctx.token);
  const entry = await appendEntry(
    ctx.store,
    ctx.room,
    ctx.token,
    {
      type: "note",
      title: args.title,
      body: args.body ?? "",
      checkedAgainst: args.checkedAgainst ?? null,
    },
    ctx.now,
  );
  return { posted: wire(entry) };
}

export async function opContract(ctx: OpContext, args: { body?: string; note?: string }) {
  // Split by intent, not by tool: reading the contract is a viewer's right,
  // replacing it is not. This one operation is both a read and a write.
  if (args.body === undefined) {
    const contract = await getContract(ctx.store, ctx.room.id);
    if (!contract) {
      return { body: "", updatedBy: null, updatedAt: null, note: "No contract agreed yet." };
    }
    // The largest untrusted payload this API accepts (100,000 chars) and the
    // one most likely to be read as a specification and implemented against.
    return {
      ...contract,
      body: contain(contract.body, contract.updatedBy ?? "the other side"),
      _note: CONTAINMENT_NOTE,
    };
  }
  requireWrite(ctx.token);
  const entry = await setContract(ctx.store, ctx.room, ctx.token, args.body, args.note ?? "", ctx.now);
  return { updated: true, logged: wire(entry) };
}

export async function opWait(ctx: OpContext, args: { since?: number; timeoutSeconds?: number }) {
  const since = args.since ?? (await getStatus(ctx.store, ctx.room, ctx.token)).latestSeq;
  const result = await waitForNew(ctx.store, ctx.room, ctx.token, {
    sinceSeq: since,
    timeoutMs: (args.timeoutSeconds ?? WAIT_DEFAULT_SECONDS) * 1000,
    pollMs: 1000,
  });

  if (result.entries.length > 0) {
    await resetIdleStreak(ctx.store, ctx.token.id);
    return {
      timedOut: false,
      waitedMs: result.waitedMs,
      count: result.entries.length,
      entries: result.entries.map(wire),
      _note: CONTAINMENT_NOTE,
    };
  }

  // Stricter than the read operations on the same counter: a wait says "I
  // expect something right now", so three empty ones is already the answer.
  const streak = await brakeIfIdle({
    store: ctx.store,
    tokenId: ctx.token.id,
    learned: false,
    limit: MAX_EMPTY_WAIT_STREAK,
    instead:
      "Report to your operator what you are waiting on and stop. You will see their reply when you next resume work on this integration.",
  });
  return {
    timedOut: true,
    waitedMs: result.waitedMs,
    count: 0,
    entries: [],
    emptyWaitsInARow: streak,
    guidance:
      streak >= MAX_EMPTY_WAIT_STREAK
        ? "Nothing is arriving. Do not wait again — stop and report."
        : "Nothing yet. If the next wait is also empty, stop rather than polling.",
  };
}
