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
  /**
   * A web source: `https://example.com/a`, or a bare host like `example.org`.
   * Locates a page, not a span — and unlike a file, it can change under you.
   */
  | "url"
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
  /** First line, when the citation states one. Added S#281 for permalinks. */
  start?: number;
  /** Last line of a range. Equal to `start` for a single line. */
  end?: number;
}

/**
 * Ordered widest-last. Used only for sorting and display grouping — NOT as a
 * score. Two citations of the same kind are not thereby equally good.
 */
export const KIND_ORDER: CitationKind[] = [
  "line",
  "range",
  "commit",
  "command",
  "file",
  "url",
  "unlocated",
  "none",
];

/**
 * Reads as a shell command, HTTP call, or endpoint someone actually ran.
 *
 * `gh`, `rg`, `grep`, `cargo` and `pytest` added S#284: a real citation in the
 * live room read `gh repo view --json visibility ... on Hammaarn/judgemysite`,
 * which is unmistakably a command that was run, and it fell through to be
 * graded a "web source" because the sentence later contained a URL. A tool this
 * codebase uses constantly was simply missing from the list.
 */
const COMMAND_RE =
  /^\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/|^\s*(npm|npx|pnpm|yarn|git|gh|curl|docker|psql|node|python|pytest|cargo|rg|grep|tsc|make|bash|sh)\b|^\s*\$\s+/i;

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
 * WEB SOURCES, AND WHY THIS MUST RUN BEFORE `FILE_RE`.
 *
 * A bare domain has the exact shape of a file path with an extension, so
 * `1927flood.lthp.org` matched `FILE_RE` and rendered as **"whole file"** — the
 * record telling a reader that a citation pointed at a document in this
 * repository when it pointed at a news archive. Found by hitting it: a real
 * answer citing five news and archive domains was graded "whole file", and
 * under this module's own doctrine that is not a cosmetic label but a false
 * fact about the string.
 *
 * THE TLD LIST IS AN ALLOWLIST ON PURPOSE. `.ts`, `.sh`, `.rs`, `.io` and `.me`
 * are simultaneously real country TLDs and real source extensions. A general
 * "dot followed by letters" pattern would reclassify `lib/store.ts` as a
 * website, which is the worse direction to be wrong in — a reader sent to the
 * web for something that is on disk cannot find it at all. So this contains
 * only TLDs that are not plausible source extensions in this codebase, and
 * `.ts` is deliberately absent even though Tonga exists.
 *
 * The trailing `(?![\w-])` stops `example.company` from matching `example.com`.
 *
 * ── [!!] AND THE MATCH MUST DOMINATE. (S#284, found live in the real room.) ─
 *
 * This pattern used to be searched ANYWHERE in the string and accepted at any
 * size, so a citation that merely *mentioned* a domain became a "web source".
 * Four of the seven citations in the live Northwind room were misclassified
 * this way — prose describing commands and production runs, graded as web
 * sources because a sentence happened to contain `headless.design`.
 *
 * **The mislabel was not the harm.** `isUnlocated()` fires only on
 * `unlocated`, so those long vague citations ESCAPED the `weak` flag — while
 * an honest three-word `"the codebase"` got flagged. The vaguest citations in
 * the room were rendering as *stronger* than the modest ones: a gesture
 * presented as a pointer, which is the exact failure this module exists to
 * prevent (S#271), living inside the classifier itself.
 *
 * **Anchoring alone was too blunt, and the existing suite caught it.** The
 * test for `"see tribunaldelasaguas.org for the ordinances"` is right that a
 * short phrase around a domain is still a web source — you can go and look.
 * So the test is POSITION OR DOMINANCE: the URL either starts the citation, or
 * makes up a meaningful share of it. A domain wrapped in four words is a
 * source; a domain buried in a two-hundred-character paragraph is prose, and
 * prose is `unlocated`, which is honest and correctly weak.
 *
 * **And the share is measured across ALL the URLs, not the first one — which
 * the suite also caught.** The original regression string (entry `ABF-A-002`)
 * lists FIVE domains across 230 characters of prose about web research. Judged
 * on its first match alone it scores 8% and falls back to "whole file", which
 * is precisely the false fact this rule was written to stop. Judged on total
 * coverage it scores ~43% and is correctly a web source. The honest question is
 * *"how much of this citation is web addresses"*, not *"is the first one big"*.
 *
 * The threshold is a knob and is named rather than hidden. It separates the
 * real cases by a wide margin — the live misclassifications sat near 8%, the
 * legitimate ones at 43% and 53% — so its exact value is not load-bearing.
 */
const WEB_TLDS = "com|org|net|edu|gov|mil|int|info|io|dev|app|ai|xyz|eu|uk|nl|se|de|fr";
const URL_RE = new RegExp(
  `(?:https?://|www\\.)[^\\s,;]+|(?:[a-z0-9-]+\\.)+(?:${WEB_TLDS})(?![\\w-])`,
  "i",
);

/** Share of the citation web addresses must occupy when one does not start it. */
const URL_DOMINANCE = 0.3;

/** Total characters of the citation taken up by web addresses. */
function urlCoverage(text: string): number {
  const all = new RegExp(URL_RE.source, "gi");
  let covered = 0;
  for (const m of text.matchAll(all)) covered += m[0].length;
  return covered;
}

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
      return { kind: "line", raw, path: loc[1], lines: 1, start, end: start };
    }
    // A reversed range (`:90-10`) is a typo, not a 0-line span. Take the width
    // rather than propagating a negative, and never report fewer than 1.
    // Normalised so a reversed range still yields a usable permalink anchor.
    const lo = Math.min(start, end);
    const hi = Math.max(start, end);
    return {
      kind: "range",
      raw,
      path: loc[1],
      lines: Math.max(1, hi - lo + 1),
      start: lo,
      end: hi,
    };
  }

  // AFTER the locator, BEFORE the file. After, so `lib/store.ts:41` stays the
  // more specific `line` rather than being read as a host. Before, so a bare
  // domain is not claimed by `FILE_RE` and mislabelled "whole file".
  // Position OR dominance — see URL_RE. A citation that merely mentions a
  // domain in passing is prose, and must fall through to `unlocated` so that
  // `weak` fires on it.
  const url = URL_RE.exec(text);
  if (url && (url.index === 0 || urlCoverage(text) / text.length >= URL_DOMINANCE)) {
    return { kind: "url", raw, path: url[0] };
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
    case "url":
      // Not "whole page": the point of the label is that it is OFF DISK, which
      // is the thing a reader of this record most needs to know before going
      // to look — the page can have changed since it was cited.
      return "web source";
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
