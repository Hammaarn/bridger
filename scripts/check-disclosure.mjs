#!/usr/bin/env node
/**
 * WHAT GOES OUT OF THIS REPO, CHECKED BY A SCRIPT RATHER THAN BY REMEMBERING.
 *
 * This repository is PUBLIC and its whole pitch is that a stranger can read it
 * before trusting the service. That is a feature, and it is also why a leak here
 * is not recoverable: a clone is a copy, and history keeps what HEAD drops.
 *
 * THE LINE, and it is not "publish less":
 *
 *     Publish our reasoning. Do NOT publish third parties, another product's
 *     internals, or live operational identifiers.
 *
 * Being open about how Bridger works and why is on-brand. Naming a partner
 * company that never agreed to it, shipping another product's file paths, or
 * printing a live room id are all disclosures that are not ours to make.
 *
 * TWO TIERS, because one strict rule would be unusable.
 *
 *   SHIPPING surfaces - code, README, VERIFY, SECURITY, the landing page, the
 *   MCP tool schemas. A stranger and their agent read these as instruction, so
 *   they get the strict rules. A partner name in a tool `describe()` string is
 *   the widest exposure in the repo: it lands in every agent that lists our
 *   tools, in someone else's model context.
 *
 *   HISTORY - plans/, ARCHITECTURE. The record of how it was built.
 *   [S#290] DECISIONS, STATUS and TODO moved OUT of this class into FORBIDDEN --
 *   they must not be tracked at all. They were the record of how the
 *   thing was built, they are meant to be readable, and holding them to the
 *   shipping rules would flag hundreds of legitimate lines and get the whole
 *   check switched off. They are scanned for the things that are dangerous
 *   ANYWHERE: credentials, and another product's internals.
 *
 * WHY THE NAME LIST IS NOT IN THIS FILE. A committed list of "names that must
 * not appear" would publish exactly the names it protects. So the list lives in
 * `.disclosure-names.local.json`, which is gitignored, and this script REFUSES
 * TO PASS QUIETLY without it - a missing list is reported as a gap, never as a
 * clean run. Absence and emptiness must not render the same.
 *
 * Usage:
 *   node scripts/check-disclosure.mjs            # scan the working tree
 *   node scripts/check-disclosure.mjs --selftest # prove it fires, and that it
 *                                                # stays silent on clean input
 */

import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const ROOT = process.cwd();
const NAMES_FILE = ".disclosure-names.local.json";

/** Files a stranger or their agent reads as instruction. */
const SHIPPING = [
  /^README\.md$/,
  /^VERIFY\.md$/,
  /^SECURITY\.md$/,
  /^NOTICE$/,
  /^AGENTS\.md$/,
  /^app\/.*\.(ts|tsx)$/,
  // Tests included DELIBERATELY, and they were not at first. The reasoning for
  // excluding them was "nobody reads a test as instruction", which is true and
  // beside the point: they are tracked, so they are published, and fixture data
  // naming a real company is the same exposure as a README sample. The armed
  // name check found 26 occurrences across 15 test files the moment the list
  // was switched on -- a hole the tiering had created by reasoning about how a
  // file is READ rather than whether it is PUBLISHED.
  /^lib\/.*\.ts$/,
  /^cli\/.*\.ts$/,
  /^integrations\/.*$/,
  /^skill\/.*$/,
];

/** The record of how it was built. Scanned for the always-dangerous only. */
const HISTORY = [/^DECISIONS\.md$/, /^STATUS\.md$/, /^TODO\.md$/, /^plans\//, /^ARCHITECTURE\.md$/];

/**
 * PUBLICATION-FORBIDDEN. This is NOT "scan these harder" -- these must not be
 * TRACKED AT ALL, and a content scan can never establish that.
 *
 * Gaveled S#286 (DECISIONS.md, gavel 3), Erik verbatim:
 *   "Remove it and make sure docs like that aren't pushed to a public viewing,
 *    this is our internal stuff, worst case scenario they can leak API keys"
 *
 * That gavel also named where the rule belongs: *"the rule needs enforcement in
 * scripts/check-disclosure.mjs / npm run check, not a habit. A habit is what
 * produced 365 KB."* This block is that enforcement, added S#290 -- four days
 * later the files were still tracked, which is the argument for a gate rather
 * than an intention.
 *
 * Note what this replaces: these three were previously in HISTORY, an ACCEPTED
 * class with a written rationale, so the gate returned `clean` on precisely the
 * condition it was supposed to catch. A gate that permits the thing by name is
 * not an unenforced rule -- it is the opposite rule, enforced.
 *
 * NOT included, because the gavel did not name them -- Erik's call, not mine:
 *   `plans/` (9 files, ~105 KB tracked) and `ARCHITECTURE.md` (~38 KB).
 *   `ARCHITECTURE.md` is plausibly meant to be public; `plans/` is plausibly not.
 */
const FORBIDDEN = [
  { re: /^DECISIONS\.md$/, why: "internal decision log" },
  { re: /^STATUS\.md$/, why: "internal status log" },
  { re: /^TODO\.md$/, why: "internal working notes" },
];

/**
 * Dangerous ANYWHERE. Deliberately shape-based, never entropy-based: this repo
 * is full of commit shas and file paths on purpose, and a scanner that refuses
 * provenance is worse than no scanner (the same trade `lib/secrets.ts` makes).
 */
const ALWAYS = [
  { id: "bridger-token", re: /\bbr_live_[A-Za-z0-9_-]{16,}/, why: "a live Bridger credential" },
  { id: "provider-key", re: /\b(sk-ant-|sk-proj-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{16,}/, why: "a provider credential" },
  { id: "private-key", re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, why: "a private key" },
  {
    id: "url-credential",
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/i,
    why: "credentials in a URL",
    // This file and `lib/secrets.ts` both DESCRIBE the shape in prose, and a
    // scanner that fires on the documentation of its own detector is noise.
    // Real credentials are not spelled `user:pass`.
    skip: (line) => /user:pass|username:password|USER:PASS|<user>:<pass>/.test(line),
  },
  {
    id: "foreign-repo-path",
    re: /\b(?:roastmydev|judgemysite)\/(?:app|lib|src|scripts|plans)\//i,
    why: "another product's internal file path",
  },
  {
    id: "home-path",
    re: /(?:[A-Za-z]:[\\/]Users[\\/]|\/(?:home|Users)\/)[A-Za-z0-9._-]+[\\/]/,
    why: "an operator's local filesystem path",
  },
];

/** Strict, shipping surfaces only. */
const SHIPPING_ONLY = [
  {
    id: "room-id",
    re: /\b[0-9a-f]{12}\b/,
    why: "what looks like a live room id (12 hex)",
    // Commit shas are 7 or 40; a 12-hex run in shipping code is a room id.
    skip: (line) => /commit|sha|deployment|hash|chain|digest/i.test(line),
  },
];

const read = (p) => {
  try {
    return readFileSync(join(ROOT, p), "utf8");
  } catch {
    return null;
  }
};

function trackedFiles() {
  const out = execSync("git ls-files", { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

function loadNames() {
  if (!existsSync(join(ROOT, NAMES_FILE))) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(ROOT, NAMES_FILE), "utf8"));
    const names = Array.isArray(parsed) ? parsed : parsed.names;
    if (!Array.isArray(names)) return null;
    return names.map(String).filter((n) => n.length >= 3);
  } catch {
    return null;
  }
}

function classify(path) {
  if (SHIPPING.some((re) => re.test(path))) return "shipping";
  if (HISTORY.some((re) => re.test(path))) return "history";
  return "other";
}

/**
 * THE ESCAPE HATCH, and why it is a marker rather than a config list.
 *
 * Some lines legitimately look like the thing they are not: a synthetic room id
 * in a documentation example has to be shaped like a real one to be useful. The
 * exemption is therefore written ON the line, next to the reason, where a
 * reviewer reading the code sees it — not in a distant allowlist that nobody
 * opens. Every use is one `grep` away, and the run prints the count so a
 * codebase cannot quietly fill up with them.
 */
const OK_MARKER = /disclosure-ok:/;

export function scanText(path, text, tier, names) {
  const findings = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((line, i) => {
    // On the line, or on the one directly above it. Both, because a flagged
    // line is often inside a string array or a template where an inline
    // comment cannot go — which is exactly the case that produced this rule.
    if (OK_MARKER.test(line) || (i > 0 && OK_MARKER.test(lines[i - 1]))) return;
    for (const rule of ALWAYS) {
      if (rule.skip?.(line)) continue;
      if (rule.re.test(line)) findings.push({ path, line: i + 1, id: rule.id, why: rule.why });
    }
    if (tier === "shipping") {
      for (const rule of SHIPPING_ONLY) {
        if (rule.skip?.(line)) continue;
        if (rule.re.test(line)) findings.push({ path, line: i + 1, id: rule.id, why: rule.why });
      }
      for (const name of names ?? []) {
        if (line.includes(name)) {
          findings.push({
            path,
            line: i + 1,
            id: "third-party-name",
            why: `a third party named on a surface strangers read (${name.slice(0, 2)}…)`,
          });
        }
      }
    }
  });

  return findings;
}

function selftest() {
  const cases = [
    // [tier, text, mustFire]
    ["shipping", "const t = 'br_" + "live_" + "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9v';", true],
    ["shipping", "see roastmydev/app/api/external/live-review/route.ts:88", true],
    ["history", "see roastmydev/lib/review-contract.ts", true],
    ["shipping", "room ROOM_REDACTED_A is live", true],
    ["shipping", "at C:/Users/someone/Documents/thing", true],
    // Negative controls: these MUST stay silent or the check is unusable.
    ["shipping", "production is commit e1619d4, master is f625352", false],
    ["shipping", "the deployment sha 40b2868a1c2d was verified", false],
    ["history", "Northwind asked about the 422 path", false],
    ["shipping", "read lib/store.ts:466 for the TTL", false],
    ["shipping", "curl -s https://bridger.nexus/api/about", false],
  ];

  let bad = 0;
  for (const [tier, text, mustFire] of cases) {
    const fired = scanText("selftest", text, tier, ["Northwind"]).length > 0;
    const ok = fired === mustFire;
    if (!ok) bad++;
    console.log(`${ok ? "  ok  " : "  FAIL"} [${tier}] fired=${fired} want=${mustFire}  ${text.slice(0, 56)}`);
  }
  // The third-party name must fire on a SHIPPING surface, and not in history.
  const nameFires = scanText("x", "label e.g. 'Northwind'", "shipping", ["Northwind"]).length > 0;
  if (!nameFires) {
    console.log("  FAIL third-party name did not fire on a shipping surface");
    bad++;
  } else {
    console.log("  ok   third-party name fires on shipping, silent in history");
  }

  console.log(bad === 0 ? "\nselftest: PASS" : `\nselftest: ${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}

function main() {
  if (process.argv.includes("--selftest")) return selftest();

  const names = loadNames();
  const files = trackedFiles();

  // STRUCTURAL CHECK, before any content scan: a publication-forbidden file must
  // not be tracked. Content is irrelevant here -- tracked means published.
  const leaked = files.filter((f) => FORBIDDEN.some((x) => x.re.test(f)));
  if (leaked.length > 0) {
    console.error(`check-disclosure: ${leaked.length} PUBLICATION-FORBIDDEN file(s) are tracked.
`);
    for (const f of leaked) {
      const why = FORBIDDEN.find((x) => x.re.test(f)).why;
      console.error(`  ${f}  -- ${why}`);
    }
    console.error(
      `
  Tracked means published. Gaveled S#286: "make sure docs like that aren't
` +
        `  pushed to a public viewing ... worst case scenario they can leak API keys".

` +
        `  To fix:  git rm --cached <file>   and add it to .gitignore
` +
        `  Removing them from the INDEX stops future publication; it does NOT remove
` +
        `  them from git HISTORY. That is the separate, gaveled history scrub.`,
    );
    process.exit(1);
  }

  // LIVENESS. A run that scanned nothing must never look like a clean run.
  if (files.length === 0) {
    console.error("check-disclosure: scanned ZERO files. This did not run properly.");
    process.exit(2);
  }

  const findings = [];
  let scanned = 0;
  let exemptions = 0;
  for (const f of files) {
    const tier = classify(f);
    if (tier === "other") continue;
    const text = read(f);
    if (text === null) continue;
    scanned++;
    exemptions += text.split(/\r?\n/).filter((l) => /disclosure-ok:/.test(l)).length;
    findings.push(...scanText(f, text, tier, names));
  }

  if (scanned === 0) {
    console.error("check-disclosure: matched ZERO shipping or history files. Check the patterns.");
    process.exit(2);
  }

  const missingNames = names === null;
  if (findings.length === 0) {
    console.log(
      `check-disclosure: clean (${scanned} files` +
        (exemptions ? `, ${exemptions} disclosure-ok exemption(s)` : "") +
        `)`,
    );
    if (missingNames) {
      console.log(
        `  [!] ${NAMES_FILE} is absent, so the third-party-name check DID NOT RUN.\n` +
          `      Structural checks passed on their own. Create it (gitignored) as\n` +
          `      ["Partner Name", "Other Co"] to switch the name check on.`,
      );
    }
    process.exit(0);
  }

  console.error(`\ncheck-disclosure: ${findings.length} finding(s) across ${scanned} files\n`);
  for (const f of findings) {
    console.error(`  ${f.path}:${f.line}  [${f.id}]  ${f.why}`);
  }
  console.error(
    `\nThe rule: publish our reasoning, not third parties, another product's\n` +
      `internals, or live operational identifiers. See the header of this file.\n` +
      `If a finding is wrong, fix the rule rather than deleting the check.\n`,
  );
  process.exit(1);
}

main();
