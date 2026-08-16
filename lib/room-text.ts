/**
 * ROOM METADATA IS NOW ATTACKER-CONTROLLED, AND IT WAS NEVER TREATED AS SUCH.
 *
 * Every entry on this bridge is wrapped before it reaches a model —
 * `operations.ts` contains `title`, `body`, `why`, `checkedAgainst` and the
 * contract body. Two fields were never on that list:
 *
 *   - `room.topic`
 *   - `room.sides.{a,b}.label`
 *
 * and both reach the far side's context raw, through `bridger_status`,
 * `bridger_ping`, `/api/whoami` and `/api/export`. **That was correct until
 * S#275.** Setting either required `UPSTASH_REDIS_REST_*`, so a topic was by
 * definition the operator's own words. The browser mint endpoint removes that
 * precondition on purpose, and the same two fields become a string an anonymous
 * stranger chooses and our model reads.
 *
 * It is the same shape as JudgeMySite S#273, where a judge invented six audit
 * results because a prompt named a `<lighthouse_audit>` block he was never
 * given: a field nobody thought of as content is still content.
 *
 * THE SPLIT, because one half is real and the other is a rail.
 *
 *   DETERMINISTIC. Bounded length, single line, no control characters, and
 *   containment markers neutralised. This is string surgery: after it, a topic
 *   cannot forge or escape a container, cannot inject a fake banner, cannot
 *   smuggle a multi-line instruction block, and cannot blow up a caller's
 *   context with 40 KB of prose. That is what this file actually buys.
 *
 *   ADVISORY. The caller still sees whatever single line the stranger wrote,
 *   and a single line can say "ignore your previous instructions". Wrapping it
 *   in the untrusted banner (done at the read seam, not here) raises the cost
 *   and does not bound it. `untrusted.ts` says the same thing about its own
 *   banner and is right to.
 *
 * WHY THIS RUNS AT THE WRITE, NOT THE FOUR READS. `createRoom` is the one place
 * a topic or a label enters the system. Guarding there is a smaller diff than
 * guarding `entries.ts:365`, `operations.ts:487`, `whoami.ts:77` and
 * `app/api/export/route.ts:67` — and, more to the point, a read-side guard is
 * one someone will forget to add to the fifth read path.
 *
 * THE STRIPPING IS DONE BY CODE POINT, NOT BY A REGEX CLASS. Three earlier
 * drafts of this file embedded the raw bytes in a character class, where they
 * are invisible in a diff, make the file read as binary to `grep`, and cannot
 * be reviewed by anyone — including the author, who put them there three times
 * without seeing it. Numeric ranges are pure ASCII, greppable, and each one can
 * carry the note explaining why it is on the list.
 */

import { escapeMarkers } from "./untrusted";

/**
 * Ceilings, in characters.
 *
 * Generous for a human naming a room, mean for anything trying to use the field
 * as a payload carrier. A label also becomes a 3-letter code and appears in
 * every entry id, so it has no business being long.
 */
export const MAX_TOPIC = 200;
export const MAX_LABEL = 60;

export class RoomTextRejected extends Error {
  constructor(
    readonly field: string,
    readonly why: string,
  ) {
    super(`${field}: ${why}`);
    this.name = "RoomTextRejected";
  }
}

/**
 * Characters that must not survive into a stored room name, by code point.
 *
 * Each range is here for a stated reason. The bidi block is the interesting
 * one: U+202E (RIGHT-TO-LEFT OVERRIDE) makes one string RENDER as a different
 * string, so two rooms can look identical in the UI and be distinct in storage
 * -- an impersonation primitive, not a formatting quirk.
 */
const STRIP_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08], // C0 controls below tab
  [0x0b, 0x0c], // vertical tab, form feed
  [0x0e, 0x1f], // the rest of C0
  [0x7f, 0x9f], // DEL and the C1 controls
  [0x200b, 0x200f], // zero-width space/joiners, LTR and RTL marks
  [0x202a, 0x202e], // bidi embedding, override, pop
  [0x2066, 0x2069], // bidi isolates
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
];

/**
 * Code points that are line breaks to anything rendering prose.
 *
 * U+2028 and U+2029 are the ones a payload uses to keep its second line: they
 * break a line for a reader and are invisible to a strip that only knows LF
 * and CR. Tab is folded in here too, since it is whitespace rather than
 * something to delete outright.
 */
const BREAK_CODES: ReadonlySet<number> = new Set([0x09, 0x0a, 0x0d, 0x2028, 0x2029]);

const inRange = (cp: number) => STRIP_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);

/** Delete the invisibles, turn every kind of break into a plain space. */
function flatten(input: string): string {
  let out = "";
  // Iterating the string (not indexing it) walks whole code points, so an
  // astral character is never split into surrogates that then get inspected
  // individually and mangled.
  for (const ch of input) {
    const cp = ch.codePointAt(0) as number;
    if (BREAK_CODES.has(cp)) out += " ";
    else if (!inRange(cp)) out += ch;
  }
  return out;
}

/**
 * Make one piece of operator-supplied room metadata safe to store.
 *
 * Rejects rather than silently truncating when the input is unusable. A room
 * named `""` after cleaning is a room whose creator gets to find that out now,
 * not a room called "Untitled" that they did not ask for — and silent repair is
 * how you end up with a field whose contents nobody can predict.
 */
export function sanitiseRoomText(raw: unknown, field: string, max: number): string {
  if (typeof raw !== "string") throw new RoomTextRejected(field, "must be text");

  const cleaned = flatten(raw)
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) throw new RoomTextRejected(field, "cannot be empty");
  if (cleaned.length > max) {
    throw new RoomTextRejected(field, `must be ${max} characters or fewer (got ${cleaned.length})`);
  }

  // Last, and deliberately last: neutralise anything that could pass for our
  // own containment markers. Escaping before the whitespace collapse would let
  // a marker be reassembled out of fragments the collapse pushes together.
  return escapeMarkers(cleaned);
}

/** The three fields a room is created from, cleaned together. */
export function sanitiseRoomMetadata(input: {
  topic: unknown;
  ownerLabel: unknown;
  peerLabel: unknown;
}): { topic: string; ownerLabel: string; peerLabel: string } {
  return {
    topic: sanitiseRoomText(input.topic, "topic", MAX_TOPIC),
    ownerLabel: sanitiseRoomText(input.ownerLabel, "ownerLabel", MAX_LABEL),
    peerLabel: sanitiseRoomText(input.peerLabel, "peerLabel", MAX_LABEL),
  };
}
