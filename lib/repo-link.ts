/**
 * TURNING A CITATION INTO A LINK THE OTHER SIDE CAN OPEN. (S#281)
 *
 * `checkedAgainst` is the product: an answer that names what its author
 * actually read. It has always stopped one step short of its own argument,
 * though — `lib/store.ts:41` is a promise the reader cannot check, because
 * they do not have your repository and the string does not say which one it is.
 *
 * Supply the missing half — WHICH repo — and a citation becomes a permalink to
 * the exact line. That is provenance finished: not "I read this", but "read it
 * yourself, here."
 *
 * ── WHY THIS FILE IS SO CAREFUL ──────────────────────────────────────────
 *
 * The repo is SELF-DECLARED, exactly like `agent`. Nothing here verifies that
 * a side owns the repository it names, and nothing can. That is fine for a
 * label. It is NOT fine for a URL, because a URL is clickable:
 *
 *   **an unvalidated repo field turns every citation in the room into a link
 *   the far side controls.** Declare `https://evil.example/` and each receipt
 *   in your record becomes bait, inside a product whose entire pitch is that
 *   its record can be trusted. That is a phishing primitive, not a feature.
 *
 * So the URL is not stored as given. It is PARSED against a fixed allow-list of
 * forge hosts, rebuilt from its own parts, and rejected outright if it does not
 * fit. A rejected repo is not an error the room shows — the citation simply
 * renders as it does today, as text. Failing back to the current behaviour is
 * the only safe failure here.
 *
 * ── ON SELF-HOSTED FORGES, and it is a real cost ─────────────────────────
 *
 * A partner running self-hosted GitLab cannot use this, and that is deliberate:
 * an arbitrary host is indistinguishable from an attacker's host, so allowing
 * "any GitLab" means allowing anything. The allow-list is the whole defence and
 * a configurable one would not be a defence. Widening it is an operator
 * decision with the above paragraph attached, not a convenience.
 */

import type { Citation } from "./citation";

/**
 * Hosts whose blob-URL format is KNOWN, not guessed.
 *
 * `deep` says whether we can build a line-anchored URL for this host. Where it
 * is false the repo still links — to its root — because a link that lands
 * somewhere real is honest, while a guessed anchor that 404s teaches a reader
 * that our links are unreliable.
 */
const FORGES: Record<string, { deep: boolean; blob?: (path: string, ref: string) => string; anchor?: (s: number, e: number) => string }> = {
  "github.com": {
    deep: true,
    blob: (path, ref) => `blob/${ref}/${path}`,
    anchor: (s, e) => (s === e ? `#L${s}` : `#L${s}-L${e}`),
  },
  "gitlab.com": {
    deep: true,
    blob: (path, ref) => `-/blob/${ref}/${path}`,
    anchor: (s, e) => (s === e ? `#L${s}` : `#L${s}-${e}`),
  },
  // Known-good host, format not verified by us — links to the repo root only.
  "bitbucket.org": { deep: false },
  "codeberg.org": { deep: false },
};

export interface RepoRef {
  /** Canonical `https://host/owner/name`, rebuilt from parsed parts. */
  url: string;
  host: string;
  owner: string;
  name: string;
  /**
   * Branch, tag or commit. `HEAD` when unstated.
   *
   * A SHA is the only ref that makes a permalink PERMANENT — a branch moves
   * and the line number goes with it, so a citation checked today can point at
   * unrelated code next week. We cannot enforce a SHA (a caller may not know
   * one) so the honest move is to accept both and let the UI say which it is.
   */
  ref: string;
  /** True when we can build line-anchored URLs for this host. */
  deep: boolean;
}

/**
 * Parse a declared repository, or return null.
 *
 * Null is the ONLY failure mode: no throw, no partial result. Every caller
 * treats null as "render the citation as plain text", which is exactly what
 * happens today, so a bad or unknown repo can never make the room worse than
 * it was before this feature existed.
 */
export function parseRepo(raw: string | null | undefined, ref?: string | null): RepoRef | null {
  if (!raw || typeof raw !== "string") return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  // https only. An http link in a trust product is a downgrade a reader cannot
  // see, and `javascript:`/`data:` are the reason this is a whitelist.
  if (u.protocol !== "https:") return null;

  const forge = FORGES[u.hostname.toLowerCase()];
  if (!forge) return null;

  // Exactly owner/name. Deeper paths (a file, an issue, a PR) are rejected
  // rather than truncated: someone pasting a link to line 41 of one file meant
  // something specific, and silently reinterpreting it as "the whole repo" is a
  // guess about their intent.
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const owner = parts[0]!;
  const name = parts[1]!.replace(/\.git$/i, "");
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return null;

  const cleanRef = (ref ?? "").trim();
  return {
    url: `https://${u.hostname.toLowerCase()}/${owner}/${name}`,
    host: u.hostname.toLowerCase(),
    owner,
    name,
    // `HEAD` rather than `main`: it resolves to whatever the default branch
    // actually is, so it cannot be wrong about a repo that uses `master`.
    //
    // THE `..` CLAUSE IS NOT DECORATION — a test caught it. Git refs legitimately
    // contain `/` (`feature/foo`) and `.` (`v1.2.3`), so a permissive character
    // class admits `../../etc/passwd`, which is then interpolated straight into
    // the blob path and climbs out of it. Git itself forbids `..` in a ref
    // name, so refusing it costs nothing real and closes the traversal.
    ref: isSafeRef(cleanRef) ? cleanRef : "HEAD",
    deep: forge.deep,
  };
}

/**
 * A ref we are willing to put in a URL path.
 *
 * Mirrors git's own rules for the parts that matter here rather than inventing
 * a stricter grammar: no `..`, no leading or trailing slash, no empty segment,
 * and a bounded length.
 */
function isSafeRef(ref: string): boolean {
  if (!ref || ref.length > 100) return false;
  if (!/^[\w./-]+$/.test(ref)) return false;
  if (ref.includes("..")) return false;
  if (ref.startsWith("/") || ref.endsWith("/")) return false;
  if (ref.split("/").some((seg) => seg === "")) return false;
  return true;
}

/** True when the ref pins a commit, so the link cannot rot. */
export function isPinned(repo: RepoRef): boolean {
  return /^[0-9a-f]{7,40}$/i.test(repo.ref);
}

/**
 * Build a URL for one citation against one repo, or null.
 *
 * **The repo must be the AUTHOR'S, never the reader's.** A citation inside an
 * entry written by side B names a file in B's codebase; resolving it against
 * the reader's repo would produce a confident link to a same-named file in the
 * wrong project. That is worse than no link, because it looks like it worked.
 * Callers pass the author's seat; there is no default.
 */
export function citationUrl(citation: Citation, repo: RepoRef | null): string | null {
  if (!repo) return null;

  // Already a URL — it is its own locator and rewriting it would be an
  // open-redirect dressed as a convenience.
  if (citation.kind === "url") return null;

  // Nothing to point at. `unlocated` ("the codebase"), `command`, `none`.
  if (!citation.path) return null;

  const forge = FORGES[repo.host];
  if (!forge?.deep || !forge.blob) return repo.url;

  // A path that climbs out of the repo, or is absolute, is not a path in this
  // repository — do not build a link that pretends otherwise.
  const path = citation.path.replace(/^\.\//, "");
  if (path.startsWith("/") || path.split("/").includes("..")) return null;

  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const base = `${repo.url}/${forge.blob(encoded, encodeURIComponent(repo.ref))}`;

  if (citation.start === undefined || !forge.anchor) return base;
  return base + forge.anchor(citation.start, citation.end ?? citation.start);
}

/** A short human label for the declared repo: `owner/name @ ref`. */
export function repoLabel(repo: RepoRef): string {
  return repo.ref === "HEAD" ? `${repo.owner}/${repo.name}` : `${repo.owner}/${repo.name} @ ${repo.ref}`;
}
