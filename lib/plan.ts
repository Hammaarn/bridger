/**
 * THE PLAN STAGE — F1.
 *
 * Erik and the partner both felt the same gap after working a real room, and the
 * far side's own `C3c` named its mechanism from the other end. Three parties, no
 * contact between them, one conclusion. Erik's words:
 *
 *   "there should be a Plan stage where the LLM's can talk to each other about a
 *    specific topic/project or whatever both humans set as the agenda. Then the
 *    LLM's should plan together, listing every important aspect from both
 *    respective sides with their respective context."
 *
 * THE VERSION THIS IS NOT, and it is the one we would have built by accident.
 * "Let the two models talk" produces volume, not a plan. It burns both sides'
 * quota on exactly the loop the rate limits exist to prevent, and it throws away
 * the only thing that makes this a record rather than a chat: entries here are
 * typed, cited and append-only. A plan mode that drops that is a worse Slack.
 *
 * **So a plan is a DOCUMENT BOTH SIDES CONVERGE ON, not a conversation they
 * have** — and specifically it is a LIST OF ITEMS, not prose. That is the whole
 * design decision, and everything else follows from it:
 *
 *   - prose has no completion condition; a list of owned items does
 *   - "are we done planning" becomes a computation, not a feeling. Every item
 *     has an owner and is no longer open. That is falsifiable, which "the agents
 *     agreed they were finished" is not
 *   - it answers Erik's ask literally: every important aspect, from both sides,
 *     each carrying whose it is
 *
 * WHAT IS DELIBERATELY NOT ENFORCED. The room's phase shapes GUIDANCE and
 * LAYOUT and never permissions — the moment a phase refuses a write we have
 * built a workflow engine, and a room in `plan` that rejects a `decide` is
 * hostile and would be routed around within a day. You may write a plan in any
 * phase and any entry in any phase.
 *
 * THE ONE RULE THAT IS ENFORCED, because it is authorship and not workflow:
 * **only the side that OWNS an item may mark it agreed.** A commitment has to
 * come from the party making it. That is the same principle as `identify` (name
 * only yourself) and `reopen` (only the asker decides their question is not
 * answered), and it is the property the whole ledger rests on. Everything else
 * — raising items, proposing an owner, editing a title, dropping your own — is
 * open, because collaboration is the point.
 */

import type { SideId } from "./room-registry";

/** `open` is the default; the other two are the ways an item stops being work. */
export type PlanItemState = "open" | "agreed" | "dropped";

/**
 * `null` means nobody has claimed it yet, and it is the state the completion
 * check is really about — an unowned item is the most common way a plan looks
 * finished and is not. `both` is a real answer, not a dodge: some work genuinely
 * needs a change on each side, and forcing a single owner would make one party
 * quietly responsible for the other's half.
 */
export type PlanOwner = SideId | "both" | null;

export interface PlanItem {
  /** `ACM-P-001` — namespaced by the side that raised it, like every entry id. */
  id: string;
  title: string;
  /** Context from the raiser's own codebase. The half Erik asked for by name. */
  note: string;
  owner: PlanOwner;
  state: PlanItemState;
  /** Who put it on the board. Never changes, even if the owner does. */
  raisedBy: SideId;
  at: string;
}

export interface Plan {
  items: PlanItem[];
  updatedAt: string | null;
}

export const EMPTY_PLAN: Plan = { items: [], updatedAt: null };

/** Tolerant of anything the store hands back; a broken record reads as empty. */
export function parsePlan(raw: unknown): Plan {
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!v || !Array.isArray(v.items)) return EMPTY_PLAN;
    const items = v.items.filter(
      (i: unknown): i is PlanItem =>
        !!i && typeof (i as PlanItem).id === "string" && typeof (i as PlanItem).title === "string",
    );
    return { items, updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : null };
  } catch {
    return EMPTY_PLAN;
  }
}

/**
 * IS THE PLAN DONE? A computation, never a declaration.
 *
 * `blocking` is the actionable half and the reason this returns a shape rather
 * than a boolean: an agent asking "are we finished" needs to know WHAT is not
 * finished, or its only move is to ask again.
 */
export interface PlanReadiness {
  total: number;
  open: number;
  unowned: number;
  agreed: number;
  dropped: number;
  complete: boolean;
  blocking: string[];
}

export function readiness(plan: Plan): PlanReadiness {
  const live = plan.items.filter((i) => i.state !== "dropped");
  const unowned = live.filter((i) => i.owner === null);
  const open = live.filter((i) => i.state === "open");
  return {
    total: plan.items.length,
    open: open.length,
    unowned: unowned.length,
    agreed: plan.items.filter((i) => i.state === "agreed").length,
    dropped: plan.items.filter((i) => i.state === "dropped").length,
    // An EMPTY plan is not a complete one. Nothing to do and nothing agreed are
    // the same shape to a boolean, and they are opposite situations — the same
    // absence-versus-emptiness trap this project keeps finding elsewhere.
    complete: live.length > 0 && open.length === 0 && unowned.length === 0,
    blocking: [
      ...unowned.map((i) => `${i.id} has no owner`),
      ...open.filter((i) => i.owner !== null).map((i) => `${i.id} is not agreed by ${i.owner}`),
    ],
  };
}

export class PlanRefused extends Error {}

/**
 * Apply one change and return the new plan plus a line for the ledger.
 *
 * Pure: takes the plan, returns a plan. The store, the ids and the clock are the
 * caller's problem, which is what makes every rule above testable without a
 * server.
 */
export function applyPlan(
  plan: Plan,
  actor: SideId,
  change:
    | { op: "add"; id: string; title: string; note?: string; owner?: PlanOwner }
    | { op: "set"; id: string; title?: string; note?: string; owner?: PlanOwner; state?: PlanItemState },
  now: string,
): { plan: Plan; summary: string } {
  if (change.op === "add") {
    if (plan.items.some((i) => i.id === change.id)) {
      throw new PlanRefused(`Item ${change.id} already exists.`);
    }
    const item: PlanItem = {
      id: change.id,
      title: change.title,
      note: change.note ?? "",
      owner: change.owner ?? null,
      state: "open",
      raisedBy: actor,
      at: now,
    };
    return {
      plan: { items: [...plan.items, item], updatedAt: now },
      summary: `raised ${item.id}${item.owner ? ` for ${item.owner}` : " (unowned)"}`,
    };
  }

  const existing = plan.items.find((i) => i.id === change.id);
  if (!existing) {
    throw new PlanRefused(
      `No plan item ${change.id} on this bridge. Read the plan first — ids are namespaced per side.`,
    );
  }

  // THE ONE ENFORCED RULE. Agreement is a commitment, and a commitment made on
  // somebody else's behalf is worthless — it is the same reason only the asker
  // may reopen and only a side may name itself. `both` means each side agrees
  // for itself, so either may set it; nobody is being spoken for.
  if (change.state === "agreed" && existing.owner !== actor && existing.owner !== "both") {
    throw new PlanRefused(
      existing.owner === null
        ? `${existing.id} has no owner yet. Give it one before agreeing to it — agreeing to unowned work commits nobody.`
        : `${existing.id} is owned by side ${existing.owner}. Only they can agree to it; you can propose, reassign or drop it.`,
    );
  }

  const next: PlanItem = {
    ...existing,
    title: change.title ?? existing.title,
    note: change.note ?? existing.note,
    owner: change.owner !== undefined ? change.owner : existing.owner,
    state: change.state ?? existing.state,
  };

  const moved: string[] = [];
  if (next.title !== existing.title) moved.push("retitled");
  if (next.note !== existing.note) moved.push("re-noted");
  if (next.owner !== existing.owner) moved.push(`owner -> ${next.owner ?? "unowned"}`);
  if (next.state !== existing.state) moved.push(`${next.state}`);
  if (moved.length === 0) {
    // Reported, not written. "The plan was updated" when it was not is the kind
    // of true-and-useless ledger entry that makes a record tiring to read.
    return { plan, summary: "" };
  }

  return {
    plan: { items: plan.items.map((i) => (i.id === change.id ? next : i)), updatedAt: now },
    summary: `${change.id}: ${moved.join(", ")}`,
  };
}

/**
 * What to tell a caller next, from the plan alone.
 *
 * This is the `guidance` channel (C1) carrying its first real feature instead of
 * one advisory rule. Phrased as the next MOVE rather than as a status, because
 * an agent reading "3 items are open" still has to decide what that means.
 */
export function planGuidance(plan: Plan, you: SideId, phase: string): string | null {
  if (phase !== "plan") return null;
  const r = readiness(plan);
  if (r.total === 0) {
    return (
      "This room is in its PLAN phase and the plan is empty. Use bridger_plan to list every " +
      "aspect of this work that your side can see — one item each, with the context from your " +
      "own codebase in `note`. Name an owner where you already know it, and leave it null where " +
      "it is genuinely theirs to say."
    );
  }
  const yours = plan.items.filter(
    (i) => i.state === "open" && (i.owner === you || i.owner === "both"),
  );
  if (yours.length) {
    return `${yours.length} plan item(s) are yours and not yet agreed: ${yours
      .map((i) => i.id)
      .join(", ")}. Agree to each with bridger_plan, or reassign it if it is not yours after all.`;
  }
  if (r.unowned) {
    return `${r.unowned} plan item(s) have no owner. An unowned item is the most common way a plan looks finished and is not — claim the ones that are yours.`;
  }
  if (r.complete) {
    return (
      "Every plan item is owned and agreed. The plan phase is finished: move the room to `build` " +
      "with bridger_plan, and record anything settled along the way with bridger_decide."
    );
  }
  return null;
}
