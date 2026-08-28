/**
 * THE EVIDENCE INDEX — every artifact this room has actually rested on, and
 * which side rested on it.
 *
 * WHY IT MOVED HERE (S#284). This aggregation lived in `app/page.tsx`, so the
 * humans WATCHING a room could see the map of what its agreement is built on
 * and the agents WRITING that agreement could not. The product's own claim
 * about itself was rendered for the spectator and withheld from the
 * participant. That is backwards: an agent about to answer needs to know what
 * its partner has already rested claims on far more than a watcher does.
 *
 * It is also the same argument this codebase has now made three times — one set
 * of rules, two transports (`lib/operations.ts`), one credential scan at one
 * seam (`appendEntry`). An index computed once in a React component and again
 * in whatever an agent writes for itself is a fork that drifts silently, and
 * the drift always shows up as two parties reading the same record differently.
 *
 * DERIVED, NEVER CURATED. Nobody pins anything. An artifact is here because
 * somebody named it in `checkedAgainst` to justify a specific claim, numbered
 * by FIRST APPEARANCE so the numbers stay stable as the room grows. A chat app
 * pins sources someone chose in advance; this records what an author says they
 * actually read. That difference is the reason we can do this honestly.
 *
 * WHAT IT IS NOT. It does not say a claim is true, and no caller may present it
 * as if it did (`lib/citation.ts` holds the long version). `span` and `weak`
 * are facts about the STRING — a pinpoint versus a gesture. `citedBy.length` is
 * a fact about the RECORD — six claims resting on one artifact is a different
 * risk from one, and that is a thing a reader should get to see rather than a
 * score we compute for them.
 */

import {
  classifyCitation,
  describeCitation,
  isUnlocated,
  isWideRange,
  type Citation,
  type CitationKind,
} from "./citation";
import type { Entry } from "./entries";
import { citationUrl, isPinned, parseRepo } from "./repo-link";
import type { RoomRecord, SideId } from "./room-registry";

/**
 * The locator kinds that live inside a codebase, and therefore belong to a
 * FILE in the integration surface. A `url`, a `command`, a `commit` and prose
 * are all legitimate evidence and none of them is a file in a repository.
 */
const FILE_KINDS = new Set<CitationKind>(["line", "range", "file"]);

export interface EvidenceCitation {
  /** The entry that rested a claim on this artifact. */
  id: string;
  side: SideId;
  seq: number;
  /**
   * A permalink, when the CITING side declared a repo. Resolved per citation
   * rather than per source: two sides can name the same path and mean two
   * different repositories, and quietly resolving one against the other's
   * would be the worst kind of wrong — a link that opens and shows you
   * somebody else's file.
   */
  url: string | null;
  /** Whether that link is anchored to a commit rather than a moving branch. */
  pinned: boolean;
}

export interface EvidenceSource {
  /** Stable across growth: assigned on first appearance, never renumbered. */
  n: number;
  /** The raw string, unchanged. Always the source of truth for a human. */
  raw: string;
  /** How specific the string is, in our words. Never a judgement of the claim. */
  span: string;
  /** `unlocated` or a very wide range — a gesture rather than a pointer. */
  weak: boolean;
  /** What shape of locator this is. Decides whether it belongs to a FILE. */
  kind: CitationKind;
  /**
   * The file path, when this citation points inside a codebase.
   *
   * **Null for a URL, and that is a correction rather than a detail.**
   * `classifyCitation` sets `path` to the whole URL for a `url` citation —
   * correct there, since the URL *is* its locator — but feeding that into the
   * file grouping put `https://example.com/spec` in the integration surface as
   * though it were a file in somebody's repository. A web page is real evidence
   * and is not part of anyone's codebase. Caught by the negative control in
   * `evidence.test.ts` before it shipped.
   */
  path: string | null;
  citedBy: EvidenceCitation[];
  /** Which seats have rested a claim on this. Usually one; both is significant. */
  sides: SideId[];
  /**
   * Set only when every citation of this string resolves to the SAME link.
   * Ambiguous (two sides, two repos) leaves it null and the per-citation urls
   * carry the truth.
   */
  url: string | null;
}

/**
 * THE INTEGRATION SURFACE — the same evidence, grouped by file.
 *
 * This is the view a planning agent wants and the flat list cannot give: not
 * "what was cited" but "which parts of each side's codebase this collaboration
 * has actually touched". `lib/store.ts:41` and `lib/store.ts:613` are two
 * sources and one file, and the file is the unit a plan is written in.
 *
 * Computed from evidence rather than declared, which is the whole reason it is
 * trustworthy — nobody nominated these files, they are where the claims landed.
 */
export interface EvidenceFile {
  path: string;
  sides: SideId[];
  /** Source numbers touching this file, in first-appearance order. */
  sources: number[];
  /** How many claims rest on this file across all its citations. */
  claims: number;
}

export interface EvidenceIndex {
  sources: EvidenceSource[];
  files: EvidenceFile[];
  /** Entry id -> source number, so prose can carry the same chip the rail shows. */
  numberOf: Record<string, number>;
  perSide: Record<string, { sources: number; files: number; claims: number }>;
  /** Entries carrying a claim but no citation. Honest, and worth seeing. */
  uncited: number;
}

/** The repo a side declared, parsed, or null. Never throws on bad input. */
function repoFor(room: RoomRecord | undefined, side: SideId) {
  const seat = room?.sides?.[side];
  if (!seat) return null;
  return parseRepo(seat.repo, seat.repoRef ?? null);
}

/**
 * Build the index.
 *
 * `room` is optional: without it every `url` is null and everything else is
 * identical. That keeps the function usable from a context that holds entries
 * but not the room record, and makes the link half a strict addition rather
 * than a precondition.
 */
export function buildEvidenceIndex(entries: Entry[], room?: RoomRecord): EvidenceIndex {
  const byRaw = new Map<string, EvidenceSource>();
  const classified = new Map<string, Citation>();
  const numberOf: Record<string, number> = {};
  let uncited = 0;

  for (const e of entries) {
    if (!e.checkedAgainst) {
      // A note or a status line is not a claim missing its receipt. Only the
      // types that assert something count as uncited.
      if (e.type === "answer" || e.type === "decision") uncited += 1;
      continue;
    }
    let src = byRaw.get(e.checkedAgainst);
    if (!src) {
      const c = classifyCitation(e.checkedAgainst);
      classified.set(e.checkedAgainst, c);
      src = {
        n: byRaw.size + 1,
        raw: e.checkedAgainst,
        span: describeCitation(c),
        weak: isUnlocated(c) || isWideRange(c),
        kind: c.kind,
        // Only a locator that points INSIDE a codebase becomes a file. See the
        // note on `path`.
        path: FILE_KINDS.has(c.kind) ? (c.path ?? null) : null,
        citedBy: [],
        sides: [],
        url: null,
      };
      byRaw.set(e.checkedAgainst, src);
    }
    const citation = classified.get(e.checkedAgainst)!;
    const repo = repoFor(room, e.side);
    src.citedBy.push({
      id: e.id,
      side: e.side,
      seq: e.seq,
      url: repo ? citationUrl(citation, repo) : null,
      pinned: repo ? isPinned(repo) : false,
    });
    if (!src.sides.includes(e.side)) src.sides.push(e.side);
    numberOf[e.id] = src.n;
  }

  const sources = [...byRaw.values()];

  // Source-level link only when it is unambiguous. See EvidenceSource.url.
  for (const s of sources) {
    const urls = new Set(s.citedBy.map((c) => c.url).filter((u): u is string => Boolean(u)));
    s.url = urls.size === 1 ? [...urls][0] : null;
  }

  // ── the integration surface ───────────────────────────────────────────────
  const byPath = new Map<string, EvidenceFile>();
  for (const s of sources) {
    if (!s.path) continue;
    let f = byPath.get(s.path);
    if (!f) {
      f = { path: s.path, sides: [], sources: [], claims: 0 };
      byPath.set(s.path, f);
    }
    f.sources.push(s.n);
    f.claims += s.citedBy.length;
    for (const side of s.sides) if (!f.sides.includes(side)) f.sides.push(side);
  }

  const perSide: EvidenceIndex["perSide"] = {};
  for (const s of sources) {
    for (const c of s.citedBy) {
      const row = (perSide[c.side] ??= { sources: 0, files: 0, claims: 0 });
      row.claims += 1;
    }
    for (const side of s.sides) (perSide[side] ??= { sources: 0, files: 0, claims: 0 }).sources += 1;
  }
  for (const f of byPath.values()) {
    for (const side of f.sides) (perSide[side] ??= { sources: 0, files: 0, claims: 0 }).files += 1;
  }

  return {
    sources,
    // Most-rested-on first: the artifact holding up six claims is the one a
    // reader should weigh first, and the one an attacker would most want wrong.
    files: [...byPath.values()].sort((a, b) => b.claims - a.claims || a.path.localeCompare(b.path)),
    numberOf,
    perSide,
    uncited,
  };
}
