import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { trailGuidance } from "../room-registry";

/**
 * The rule is pure and the whole point is that it fires on ONE observed
 * behaviour and stays quiet otherwise, so the negative cases carry as much
 * weight here as the positive one. A guidance rule that fires on everything
 * trains the field to ignore `guidance`, which would cost us the only channel
 * that reaches a partner already holding a frozen join document.
 */
describe("field guidance — the habit the first real far side actually showed", () => {
  it("fires on the observed pattern: status and read, alternating, never ping", () => {
    // A real room, 2026-08-21: four questions answered with status+read
    // five times each, an hour after we shipped a document pointing at ping.
    const advice = trailGuidance("srsrsr");
    assert.ok(advice, "the pattern that cost 8x the bytes should say so");
    assert.match(advice, /bridger_ping/, "advice that does not name the tool is not advice");
  });

  it("says nothing to a caller who has pinged — compliance ends the lecture", () => {
    // This is what keeps `guidance` worth reading. The trail is otherwise
    // identical to the case above; the single `p` is the whole difference.
    assert.equal(trailGuidance("srsrp"), null);
    assert.equal(trailGuidance("psrsr"), null, "a ping anywhere in the window counts");
  });

  it("stays quiet on ordinary use, so the field does not learn to ignore it", () => {
    assert.equal(trailGuidance(""), null, "a first call knows nothing about you");
    assert.equal(trailGuidance("s"), null);
    assert.equal(trailGuidance("sr"), null, "one of each is not a habit");
    assert.equal(trailGuidance("ssss"), null, "status alone is the idle brake's business, not this rule's");
    assert.equal(trailGuidance("rrrr"), null, "read alone is somebody paging through the record");
  });

  it("needs two of EACH, which is what makes it a pattern rather than a count", () => {
    assert.equal(trailGuidance("sssr"), null, "three status and one read is not alternating");
    assert.ok(trailGuidance("ssrr"), "two of each is the shape, in any order");
  });
});
