import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyCitation,
  describeCitation,
  isUnlocated,
  isWideRange,
  WIDE_RANGE_LINES,
} from "../citation";

describe("citation — the two real S#271 citations, which is why this exists", () => {
  it("separates the pinpoint from the over-broad one", () => {
    // Audited by hand in S#271: one landed exactly, the other covered 70 lines
    // and only glancingly touched the claim. The verdict was over-broad, NOT
    // fabricated — and nothing in the product could show the difference.
    const tight = classifyCitation("CLAUDE.md:29");
    const broad = classifyCitation("plans/05-ux-architecture.md:925-994");

    assert.equal(tight.kind, "line");
    assert.equal(tight.lines, 1);

    assert.equal(broad.kind, "range");
    assert.equal(broad.lines, 70, "994-925 inclusive is 70 lines");
    assert.ok(isWideRange(broad), "70 lines should read as worth a second look");
    assert.ok(!isWideRange(tight));
  });

  it("the other real one: CLAUDE.md:21-29 is a 9-line range, not a pinpoint", () => {
    const c = classifyCitation("CLAUDE.md:21-29");
    assert.equal(c.kind, "range");
    assert.equal(c.lines, 9);
    assert.ok(!isWideRange(c), "9 lines is narrow enough not to flag");
  });
});

describe("citation — classification", () => {
  const cases: Array<[string | null | undefined, string]> = [
    ["lib/external/usage-report.ts:41", "line"],
    ["lib/store.ts:41-58", "range"],
    ["lib/store.ts", "file"],
    ["app/api/mcp/route.ts", "file"],
    ["GET /api/health", "command"],
    ["POST /api/rpc", "command"],
    ["npm run check", "command"],
    ["curl -s https://bridger-nu.vercel.app/api/health", "command"],
    ["$ git log -1", "command"],
    ["4956820", "commit"],
    ["e1619d4f2a1b3c4d5e6f7a8b9c0d1e2f3a4b5c6d", "commit"],
    ["the codebase", "unlocated"],
    ["our docs", "unlocated"],
    ["I checked with the team", "unlocated"],
    [null, "none"],
    [undefined, "none"],
    ["", "none"],
    ["   ", "none"],
  ];

  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${expected}`, () => {
      assert.equal(classifyCitation(input).kind, expected);
    });
  }
});

describe("citation — the traps", () => {
  it("an entry id is NOT a file citation", () => {
    // `NOR-Q-003:1` has the shape of path:line. An id is not evidence, and
    // requiring a file extension is what keeps it out.
    assert.equal(classifyCitation("NOR-Q-003:1").kind, "unlocated");
    assert.equal(classifyCitation("JMS-Q-001").kind, "unlocated");
  });

  it("a command that contains something locator-shaped stays a command", () => {
    const c = classifyCitation("curl https://x.example/api/v1.json:8080");
    assert.equal(c.kind, "command", "the locator pattern must not claim a URL tail");
  });

  it("a reversed range reports its width, never a negative or zero", () => {
    const c = classifyCitation("lib/store.ts:90-10");
    assert.equal(c.kind, "range");
    assert.equal(c.lines, 81);
    assert.ok((c.lines ?? 0) > 0);
  });

  it("start === end is a single line, not a zero-width range", () => {
    const c = classifyCitation("lib/store.ts:41-41");
    assert.equal(c.kind, "line");
    assert.equal(c.lines, 1);
  });

  it("an en-dash range parses — models emit them", () => {
    const c = classifyCitation("lib/store.ts:10–20");
    assert.equal(c.kind, "range");
    assert.equal(c.lines, 11);
  });

  it("is TOTAL — no input throws, because a thrown classifier would stop the ledger rendering", () => {
    for (const weird of ["🙂", "a".repeat(5000), "::::", "1:2:3:4", "../../etc/passwd", "\n\t"]) {
      assert.doesNotThrow(() => classifyCitation(weird));
      assert.ok(classifyCitation(weird).kind, "every input must yield a kind");
    }
  });

  it("keeps `raw` byte-identical — the human always sees what was actually written", () => {
    const raw = "  lib/store.ts:41  ";
    assert.equal(classifyCitation(raw).raw, raw);
  });
});

describe("citation — labels state WHAT WAS CITED, never a verdict on the answer", () => {
  it("describes the span as a fact", () => {
    assert.equal(describeCitation(classifyCitation("a.ts:41")), "exact line");
    assert.equal(describeCitation(classifyCitation("a.ts:1-70")), "70 lines");
    assert.equal(describeCitation(classifyCitation("a.ts")), "whole file");
    assert.equal(describeCitation(classifyCitation(null)), "unchecked");
  });

  it("never emits a quality word", () => {
    // The guardrail: a regex may not call an answer good, weak, or verified.
    // If someone adds such a label later, this fails and they have to argue for
    // it deliberately rather than sliding it in.
    const verdicts = /\b(good|bad|weak|strong|poor|verified|trusted|reliable|accurate|correct|proven)\b/i;
    const samples = ["a.ts:41", "a.ts:1-900", "a.ts", "GET /x", "abc1234", "the codebase", null];
    for (const s of samples) {
      const label = describeCitation(classifyCitation(s));
      assert.ok(!verdicts.test(label), `label "${label}" reads as a verdict on the claim`);
    }
  });

  it("`none` is not lumped in with `unlocated` — the distinction is the honest part", () => {
    // "unchecked" is an honest admission. "the codebase" is a confident-sounding
    // non-answer. Collapsing them would hide exactly the wrong one.
    assert.ok(!isUnlocated(classifyCitation(null)));
    assert.ok(isUnlocated(classifyCitation("the codebase")));
  });

  it("the wide-range threshold is a named constant, not a magic number", () => {
    assert.equal(typeof WIDE_RANGE_LINES, "number");
    const atThreshold = classifyCitation(`a.ts:1-${WIDE_RANGE_LINES}`);
    assert.ok(isWideRange(atThreshold), "the threshold is inclusive");
  });
});

describe("citation — web sources, found by a real answer being graded 'whole file'", () => {
  // THE ACTUAL REGRESSION, verbatim from a real partner room.
  // It cited five news and archive domains and the record rendered it as
  // "whole file" — claiming a document in this repo. That is a false fact about
  // the string, which is the one thing this module promises not to state.
  const REAL = [
    "2 web searches, result summaries only; no primary source opened.",
    "Caernarvon 1927: 1927flood.lthp.org, 64parishes.org, smithsonianmag.com",
    "-- agree on the deliberate dynamiting. Valencia: tribunaldelasaguas.org,",
    "visitvalencia.com + ABSTRACT ONLY of 'Not only peasants'.",
  ].join(" ");

  it("the string that caused this is a web source, NOT 'whole file'", () => {
    const c = classifyCitation(REAL);
    assert.equal(c.kind, "url");
    assert.equal(describeCitation(c), "web source");
    assert.notEqual(describeCitation(c), "whole file", "the bug this test exists for");
  });

  it("bare hosts and full URLs both classify", () => {
    for (const s of [
      "example.org",
      "1927flood.lthp.org",
      "https://bridger-nu.vercel.app/api/about",
      "www.example.com/a/b",
      "see tribunaldelasaguas.org for the ordinances",
    ]) {
      assert.equal(classifyCitation(s).kind, "url", `${s} should read as a web source`);
    }
  });

  it("a web source is LOCATED — you can go and look, it is just not on disk", () => {
    assert.ok(!isUnlocated(classifyCitation("example.org")));
  });

  // The regression guard that matters more than the fix. Being wrong in this
  // direction sends a reader to the web for something sitting on disk, and they
  // cannot find it at all.
  it("SOURCE FILES ARE NOT WEBSITES — .ts must never be read as Tonga", () => {
    for (const [s, expected] of [
      ["lib/store.ts", "file"],
      ["app/api/mcp/route.ts", "file"],
      ["lib/citation.ts:41", "line"],
      ["lib/store.ts:41-58", "range"],
      ["package.json", "file"],
      ["app/globals.css", "file"],
      ["skill/SKILL.md", "file"],
    ] as const) {
      assert.equal(classifyCitation(s).kind, expected, `${s} must stay ${expected}`);
    }
  });

  it("precedence holds: a command stays a command, a locator stays a locator", () => {
    assert.equal(
      classifyCitation("curl -s https://bridger-nu.vercel.app/api/health").kind,
      "command",
      "a URL inside a command must not demote it to a bare web source",
    );
    assert.equal(
      classifyCitation("lib/entries.ts:215 and also example.org").kind,
      "line",
      "the more specific on-disk locator wins over a domain later in the string",
    );
  });

  it("does not truncate a TLD out of a longer word", () => {
    // `example.company` must not be read as `example.com` + "pany". It lands on
    // `file` instead, via the PRE-EXISTING FILE_RE, which accepts any 1-12 char
    // extension — a looseness that predates this change and is deliberately not
    // fixed here. What is asserted is only the boundary: not a web source.
    assert.notEqual(classifyCitation("example.company").kind, "url");
    assert.equal(classifyCitation("the network").kind, "unlocated", "no dot, no locator");
  });

  it("the new label is not a verdict either", () => {
    const verdicts = /\b(good|bad|weak|strong|poor|verified|trusted|reliable|accurate|correct|proven)\b/i;
    assert.ok(!verdicts.test(describeCitation(classifyCitation("example.org"))));
  });
});

describe("[!!] a citation that MENTIONS a domain is prose, not a web source (S#284)", () => {
  // Found live, in the real partner room, the hour the evidence index
  // shipped: four of seven citations were graded "web source" because a
  // sentence happened to contain a domain.
  //
  // The mislabel was not the harm. `isUnlocated` fires only on `unlocated`, so
  // these long vague citations ESCAPED the weak flag while an honest
  // three-word "the codebase" got flagged -- the vaguest citations in the room
  // rendering as STRONGER than the modest ones. A gesture presented as a
  // pointer, inside the classifier written to prevent exactly that.
  const LIVE = {
    prodLogs:
      "Production runtime logs, act1 capture durations: rid=mt3f7rk3 and rid=mt3glpuk (headless.design, deployments)",
    ghCommand:
      "gh repo view --json visibility,name,owner on Hammaarn/judgemysite -> PRIVATE. curl of https://judgemysite.org/",
    localRuns: "Local runs against localhost:3312 /api/dev/live-review with mock=1",
  };

  it("prose mentioning a domain falls through to unlocated", () => {
    assert.equal(classifyCitation(LIVE.prodLogs).kind, "unlocated");
    assert.equal(classifyCitation(LIVE.localRuns).kind, "unlocated");
  });

  it("[!!] and therefore reads as WEAK, which is the whole point", () => {
    assert.ok(isUnlocated(classifyCitation(LIVE.prodLogs)), "a paragraph naming no locator is a gesture");
    assert.ok(isUnlocated(classifyCitation(LIVE.localRuns)));
  });

  it("`gh` is a command someone ran, not a web source", () => {
    // It was falling through to URL because a tool this codebase uses
    // constantly was simply missing from COMMAND_RE.
    assert.equal(classifyCitation(LIVE.ghCommand).kind, "command");
  });

  it("NEGATIVE CONTROL: a short phrase around a domain is still a web source", () => {
    // Anchoring alone would have broken this, and the suite caught it. You can
    // go and look at tribunaldelasaguas.org; that is a located source.
    assert.equal(classifyCitation("see tribunaldelasaguas.org for the ordinances").kind, "url");
  });

  it("[!!] a domain that no longer dominates must not become a FILE either", () => {
    // The regression this fix ITSELF shipped, caught by reading the live index
    // an hour later: `kernbot.com` appeared in the integration surface as a
    // file in somebody's repository. A bare domain has exactly the shape of a
    // path with an extension, so once the url rule stopped claiming it, FILE_RE
    // did -- reproducing the identical false fact the url rule exists to stop.
    // FILE_RE now excludes web TLDs, so the guarantee no longer depends on
    // which rule happens to run first.
    const c = classifyCitation(
      "Local runs against kernbot.com and the dev server with mock=1, durations read from the log afterwards",
    );
    assert.equal(c.kind, "unlocated");
    assert.equal(c.path, undefined, "a domain must never enter the file surface");
  });

  it("[!!] a hostname must not enter the file surface, whatever its TLD", () => {
    // Two fixes deep: excluding web TLDs was not enough, because the TLD list
    // can never be complete -- `headless.design` survived it and reached the
    // live surface. The structural rule is what holds: a separator-less token
    // needs a recognised SOURCE extension to be a file.
    for (const s of [
      "Runs against headless.design and the dev server, durations read from the log afterwards",
      "Local runs against kernbot.com and the dev server with mock=1, durations from the log",
    ]) {
      const c = classifyCitation(s);
      assert.equal(c.kind, "unlocated", s);
      assert.equal(c.path, undefined, "no hostname may be reported as a path");
    }
  });

  it("NEGATIVE CONTROL: a bare domain cited ALONE is still a web source", () => {
    for (const s of ["headless.design", "kernbot.com", "1927flood.lthp.org"]) {
      assert.equal(classifyCitation(s).kind, "url", s);
    }
  });

  it("NEGATIVE CONTROL: extensions that double as TLDs stay files", () => {
    // .sh, .rs, .py, .pl are all real country TLDs and all real source
    // extensions. They are deliberately absent from WEB_TLDS for that reason.
    for (const s of ["scripts/deploy.sh", "src/main.rs", "app.py", "lib/store.ts"]) {
      assert.equal(classifyCitation(s).kind, "file", s);
    }
  });

  it("NEGATIVE CONTROL: real source files are untouched by that exclusion", () => {
    for (const [s, expected] of [
      ["lib/store.ts", "file"],
      ["package.json", "file"],
      ["app/globals.css", "file"],
      ["Read before writing: lib/characters/elitist.ts (identity line)", "file"],
    ] as const) {
      assert.equal(classifyCitation(s).kind, expected, `${s} must stay ${expected}`);
    }
  });

  it("NEGATIVE CONTROL: coverage is measured across ALL urls, not the first", () => {
    // The five-domain regression string scores 8% on its first match and ~43%
    // on the total. Judged on the first alone it falls back to "whole file" --
    // the exact bug the suite above exists for.
    const five =
      "notes: alpha.org, beta.org, gamma.org, delta.org, epsilon.org and some trailing commentary here";
    assert.equal(classifyCitation(five).kind, "url");
  });
});
