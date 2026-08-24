/**
 * F2 — ROOM SHAPES. (S#281)
 *
 * **In its own module because it is the only part of the room model the BROWSER
 * needs.** It first lived in `room-registry.ts`, which imports the store, which
 * imports `@upstash/redis` and `node:fs` — so importing one presentational
 * constant into a client component dragged the entire server stack into the
 * browser bundle and the dev build died with *"the chunking context does not
 * support external modules (request: node:fs)"*.
 *
 * A constant that both sides read belongs where both sides can reach it. This
 * file imports nothing but a type, and `room-registry` imports FROM it rather
 * than the other way round.
 *
 * ── WHAT A SHAPE ACTUALLY IS ─────────────────────────────────────────────
 *
 * A shape was specified as *an ordered list of stages*. Read against what a
 * phase DOES, that list is shorter than it looked: `plan` emits guidance
 * telling both sides to fill the board, name owners and agree each item;
 * `build` emits nothing. Everything else about a room is identical in both.
 *
 * So a shape is, today, exactly one decision — **which phase does this room
 * open in** — and pretending otherwise would be a settings screen for a choice
 * that does not exist yet. When a third stage becomes real, this list grows and
 * the type carries it.
 *
 * ── WHY THERE ARE TWO AND NOT THREE ──────────────────────────────────────
 *
 * The proposal listed *Just talk*, *Plan then build* and *Question and answer*.
 * The third is not a stage sequence at all: it is the `answerer` TOKEN ROLE, a
 * narrowed tool surface minted per credential (`TokenRole` in
 * `room-registry.ts`). It is a different axis — who may do what, rather than
 * what happens when — and offering it here would have attached it to a ROOM
 * when it is granted to a TOKEN. It stays where it is, reachable exactly as
 * before via `bridger answerer`.
 *
 * ── ON THE NAMES ─────────────────────────────────────────────────────────
 *
 * *Just talk* apologised for itself twice in two words. "Just" tells someone
 * their most common choice is the lesser one, and "talk" is the wrong noun for
 * a product whose whole argument is that this is an append-only RECORD rather
 * than a chat — the landing page says so in its first sentence.
 *
 * *Plan then build* was accurate and the "build" half reads oddly for two
 * companies agreeing an API contract; they are not building anything together.
 * "Plan first" keeps the sequence and drops the claim.
 *
 * Both names now say what you GET rather than what you skip, and both use words
 * the room will show you again later — the phase badge reads `plan`, and the
 * guidance it emits says "plan phase". A preset whose name disappears the
 * moment you enter the room taught you nothing.
 */

/** Kept in sync with `RoomPhase` in `room-registry.ts`, which imports this file. */
export type RoomPhaseId = "plan" | "build";

export interface RoomShape {
  /**
   * The stages, in order — what the preset actually IS.
   *
   * Erik, S#282, after a Gemini audit: the presets *"don't actually reveal
   * first glance what and how they are shaped"*. Both cards described a
   * FEELING ("start writing straight away") and neither showed the thing that
   * differs, which is the stage list. A shape rendered as its stages cannot be
   * misread as infrastructure, which is exactly how the auditor misread it.
   */
  readonly stages: readonly string[];
  /** What the room will actually DO to the two agents in this shape. */
  readonly effect: string;
  id: string;
  phase: RoomPhaseId;
  name: string;
  /** One line, shown under the name at the moment of choosing. */
  blurb: string;
}

export const ROOM_SHAPES: readonly RoomShape[] = [
  {
    id: "record",
    phase: "build",
    name: "Open record",
    blurb: "Start writing straight away. No stages, no prompting — just the shared record.",
    stages: ["record"],
    effect: "Neither side is prompted. Ask, answer and decide in any order.",
  },
  {
    id: "plan-first",
    phase: "plan",
    name: "Plan first",
    blurb:
      "Both sides list what they can see and agree who owns each item, then the room moves to the work.",
    stages: ["plan", "build"],
    effect:
      "While planning, both AIs are told to fill the board, claim owners and agree each item. The board takes the full width until you move on.",
  },
] as const;

/**
 * The shape a phase corresponds to, for rendering a room you did not create.
 *
 * Falls back to the first shape rather than returning null: a room always has a
 * phase, so "no shape" is not a state a reader should ever be shown.
 */
export function shapeForPhase(phase: RoomPhaseId): RoomShape {
  return ROOM_SHAPES.find((s) => s.phase === phase) ?? ROOM_SHAPES[0]!;
}

/** The default shape for a room kind — the behaviour each already had. */
export function defaultShapeFor(kind: "trust" | "solo"): RoomShape {
  return shapeForPhase(kind === "solo" ? "build" : "plan");
}
