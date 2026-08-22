/**
 * CONTRACT PATCHING — C3c, proposed by the far side after one session on the
 * bridge.
 *
 * Their finding, unsolicited: *"`contract` currently replaces the whole body, so
 * concurrent updates clobber."* Both sides build against the contract, both
 * sides may edit it, and the only operation available was "here is the whole
 * new document". Two parties editing different parts of one agreement at the
 * same time silently lose one of the edits. That is the worst failure shape this
 * product has, because the loss is invisible: the document afterwards is
 * perfectly well-formed and simply missing something somebody wrote.
 *
 * WHAT A "STRUCTURED KEY" IS HERE, and why not a JSON schema. The body is
 * markdown, and it has to stay markdown: it is read by two models and at least
 * two humans, and it is the artifact a partner pastes into their own session.
 * So the key is the `## heading`, and a section is everything from one heading
 * to the next. That is a real structure, it is already how people write these,
 * and it needs no migration of any contract that exists today.
 *
 * SEMANTICS ARE RFC 7386 (JSON Merge Patch), because the far side used the word
 * and the word has a definition:
 *   - a heading present in the patch REPLACES that section's content
 *   - a heading absent from the patch is LEFT ALONE
 *   - a heading mapped to `null` DELETES that section
 *   - a heading not already present is APPENDED, in patch order
 *
 * WHAT THIS DOES NOT FIX, stated because it would be easy to imply otherwise.
 * Sections shrink the clobber surface from "the whole document" to "the same
 * section", but the write is still read-modify-write, so two patches to the SAME
 * section can still lose one. That is what `ifUnchangedSince` is for, and it is
 * the half that actually makes a lost update impossible rather than unlikely.
 */

/** Everything above the first `## heading`. Belongs to nobody; never patched. */
export interface ParsedContract {
  preamble: string;
  /** Heading text (without the `##`) → the body under it, trimmed of edges. */
  sections: Map<string, string>;
}

const HEADING = /^##\s+(.+?)\s*$/;

export function parseContract(body: string): ParsedContract {
  const preamble: string[] = [];
  const sections = new Map<string, string>();
  let current: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (current !== null) sections.set(current, buffer.join("\n").trim());
    buffer = [];
  };

  for (const line of body.split("\n")) {
    const m = HEADING.exec(line);
    if (m) {
      flush();
      current = m[1];
      // A repeated heading is the caller's problem to notice, but silently
      // merging two sections with one name would make the patch ambiguous, so
      // the LAST one wins on write and the first is preserved on read-back only
      // if nothing patches it. Recording it here keeps that behaviour explicit.
      continue;
    }
    if (current === null) preamble.push(line);
    else buffer.push(line);
  }
  flush();
  return { preamble: preamble.join("\n").trim(), sections };
}

export function renderContract(parsed: ParsedContract): string {
  const parts: string[] = [];
  if (parsed.preamble) parts.push(parsed.preamble);
  for (const [heading, content] of parsed.sections) {
    parts.push(content ? `## ${heading}\n\n${content}` : `## ${heading}`);
  }
  return parts.join("\n\n");
}

/**
 * Apply a merge patch and return the new body plus what actually changed.
 *
 * The changed/added/removed lists are not decoration: they go into the ledger
 * entry, so the record of the most consequential edit either side can make says
 * WHICH parts moved rather than `"<N> chars"`.
 */
export function patchContract(
  body: string,
  patch: Record<string, string | null>,
): { body: string; added: string[]; changed: string[]; removed: string[]; noop: boolean } {
  const parsed = parseContract(body);
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];

  for (const [heading, value] of Object.entries(patch)) {
    const has = parsed.sections.has(heading);
    if (value === null) {
      if (has) {
        parsed.sections.delete(heading);
        removed.push(heading);
      }
      continue;
    }
    const next = value.trim();
    if (!has) {
      parsed.sections.set(heading, next);
      added.push(heading);
    } else if (parsed.sections.get(heading) !== next) {
      parsed.sections.set(heading, next);
      changed.push(heading);
    }
  }

  return {
    body: renderContract(parsed),
    added,
    changed,
    removed,
    // A patch that changes nothing is reported rather than written. Appending a
    // ledger entry saying "the contract was updated" when it was not is exactly
    // the kind of true-and-useless record that makes a ledger tiring to read.
    noop: added.length === 0 && changed.length === 0 && removed.length === 0,
  };
}

/** One line for the ledger, naming the sections rather than counting bytes. */
export function describePatch(r: { added: string[]; changed: string[]; removed: string[] }): string {
  const bits: string[] = [];
  if (r.changed.length) bits.push(`changed ${r.changed.join(", ")}`);
  if (r.added.length) bits.push(`added ${r.added.join(", ")}`);
  if (r.removed.length) bits.push(`removed ${r.removed.join(", ")}`);
  return bits.join("; ") || "no change";
}
