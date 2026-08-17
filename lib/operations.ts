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
  bumpWaste,
  peekWaste,
  resetWaste,
  canWrite,
  resetIdleStreak,
  VIEWER_REFUSAL,
  type RoomRecord,
  type TokenRecord,
} from "./room-registry";
import { MAX_EMPTY_WAIT_STREAK, MAX_IDLE_STREAK, WASTE_BUDGET_BYTES, type Store } from "./store";
import { classifyCitation, describeCitation } from "./citation";
import { contain, CONTAINMENT_NOTE } from "./untrusted";
import { recordPurgeConsent, withdrawPurgeConsent } from "./purge";

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
    // How specific that citation is, in OUR words. Derived by our own regex
    // from their string, so unlike `checked` it carries nothing far-side and
    // needs no containment — which is exactly why it is safe to read.
    //
    // It describes the CITATION, never the claim: "70 lines" says where they
    // pointed, not whether they were right. A reader weighing a peer's evidence
    // can see the difference between a pinpoint and a gesture, which is the
    // whole difference S#271 had to audit by hand.
    checkedSpan: describeCitation(classifyCitation(e.checkedAgainst)),
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
    await resetWaste(opts.store, opts.tokenId);
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

/**
 * A WRITE CLEARS THE DEBT — both counters.
 *
 * `bumpIdleStreak`'s own docstring has always claimed the streak "is reset by
 * ACQUIRING INFORMATION ... or by WRITING, because an agent that posts is doing
 * work rather than spinning." It was not: no write path reset anything, so the
 * documented behaviour and the real behaviour disagreed (S#276).
 *
 * It is not cosmetic. It contributed to the deadlock on the first live two-agent
 * run: side A posted the working contract while carrying a streak dirtied by
 * earlier empty waits, so its very next wait was already most of the way to a
 * refusal despite having just done the most productive thing available.
 */
async function noteProductive(ctx: OpContext): Promise<void> {
  await resetIdleStreak(ctx.store, ctx.token.id);
  await resetWaste(ctx.store, ctx.token.id);
}

/** What a braked reader should do instead. MUST NOT name another polling tool. */
const READ_INSTEAD =
  "Report to your operator what you are waiting on, and let THEM decide when to check again.";

/** What a braked waiter should do instead. MUST NOT name another polling tool. */
const WAIT_INSTEAD =
  "Report to your operator what you are waiting on and stop. You will see their reply when you next resume work on this integration.";

/**
 * THE BRAKE, in the unit the harm is denominated in: bytes we are about to
 * return that teach the caller nothing.
 *
 * See `WASTE_BUDGET_BYTES` for the full argument. The short version: the old
 * consecutive-count brake fired on the CHEAPEST operation after three calls and
 * never on the most expensive one, and its refusal pushed callers from `wait`
 * (~155 B) onto `status` (~1,220 B), so it actively increased far-side spend.
 * Charging bytes makes the cost asymmetry do the weighting for free.
 *
 * Called with the payload ALREADY BUILT, because the thing being charged for is
 * the response about to be sent, and guessing its size would reintroduce exactly
 * the estimation gap this replaces.
 */
async function chargeWaste(
  ctx: OpContext,
  payload: unknown,
  instead: string,
): Promise<number> {
  const bytes = JSON.stringify(payload ?? {}).length;
  const spent = await bumpWaste(ctx.store, ctx.token.id, bytes);
  if (spent > WASTE_BUDGET_BYTES) {
    throw new OperationRefused(
      `STOP. You have now spent ${spent} bytes of your own context on calls to this bridge that ` +
        `returned you nothing new, which is over the ${WASTE_BUDGET_BYTES}-byte budget for learning ` +
        `nothing. The other side is a human-paced team, not a service. Do NOT call any bridger tool ` +
        `again in this session — every further call spends YOUR context and cannot make them answer ` +
        `faster. ${instead}`,
      true,
    );
  }
  return spent;
}

/** Refuse an over-budget caller BEFORE doing the expensive part. */
async function refuseIfOverBudget(ctx: OpContext, instead: string): Promise<void> {
  if ((await peekWaste(ctx.store, ctx.token.id)) > WASTE_BUDGET_BYTES) {
    throw new OperationRefused(
      `STOP. You are over the ${WASTE_BUDGET_BYTES}-byte budget for calls that return nothing new, ` +
        `and this call would have returned nothing new either. Retrying cannot succeed. ${instead}`,
      true,
    );
  }
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
  const payload = {
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
  // Status is the EXPENSIVE way to learn nothing -- ~1,220 B against a wait's
  // ~155 B, measured S#276. Charging it by weight is what removes the perverse
  // incentive the old brake created, where being refused on `wait` pushed a
  // caller onto the operation that costs it 8x more.
  if (status.unread === 0) {
    const spent = await chargeWaste(ctx, payload, READ_INSTEAD);
    return { ...payload, wastedBytes: spent, wasteBudget: WASTE_BUDGET_BYTES };
  }
  return payload;
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
  const payload = {
    count: entries.length,
    entries: entries.map(wire),
    ...(cursor ? { cursor } : {}),
    ...(entries.length ? { _note: CONTAINMENT_NOTE } : {}),
  };
  if (entries.length === 0) {
    const spent = await chargeWaste(ctx, payload, READ_INSTEAD);
    return { ...payload, wastedBytes: spent, wasteBudget: WASTE_BUDGET_BYTES };
  }
  return payload;
}

export async function opAsk(ctx: OpContext, args: { title: string; body?: string }) {
  requireWrite(ctx.token);
  await noteProductive(ctx);
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
  await noteProductive(ctx);
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
  await noteProductive(ctx);
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
  await noteProductive(ctx);
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
  await noteProductive(ctx);
  const entry = await setContract(ctx.store, ctx.room, ctx.token, args.body, args.note ?? "", ctx.now);
  return { updated: true, logged: wire(entry) };
}

/**
 * Reopen a question the asker does not consider answered.
 *
 * Guarded to the ASKER's side on purpose: reopening is a statement about
 * whether YOUR question was answered, and letting the answering side reopen its
 * own answer would make the signal meaningless.
 */
export async function opReopen(ctx: OpContext, args: { questionId: string; why: string }) {
  requireWrite(ctx.token);
  await noteProductive(ctx);
  const entries = await readEntries(ctx.store, ctx.room.id, { ids: [args.questionId] });
  const question = entries.find((e) => e.id === args.questionId && e.type === "question");
  if (!question) {
    throw new OperationRefused(
      `No question ${args.questionId} on this bridge. Check the id from bridger_status.`,
      false,
    );
  }
  if (question.side !== ctx.token.side) {
    throw new OperationRefused(
      `${args.questionId} is THEIR question, not yours. Only the side that asked can say an answer ` +
        `did not resolve it — otherwise the signal means nothing. If you disagree with an answer to ` +
        `their question, post a note or ask a new question.`,
      true,
    );
  }
  const entry = await appendEntry(
    ctx.store,
    ctx.room,
    ctx.token,
    { type: "reopen", title: args.why, body: args.why, answers: args.questionId },
    ctx.now,
  );
  return {
    posted: wire(entry),
    reopened: args.questionId,
    note: "It is back on their open-questions list, marked as reopened.",
  };
}

/**
 * Say you are done for now, so the other side stops guessing.
 *
 * Any subsequent write clears it automatically — being back IS the signal, and
 * a sign-off you have to remember to cancel is one that will be wrong.
 */
export async function opSignoff(ctx: OpContext, args: { note?: string }) {
  requireWrite(ctx.token);
  await noteProductive(ctx);
  const text = args.note?.trim() || "Signing off for now.";
  const entry = await appendEntry(
    ctx.store,
    ctx.room,
    ctx.token,
    { type: "signoff", title: text, body: text },
    ctx.now,
  );
  return {
    posted: wire(entry),
    note: "The other side will see this on their next status check. Your next write clears it automatically.",
  };
}

/**
 * Consent to (or withdraw consent from) deleting this bridge.
 *
 * Both sides must agree — see `lib/purge.ts`. This op is one half; the operator
 * running `bridger purge` is the other. Neither can complete it alone, which is
 * what makes the ledger a joint record rather than one company's database.
 */
export async function opPurge(ctx: OpContext, args: { consent: boolean }) {
  requireWrite(ctx.token);
  await noteProductive(ctx);
  const state = args.consent
    ? await recordPurgeConsent(ctx.store, ctx.room, ctx.token.side, ctx.now)
    : await withdrawPurgeConsent(ctx.store, ctx.room, ctx.token.side);

  const theirs = state[ctx.token.side === "a" ? "b" : "a"];
  return {
    yourConsent: args.consent,
    theirConsent: Boolean(theirs),
    bothAgreed: state.bothAgreed,
    note: args.consent
      ? state.bothAgreed
        ? "Both sides have agreed. The operator can now run the purge."
        : "Recorded. Nothing is deleted until the other side agrees too, and consent expires after 7 days."
      : "Consent withdrawn. Nothing will be deleted.",
    limit:
      "A purge deletes the SERVER's copy only. Anything either side already pulled into a local " +
      "bridger/ folder — and probably committed — is untouched by it.",
  };
}

export async function opWait(ctx: OpContext, args: { since?: number; timeoutSeconds?: number }) {
  const status = await getStatus(ctx.store, ctx.room, ctx.token);

  /**
   * NEVER BLOCK WHILE THE CALLER HAS SOMETHING UNREAD (S#276).
   *
   * This defaulted to `latestSeq`, which means "tell me about things written
   * after this instant" — so an entry already sitting unread was invisible to
   * `wait`, permanently. That is not a corner case, it is what happens whenever
   * the other side answers BEFORE you start waiting, which is the normal shape
   * of an async bridge.
   *
   * It deadlocked two live agents on this bridge the first night both were up.
   * B answered, then waited. A started waiting afterwards, so A's `since` was
   * already past B's answer, and both blocked for a sequence number neither
   * would ever write. The answer sat unread in the ledger the whole time while
   * the idle brake told A "they are not there right now".
   *
   * Same failure this codebase keeps producing: "nothing NEW since you started
   * waiting" rendered identically to "nothing for you". Defaulting to the
   * caller's CURSOR makes the deadlock structurally impossible rather than
   * something both sides have to remember to avoid — whoever holds unread
   * entries gets them immediately, which is also just what waiting should mean.
   *
   * An explicit `since` is still honoured exactly as before.
   */
  const since = args.since ?? status.cursor;

  /**
   * REFUSE BEFORE WAITING, NOT AFTER (S#276).
   *
   * The brake was only evaluated once `waitForNew` returned, so a caller that
   * had ALREADY been told to stop was made to sit through the full 45 seconds
   * before being told again. Measured: three consecutive braked waits at 44.37s
   * each. That is 45s of the caller's wall clock and 45s of billed serverless
   * duration, per ignored refusal — the worst possible answer to a client that
   * is looping, since the cost of refusing scaled with the misbehaviour.
   *
   * Reading the streak without bumping it keeps the escalation identical: the
   * first refusal still lands after MAX_EMPTY_WAIT_STREAK empty waits. Only the
   * repeats get faster, which is the point.
   */
  await refuseIfOverBudget(ctx, WAIT_INSTEAD);

  const result = await waitForNew(ctx.store, ctx.room, ctx.token, {
    sinceSeq: since,
    timeoutMs: (args.timeoutSeconds ?? WAIT_DEFAULT_SECONDS) * 1000,
    pollMs: 1000,
  });

  if (result.entries.length > 0) {
    await resetIdleStreak(ctx.store, ctx.token.id);
    await resetWaste(ctx.store, ctx.token.id);
    return {
      timedOut: false,
      waitedMs: result.waitedMs,
      count: result.entries.length,
      entries: result.entries.map(wire),
      _note: CONTAINMENT_NOTE,
    };
  }

  /**
   * COUNT, GUIDE, BUT DO NOT TERMINATE ON THE COUNT (S#276).
   *
   * The streak still drives the graduated wording below, because that wording
   * demonstrably works — a real far-side agent stopped on the advisory without
   * ever reaching a refusal. What it no longer does is END the session, because
   * a listener is BY CONSTRUCTION a run of empty waits and a consecutive-count
   * brake kills it exactly when the partner is slow. The refusal now comes from
   * the byte budget instead, which is the unit the cost is actually in.
   */
  const streak = await bumpIdleStreak(ctx.store, ctx.token.id);

  const payload = {
    timedOut: true,
    waitedMs: result.waitedMs,
    count: 0,
    entries: [],
    emptyWaitsInARow: streak,
    guidance:
      streak >= MAX_EMPTY_WAIT_STREAK
        ? "Nothing is arriving. Stop and report to your operator — but if you are waiting from a SHELL loop rather than from your own turns, blocking here is cheap and correct; keep going."
        : "Nothing yet. If the next wait is also empty, stop rather than polling.",
  };

  const spent = await chargeWaste(ctx, payload, WAIT_INSTEAD);
  return { ...payload, wastedBytes: spent, wasteBudget: WASTE_BUDGET_BYTES };
}

/**
 * THE PING. One call, everything, then stop.
 *
 * `status` + `read` + `wait` collapsed into a single round trip, for a caller
 * whose only job is to answer what was asked.
 *
 * WHY IT EXISTS, and it is a COST argument rather than a capability one
 * ---------------------------------------------------------------------
 * We call no LLM, so everything we publish is billed to the CALLER: every tool
 * schema on every one of their turns, plus one full inference per call over a
 * context that grew since last time. Answering a question used to cost the far
 * side three turns minimum (`wait` -> `status` -> `answer`) because `wait`
 * returns entries but not open questions, so knowing *what* to answer needed a
 * second call. Measured S#274: the full 11-tool surface is ~1,800 tokens of
 * standing context per turn, so those extra turns are not free curiosity —
 * they are the quota.
 *
 * `opPing` returns the questions awaiting YOU, the unread entries themselves,
 * and whether the peer signed off. After it there is nothing left to look up:
 * the only next move is `bridger_answer`, or stop.
 *
 * THE CURSOR ADVANCES HERE, and that is deliberate. A ping that re-delivered
 * everything would grow the caller's context on every call — the precise cost
 * this exists to remove. Nothing is lost: entries stay in the record and remain
 * readable by seq, and `bridger pull` still materialises the whole thing. The
 * tradeoff is real and it is the right way round: a crash after a ping costs a
 * re-read by seq, while re-delivery would cost tokens on every single call.
 *
 * The idle brake applies unchanged. A ping loop is still a loop, and the point
 * was never to make polling cheap — it was to make it unnecessary.
 */
export async function opPing(ctx: OpContext) {
  const status = await getStatus(ctx.store, ctx.room, ctx.token);
  const fresh = await readEntries(ctx.store, ctx.room.id, { sinceSeq: status.cursor });
  const fromPeer = fresh.filter((e) => e.side !== ctx.token.side);

  if (fresh.length) {
    await setCursor(ctx.store, ctx.room.id, ctx.token.side, fresh[fresh.length - 1].seq);
  }

  // `yours` is the whole point: of every open question, the ones where the ball
  // is on this side. Titles are the partner's prose, so they are contained on
  // the way out exactly as `opStatus` does it.
  const awaitingYou = status.openQuestions
    .filter((q) => q.yours)
    .map((q) => ({ ...q, title: contain(q.title, q.askedBy) }));

  const learned = awaitingYou.length > 0 || fromPeer.length > 0;
  const idle = await brakeIfIdle({
    store: ctx.store,
    tokenId: ctx.token.id,
    learned,
    limit: MAX_IDLE_STREAK,
    instead: "Report to your operator that there is nothing to answer, and stop.",
  });

  return {
    you: status.you,
    peer: status.peer,
    topic: status.topic,
    awaitingYou,
    newEntries: fromPeer.map(wire),
    ...(status.peerSignedOff ? { peerSignedOff: status.peerSignedOff } : {}),
    ...(fromPeer.length || awaitingYou.length ? { _note: CONTAINMENT_NOTE } : {}),
    ...(idle > 0 ? { quietPingsInARow: idle } : {}),
    // Terminal by construction. Names no tool that could be used to look again,
    // because the wait refusal that pointed loops at `bridger_status` is the
    // bug this whole surface is shaped around (S#272).
    guidance: awaitingYou.length
      ? `${awaitingYou.length} question(s) are waiting on you. Answer each with bridger_answer, then stop — you have already been given everything there is to see.`
      : "Nothing is waiting on you. Do not call again; report to your operator and stop.",
  };
}
