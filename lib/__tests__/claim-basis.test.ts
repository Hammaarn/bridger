import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OperationRefused, requireHonestBasis, wire } from "../operations";
import type { Entry } from "../entries";

/**
 * The rule a foreign client asked us for, after demonstrating why it is needed.
 *
 * Asked whether the tool was worth using — a judgement — it attached
 * `checkedAgainst: contract.md:5-15`, and then explained itself better than we
 * could have: "'UNCHECKED' carries a negative penalty signal... so the model
 * reflexively grabbed a contract line to fill the slot." Two states made an
 * honest opinion look like a lapse, so the cheapest escape was fake provenance.
 */

const entry = (over: Partial<Entry>): Entry => ({
  id: "AAA-N-001",
  seq: 1,
  type: "note",
  side: "a",
  code: "AAA",
  author: "A",
  ts: "2026-08-21T00:00:00.000Z",
  title: "t",
  body: "b",
  answers: null,
  why: null,
  checkedAgainst: null,
  basis: null,
  ...over,
});

describe("claim basis", () => {
  it("REFUSES an opinion that carries a citation — the whole point", () => {
    assert.throws(
      () => requireHonestBasis("opinion", "contract.md:5-15"),
      (e: unknown) => e instanceof OperationRefused && e.terminal,
    );
  });

  it("is TERMINAL, so a caller does not retry the same payload on its own budget", () => {
    try {
      requireHonestBasis("opinion", "a.ts:1");
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal((e as OperationRefused).terminal, true);
    }
  });

  it("allows an opinion with no citation", () => {
    assert.doesNotThrow(() => requireHonestBasis("opinion", undefined));
  });

  it("allows a citation when no basis is declared — nothing that already worked changes", () => {
    assert.doesNotThrow(() => requireHonestBasis(null, "src/a.ts:1-9"));
    assert.doesNotThrow(() => requireHonestBasis(undefined, "src/a.ts:1-9"));
  });

  it("allows `inference` WITH a citation — it is reasoning FROM something", () => {
    // Deliberately not symmetric with `opinion`. An inference can legitimately
    // name what it reasoned from; an opinion cannot be checked against a file.
    assert.doesNotThrow(() => requireHonestBasis("inference", "src/a.ts:1-9"));
  });

  it("renders three distinct readings, so opinion never looks like a lapse", () => {
    assert.match(wire(entry({ checkedAgainst: "a.ts:1" })).checked, /^checked-against:/);
    assert.equal(wire(entry({ basis: "opinion" })).checked, "opinion — no citation expected");
    assert.equal(wire(entry({ basis: "inference" })).checked, "inference — reasoned, not read");
    assert.equal(wire(entry({})).checked, "unchecked");
  });

  it("an unsourced factual claim and a declared opinion no longer read the same", () => {
    assert.notEqual(wire(entry({})).checked, wire(entry({ basis: "opinion" })).checked);
  });
});
