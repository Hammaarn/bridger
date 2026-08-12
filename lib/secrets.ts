/**
 * CREDENTIAL SCANNING on the write path.
 *
 * THE EXPOSURE. An entry written here goes to a third party's Redis, is read by
 * another company's session, and materialises via `bridger pull` into a
 * `bridger/` folder that both sides are encouraged to COMMIT. A credential that
 * lands in the ledger is therefore not "leaked to one place" — it is leaked to
 * two companies' disks and probably two git histories, and the record is
 * append-only, so it cannot be taken back. The only remedy after the fact is
 * rotation, on someone else's schedule.
 *
 * `skill/SKILL.md` already says "do not paste secrets". That is a rail, and the
 * agent it is aimed at may not even have the skill installed — the far side
 * gets the tool descriptions, not our repo. So the rule needed a mechanism.
 *
 * REFUSE, NOT REDACT — and the reasoning, because they are genuinely different
 * decisions and the wrong one is defensible-sounding:
 *
 *   - REDACT rewrites an author's words inside a record whose entire value is
 *     being a faithful account of what was said. It also still ships the
 *     original over the wire to Redis before anything is rewritten, so it does
 *     not even prevent the exposure it appears to prevent.
 *   - FLAG records the credential and adds a note next to it. That is the worst
 *     of the three: the secret is durably stored AND everyone is told it is
 *     there.
 *   - REFUSE costs the author one rewrite and loses nothing, because the entry
 *     was never appended. Append-only is not violated by refusing to append.
 *
 * So: refuse, and — unlike every other refusal in this codebase — say clearly
 * that retrying WORKS once the credential is removed. The STOP messages exist
 * to end loops; this one must not read like them, because the correct next
 * action really is to call again.
 *
 * NO ENTROPY HEURISTIC, and this is the load-bearing design choice.
 * ----------------------------------------------------------------
 * The obvious "high-entropy string" or "long hex" check would fire on exactly
 * what this bridge is FOR: `checkedAgainst` is meant to carry commit SHAs
 * (`commit a2b0f35`), file paths and endpoints. A scanner that refuses
 * provenance is worse than no scanner, because provenance is the product. So
 * this matches KNOWN CREDENTIAL SHAPES only — vendor prefixes and structural
 * formats — and accepts that it will miss a bespoke secret with no recognisable
 * shape. A missed secret is the failure mode we can live with; a blocked
 * citation is not.
 */

export interface SecretHit {
  /** What was matched, e.g. "Bridger room token". */
  kind: string;
  /** Which field it was found in. */
  field: string;
  /** A safe fragment: first 4 chars of the match, never the whole thing. */
  hint: string;
}

interface Pattern {
  kind: string;
  re: RegExp;
}

/**
 * Known credential shapes. Vendor prefixes and structural formats only.
 *
 * Every entry here is a shape that has essentially no legitimate reason to
 * appear in a question, an answer, a decision or a citation.
 */
const PATTERNS: Pattern[] = [
  // Ours first — a Bridger token in the Bridger ledger is self-inflicted, and
  // it would hand the reader the ability to speak as one of the sides.
  { kind: "Bridger room token", re: /\bbr_live_[A-Za-z0-9_-]{16,}/ },
  { kind: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: "OpenAI-style API key", re: /\bsk-(?!ant-)[A-Za-z0-9]{20,}/ },
  { kind: "GitHub token", re: /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { kind: "AWS access key id", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { kind: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "Stripe secret key", re: /\b[sr]k_live_[A-Za-z0-9]{16,}/ },
  // Three dot-separated base64url segments beginning with a JSON `{"` header.
  // Specific enough not to fire on ordinary base64 in prose.
  { kind: "JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { kind: "private key block", re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  // Credentials embedded in a URL — how Redis and Postgres strings usually leak.
  { kind: "URL with embedded credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/i },
  // `SOMETHING_TOKEN=<20+ chars>` / `SOMETHING_SECRET: "..."` — the env-var shape.
  {
    kind: "credential-shaped assignment",
    re: /\b[A-Z][A-Z0-9_]*(TOKEN|SECRET|PASSWORD|APIKEY|API_KEY|PRIVATE_KEY)\s*[=:]\s*["']?[A-Za-z0-9_\-./+]{20,}/,
  },
];

/**
 * Scan a set of named fields. Returns every distinct kind found, so one call
 * reports all the problems rather than making the author discover them one
 * refusal at a time.
 */
export function scanForSecrets(fields: Record<string, string | null | undefined>): SecretHit[] {
  const hits: SecretHit[] = [];
  const seen = new Set<string>();

  for (const [field, value] of Object.entries(fields)) {
    if (!value) continue;
    for (const { kind, re } of PATTERNS) {
      const m = re.exec(value);
      if (!m) continue;
      const key = `${field}:${kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ kind, field, hint: `${m[0].slice(0, 4)}...` });
    }
  }
  return hits;
}

/**
 * The refusal text.
 *
 * Deliberately NOT shaped like the STOP messages. Those end loops by saying
 * retrying cannot succeed; here retrying is precisely the right move, so the
 * message has to say so or a well-behaved agent will give up on a task it can
 * complete in one edit.
 */
export function secretRefusal(hits: SecretHit[]): string {
  const list = hits.map((h) => `${h.kind} in \`${h.field}\` (starts "${h.hint}")`).join("; ");
  return (
    `REFUSED: this entry looks like it contains a credential — ${list}. ` +
    `Nothing was written. This record is shared with another company, is append-only, and gets ` +
    `committed to both sides' repositories, so a secret written here cannot be taken back. ` +
    `Remove the credential and call this tool again — retrying WILL work once it is gone. ` +
    `If you need to refer to it, name where it lives (e.g. "the value in UPSTASH_REDIS_REST_TOKEN") ` +
    `rather than its value. If this was a false positive, rephrase so the value is not inline and ` +
    `tell your operator the scanner mis-fired.`
  );
}
