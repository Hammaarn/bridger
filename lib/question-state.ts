/**
 * IS THIS QUESTION STILL OPEN — the one answer, shared by everything that asks.
 *
 * WHY IT IS ITS OWN FILE. Three places need this: `openQuestions` in
 * `entries.ts` (the tools), the read-only web view, and anything that renders
 * the ledger later. The web view is a CLIENT component, so it cannot import
 * `entries.ts` — that pulls `room-registry.ts`, which imports `node:crypto` and
 * would break the browser bundle. So the predicate lives here, with **no
 * imports at all**, and both sides use it.
 *
 * THE BUG THIS FIXES, which is the exact shape this codebase keeps producing.
 * The web view had its own copy: `entries.filter(e => e.answers)` counted as
 * answered. That was correct until `reopen` entries existed — and a reopen
 * carries `answers: <questionId>` too, so the moment reopening shipped, the UI
 * began rendering every REOPENED question as ANSWERED. Not a crash and not a
 * blank: the opposite of the truth, in the one panel a human reads to decide
 * whose turn it is.
 *
 * A second copy of a rule is not a duplication problem. It is a correctness
 * problem with a delay on it.
 */

/** The minimum an entry must expose for this to work — both callers satisfy it. */
export interface QuestionStateEntry {
  id: string;
  seq: number;
  type: string;
  answers: string | null;
}

/**
 * Ids of questions that are currently open.
 *
 * A question is open when it has never been answered, or when the newest
 * `reopen` referencing it is NEWER than the newest `answer`. Compared by `seq`,
 * which is monotonic per room — never by timestamp, which would make the answer
 * depend on two companies' clocks agreeing.
 */
export function openQuestionIds(entries: QuestionStateEntry[]): Set<string> {
  const newest = (type: string) => {
    const out = new Map<string, number>();
    for (const e of entries) {
      if (e.type !== type || !e.answers) continue;
      if (e.seq > (out.get(e.answers) ?? -1)) out.set(e.answers, e.seq);
    }
    return out;
  };
  const answeredAt = newest("answer");
  const reopenedAt = newest("reopen");

  const open = new Set<string>();
  for (const e of entries) {
    if (e.type !== "question") continue;
    const a = answeredAt.get(e.id) ?? -1;
    const r = reopenedAt.get(e.id) ?? -1;
    if (a < 0 || r > a) open.add(e.id);
  }
  return open;
}

/** True when the newest thing said about this question was a reopen. */
export function wasReopened(entries: QuestionStateEntry[], questionId: string): boolean {
  return entries.some((e) => e.type === "reopen" && e.answers === questionId);
}
