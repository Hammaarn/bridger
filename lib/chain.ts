/**
 * TAMPER-EVIDENCE — and read the limits before you trust the word.
 *
 * THE PROBLEM. Bridger's operator runs the server, so the operator can edit any
 * room. For a record two companies build against, that is a real asymmetry: one
 * side's database, the other side's decisions. `VERIFY.md` lists it first under
 * "what you cannot verify", and this file is the beginning of the answer.
 *
 * WHAT IT DOES. Every entry carries `prevHash` and `hash`, where the hash covers
 * the entry's content AND its predecessor. Changing any entry — a word in an
 * answer, a `checkedAgainst` path, the order of two rows — invalidates that
 * entry's hash and every hash after it. Silent edits become arithmetic.
 *
 * [!!] WHAT IT DOES **NOT** DO, and this is the part that makes the feature
 * honest rather than decorative. The server computes these hashes. An operator
 * who edits an entry can recompute the whole chain from that point and serve a
 * perfectly self-consistent forgery. **A chain verified only against the server
 * that produced it proves nothing about that server.** Anyone claiming otherwise
 * is selling you a hash function as if it were a witness.
 *
 * THE PROPERTY THAT IS ACTUALLY REAL comes from a SECOND observer. When a side
 * runs `bridger pull`, the head hash is written into their own `bridger/`
 * folder, on their disk, outside our reach. If the server later reports a
 * different hash for the same sequence number, that divergence is evidence, and
 * it is evidence held by the party who would be harmed. Two independent copies
 * is what turns a checksum into a witness — the chain is the mechanism, the
 * distributed copy is the guarantee.
 *
 * So the accurate claim is: **an operator cannot alter the record without every
 * side that has pulled it being able to prove so.** Not "cannot alter it".
 *
 * ALSO TRUE, AND STATED RATHER THAN HIDDEN:
 *  - Entries written before this existed have no hash. They verify as
 *    `unchained`, never as `broken` — absence of evidence is not evidence of
 *    tampering, and conflating the two would make the check useless on the one
 *    room that matters (the oldest).
 *  - The entry list is trimmed at `MAX_ENTRIES`, so the oldest rows leave the
 *    server. Verification therefore covers a CONTIGUOUS SEGMENT, not history
 *    from genesis, and `verifyChain` reports which segment. A verifier that
 *    quietly checked whatever it happened to receive and reported "ok" would be
 *    the same defect this repository keeps finding: absence rendering as success.
 */

import { createHash } from "node:crypto";

import type { Entry } from "./entries";

/** Fields that are covered by the hash, in a fixed order. */
const COVERED = [
  "id",
  "seq",
  "type",
  "side",
  "code",
  "author",
  "ts",
  "title",
  "body",
  "answers",
  "why",
  "checkedAgainst",
] as const;

export interface ChainedEntry extends Entry {
  /** Hash of the entry before this one, or null for the first in the segment. */
  prevHash?: string | null;
  /** `sha256(prevHash + canonical(entry))`, hex. */
  hash?: string;
}

/**
 * Deterministic serialisation of the fields a hash covers.
 *
 * Explicit field list and explicit order, rather than `JSON.stringify(entry)`:
 * stringify follows key insertion order, so two servers that built the same
 * entry with fields assigned in a different sequence would produce different
 * hashes for identical data — a verification failure with no tampering behind
 * it. Length-prefixing each value stops `title:"ab", body:"c"` from hashing the
 * same as `title:"a", body:"bc"`.
 */
export function canonical(entry: Entry): string {
  const parts: string[] = [];
  for (const key of COVERED) {
    const raw = (entry as unknown as Record<string, unknown>)[key];
    const value = raw === null || raw === undefined ? "<null>" : String(raw);
    parts.push(`${key}:${value.length}:${value}`);
  }
  return parts.join("|");
}

/** The hash for one entry, given its predecessor's. */
export function entryHash(prevHash: string | null, entry: Entry): string {
  // The room id is folded in through the entry's own namespaced `id`, so a
  // segment lifted from one room cannot be presented as a segment of another.
  return createHash("sha256")
    .update(
      // Length-prefixed rather than delimiter-joined, for the same reason
      // `canonical` prefixes each field: no separator character can appear
      // inside a hash or the literal "genesis", but a length cannot be
      // forged by content at all. (This line held a raw NUL byte for about
      // ten minutes -- invisible in a diff, and it made this file read as
      // BINARY to grep. A hashing function nobody can grep is a hashing
      // function nobody can review.)
      `${(prevHash ?? "genesis").length}:${prevHash ?? "genesis"}${canonical(entry)}`,
    )
    .digest("hex");
}

export type ChainVerdict =
  | {
      ok: true;
      /** Entries whose hash was recomputed and matched. */
      verified: number;
      /** Entries with no hash at all — written before chaining existed. */
      unchained: number;
      /** The seq range actually covered. Never implies anything outside it. */
      from: number | null;
      to: number | null;
      head: string | null;
      note: string;
    }
  | {
      ok: false;
      reason: "hash-mismatch" | "broken-link";
      /** The first entry that failed, by id and seq. */
      at: { id: string; seq: number };
      verified: number;
      unchained: number;
      head: string | null;
      note: string;
    };

/**
 * Recompute the chain over whatever entries were supplied.
 *
 * Deliberately takes the entries rather than fetching them: the CLI verifies
 * what the server just sent, and the tests verify hand-built fixtures, and
 * neither should be able to accidentally verify a different list than the one
 * the caller is holding.
 */
export function verifyChain(entries: ChainedEntry[]): ChainVerdict {
  let verified = 0;
  let unchained = 0;
  let prev: string | null = null;
  let head: string | null = null;
  let from: number | null = null;
  let to: number | null = null;
  // Set once a hashed entry is seen. After that point an entry WITHOUT a hash
  // is a gap in a chain that had started, which is a break rather than history.
  let chainStarted = false;

  for (const e of entries) {
    if (!e.hash) {
      if (chainStarted) {
        return {
          ok: false,
          reason: "broken-link",
          at: { id: e.id, seq: e.seq },
          verified,
          unchained,
          head,
          note: "An entry with no hash appears after entries that had one. A chain does not stop and restart on its own.",
        };
      }
      unchained++;
      continue;
    }

    // The first hashed entry sets the anchor. Its `prevHash` is whatever it was
    // written with — we cannot re-derive it, because its predecessor may have
    // been trimmed away. From here on, links must agree.
    if (!chainStarted) {
      chainStarted = true;
      prev = e.prevHash ?? null;
      from = e.seq;
    } else if (e.prevHash !== prev) {
      return {
        ok: false,
        reason: "broken-link",
        at: { id: e.id, seq: e.seq },
        verified,
        unchained,
        head,
        note: "This entry does not point at the hash of the entry before it: a row was altered, removed, or reordered.",
      };
    }

    const expected = entryHash(prev, e);
    if (expected !== e.hash) {
      return {
        ok: false,
        reason: "hash-mismatch",
        at: { id: e.id, seq: e.seq },
        verified,
        unchained,
        head,
        note: "This entry's contents do not match its own hash: the row was edited after it was written.",
      };
    }

    verified++;
    prev = e.hash;
    head = e.hash;
    to = e.seq;
  }

  return {
    ok: true,
    verified,
    unchained,
    from,
    to,
    head,
    note:
      verified === 0
        ? "Nothing to verify: no entry in this record carries a hash yet."
        : `Internally consistent across seq ${from}-${to}. This proves no row was altered relative to the others AS SERVED. It does NOT prove the server did not recompute the whole chain — compare this head against a copy you stored yourself (\`bridger verify\`).`,
  };
}
