/**
 * HOW SPECIFIC IS THIS RECEIPT?
 *
 * `checkedAgainst` is the product. It is also, today, an unvalidated string:
 * `lib/store.ts:41`, `plans/05-ux.md:925-994`, and `the codebase` all render
 * identically as "checked", and a reader cannot tell a pinpoint from a gesture.
 *
 * S#271 caught this live. Antigravity's two citations were audited by hand:
 * one landed exactly, the other pointed at a 70-line span that only glancingly
 * covered the claim. The verdict was **over-broad, not fabricated** — and
 * nothing in the product would have surfaced the difference. A record that
 * cannot distinguish those two is provenance theatre.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * [!!] THIS GRADES THE CITATION, NEVER THE CLAIM.
 *
 * A one-line citation can point at the wrong line. A 400-line citation can be
 * perfectly honest for a claim about a whole module. `kind` and `lines` are
 * facts about the STRING, and that is the entire promise. Nothing here says an
 * answer is true, and no caller may present it as if it did.
 *
 * That restraint is the point. The moment this returns a quality score, it
 * becomes a confident number derived from a regex — precisely the fake-rigor
 * shape this codebase keeps finding, and worse than no signal at all, because
 * a number gets trusted. Display the span. Let the human judge.
 * ─────────────────────────────────────────────────────────────────────────
 */

export type CitationKind =
  /** A file and one line: `lib/store.ts:41`. The narrowest locator there is. */
  | "line"
  /** A file and a line range: `lib/store.ts:41-58`. `lines` carries the span. */
  | "range"
  /** A file, no line: `lib/store.ts`. Locates the document, not the claim. */
  | "file"
  /** An endpoint, command or query actually run: `GET /api/health`, `npm test`. */
  | "command"
  /** A commit-ish hex sha: `4956820`, `e1619d4f...`. */
  | "commit"
  /** Prose with no locator in it: `the codebase`, `our docs`. Weakest form. */
  | "unlocated"
  /** No citation supplied. Honest, and rendered as such — never as a failure. */
  | "none";

export interface Citation {
  kind: CitationKind;
  /** The raw string, unchanged. Always the source of truth for a human. */
  raw: string | null;
  /** Line count when the citation states one. Absent when not computable. */
  lines?: number;
  /** The file path, when one was found. */
  path?: string;
}

/**
 * Ordered widest-last. Used only for sorting and display grouping — NOT as a
 * score. Two citations of the same kind are not thereby equally good.
 */
export const KIND_ORDER: CitationKind[] = ["line", "range", "commit", "command", "file", "unlocated", "none"];

/** Reads as a shell command, HTTP call, or endpoint someone actually ran. */
const COMMAND_RE =
  /^\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/|^\s*(npm|npx|pnpm|yarn|git|curl|docker|psql|node|python|tsc|make|bash|sh)\b|^\s*\$\s+/i;

/** A bare hex sha, 7-40 chars. Guarded so `deadbeef.ts` is not a commit. */
const COMMIT_RE = /^\s*[0-9a-f]{7,40}\s*$/i;

/**
 * `path/to/file.ext:12` or `path/to/file.ext:12-40`.
 *
 * The extension is required. Without it `TRI-Q-003:1` — an entry id — parses as
 * a file citation, and an id is not evidence of anything.
 */
const LOCATOR_RE = /([\w./\\@-]+\.[A-Za-z0-9]{1,12}):(\d+)(?:\s*[-–]\s*(\d+))?/;

/** A bare file path with an extension and no line number. */
const FILE_RE = /(^|\s)([\w./\\@-]*[\w@-]\.[A-Za-z0-9]{1,12})(\s|$|,|;)/;

/**
 * Classify a `checkedAgainst` string.
 *
 * Deliberately total: every input returns a Citation, because a classifier that
 * throws on odd input would make the ledger refuse to render an entry it has
 * already accepted. Unknown shapes land in `unlocated`, which is honest.
 */
export function classifyCitation(raw: string | null | undefined): Citation {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return { kind: "none", raw: raw ?? null };
  }
  const text = raw.trim();

  // Command before locator: `curl https://x/api/v1.json:80` is a command, and
  // the locator pattern would otherwise claim the tail of it.
  if (COMMAND_RE.test(text)) return { kind: "command", raw };
  if (COMMIT_RE.test(text)) return { kind: "commit", raw };

  const loc = LOCATOR_RE.exec(text);
  if (loc) {
    const start = Number(loc[2]);
    const end = loc[3] === undefined ? undefined : Number(loc[3]);
    if (end === undefined || end === start) {
      return { kind: "line", raw, path: loc[1], lines: 1 };
    }
    // A reversed range (`:90-10`) is a typo, not a 0-line span. Take the width
    // rather than propagating a negative, and never report fewer than 1.
    return { kind: "range", raw, path: loc[1], lines: Math.max(1, Math.abs(end - start) + 1) };
  }

  const file = FILE_RE.exec(text);
  if (file) return { kind: "file", raw, path: file[2] };

  return { kind: "unlocated", raw };
}

/**
 * A short human label. Says WHAT WAS CITED, never how good the answer is.
 *
 * The wording matters: "±70 lines" is a fact a reader can act on, whereas
 * "weak" would be a verdict this module has no standing to reach.
 */
export function describeCitation(c: Citation): string {
  switch (c.kind) {
    case "line":
      return "exact line";
    case "range":
      return `${c.lines} lines`;
    case "file":
      return "whole file";
    case "command":
      return "command output";
    case "commit":
      return "commit";
    case "unlocated":
      return "no locator";
    case "none":
      return "unchecked";
  }
}

/**
 * True when the citation names no place a reader could go and look.
 *
 * This is the one judgment the module makes, and it is deliberately crude and
 * binary: either the string contains a locator or it does not. It supports
 * "show me the answers I cannot verify", which is a filter, not a grade.
 *
 * `none` is NOT vague — an answer with no citation is honestly unchecked, and
 * lumping it in with a confident-sounding "the codebase" would hide the
 * distinction that matters most.
 */
export const isUnlocated = (c: Citation): boolean => c.kind === "unlocated";

/** Wide ranges are worth a second look. A threshold, not a verdict. */
export const WIDE_RANGE_LINES = 60;
export const isWideRange = (c: Citation): boolean =>
  c.kind === "range" && (c.lines ?? 0) >= WIDE_RANGE_LINES;
