/**
 * WHAT EACH OPERATION IS, IN ONE PLACE.
 *
 * Two consumers, and they used to be two hand-maintained copies of the same
 * judgement: the MCP tool annotations (`readOnlyHint` / `destructiveHint`) and
 * the flat transport's `help`. `app/api/rpc/route.ts` already warns that "a
 * divergence between the two would be a bug nobody notices for months" -- this
 * is that warning taken seriously before the divergence happened rather than
 * after.
 *
 * `writes` answers exactly ONE question: does this append to the record the two
 * parties share? That is the question a planning harness is really asking, and
 * it is deliberately NOT "does this have any effect" -- there is no free call
 * here. Every operation spends the caller's quota and feeds the idle brake;
 * `ping` always advances the read cursor and `read` does when `markRead` is set.
 * A tool whose read-onlyness depends on an argument cannot say so in a static
 * annotation, and `read` is that tool.
 *
 * The summaries are written for an AGENT deciding which call to make next, not
 * for a docs page. One line, naming the cheaper alternative where one exists.
 */
export interface OpNature {
  /** Appends to the shared record. */
  writes: boolean;
  /** Destroys rather than appends. Exactly one operation does. */
  destroys?: boolean;
  /** Calling this repeatedly with the same args has the same effect as once. */
  idempotent: boolean;
  summary: string;
}

export const OP_NATURE: Record<string, OpNature> = {
  status: {
    writes: false,
    idempotent: true,
    summary:
      "What has happened since you last read: unread count, open questions and whose turn each is, whether the peer has connected. Prefer `ping` — it answers this and more in one call.",
  },
  ping: {
    writes: false,
    idempotent: true,
    summary:
      "Everything waiting for you in a single call: questions it is your turn to answer, new entries from the other side, and whether they signed off. After this there is nothing further to look up.",
  },
  read: {
    writes: false,
    idempotent: true,
    summary:
      "Entries from the record. `since` with the cursor from status for only what is new, or `ids` for a specific question or decision. `markRead: true` advances your cursor — that part does write.",
  },
  wait: {
    writes: false,
    idempotent: true,
    summary:
      "Blocks until something arrives or the call self-caps. Cheaper for everyone than polling: it costs you no context while it hangs.",
  },
  ask: {
    writes: true,
    idempotent: false,
    summary:
      "Open a question for the other side. Use this instead of asking your own operator to relay it — that relay is what this removes. Ask when the answer lives in THEIR codebase or is THEIR decision.",
  },
  answer: {
    writes: true,
    idempotent: false,
    summary:
      "Answer one of their questions. Name what you actually read in `checkedAgainst`, or declare `basis` as `opinion` or `inference`. An unchecked answer is fine; an unchecked answer dressed as a verified one is not.",
  },
  decide: {
    writes: true,
    idempotent: false,
    summary:
      "Record a decision and the reasoning behind it. The most consequential entry type — it may also carry `checkedAgainst`, so a decision grounded in a measurement can name the measurement.",
  },
  post: {
    writes: true,
    idempotent: false,
    summary: "A note for the record: context, a finding, a heads-up. Not a question and not a decision.",
  },
  contract: {
    writes: true,
    idempotent: false,
    summary:
      "The document both sides build against. Omit every argument to READ it. To change it, prefer `sections` (patch by `## heading`) over `body` (replace the whole thing) — a whole-body write erases whatever the other side wrote while you were drafting.",
  },
  identify: {
    writes: true,
    idempotent: true,
    summary:
      "Name your OWN side: `label` is who you are, `agent` is what is typing (claude, gemini, gpt...). Self-declared and never verified — it makes a room readable, it does not prove anything. Send neither argument to read your current identity.",
  },
  plan: {
    writes: true,
    idempotent: true,
    summary:
      "The shared plan for this room. No arguments reads it (items, owners, and what is still blocking); `add` raises an item with the context from YOUR side; `set` changes one; `phase` moves the room between plan and build. Only the side that OWNS an item may agree to it.",
  },
  reopen: {
    writes: true,
    idempotent: false,
    summary:
      "Say an answer did not settle your question. Only the side that ASKED may reopen — otherwise the signal means nothing.",
  },
  signoff: {
    writes: true,
    idempotent: false,
    summary: "Declare your side done. It does not close the room; it records that you consider the work complete.",
  },
  invite: {
    writes: true,
    idempotent: false,
    summary:
      "Mint a join link for the other seat, so nobody has to paste a live bearer token into a chat window.",
  },
  purge: {
    writes: true,
    destroys: true,
    idempotent: true,
    summary: "Destroys the room and its record. The only operation here that removes rather than appends.",
  },
};

/** MCP annotation object for one op, built from the single source above. */
export function annotationsFor(op: string) {
  const n = OP_NATURE[op];
  if (!n) throw new Error(`No recorded nature for op "${op}" — add it to lib/op-nature.ts`);
  return {
    readOnlyHint: !n.writes,
    destructiveHint: Boolean(n.destroys),
    idempotentHint: n.idempotent,
    // Always true: the record is a shared external system whose contents this
    // server does not control, and half of it is written by another company.
    openWorldHint: true,
  };
}
