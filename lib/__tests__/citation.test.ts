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
    // `TRI-Q-003:1` has the shape of path:line. An id is not evidence, and
    // requiring a file extension is what keeps it out.
    assert.equal(classifyCitation("TRI-Q-003:1").kind, "unlocated");
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
