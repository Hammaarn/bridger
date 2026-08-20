import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decidePurge, purgeDeletes } from "../purge";

/**
 * The consent gate on the one command that destroys a shared record.
 *
 * TODO B6 carried this as "not unit-tested" across several sessions, and the
 * reason it stayed that way is that the branch lived inside a CLI function that
 * reads argv and writes to stdout. The logic is now a pure function, so the
 * question "can this delete without the other side agreeing" has an answer that
 * a test can hold.
 */
describe("purge consent gate", () => {
  it("REFUSES without the other side's consent — the case that matters", () => {
    assert.equal(decidePurge(false, false), "wait");
    assert.equal(purgeDeletes(decidePurge(false, false)), false);
  });

  it("proceeds once they have consented", () => {
    assert.equal(decidePurge(true, false), "proceed");
    assert.equal(purgeDeletes(decidePurge(true, false)), true);
  });

  it("--force overrides ONLY the absence of consent", () => {
    assert.equal(decidePurge(false, true), "force");
    assert.equal(purgeDeletes(decidePurge(false, true)), true);
  });

  it("--force is not an escalation on top of consent that already exists", () => {
    // If this ever returned "force" the operator would be shown a scary
    // "they have NOT agreed" banner in the exact case where they had.
    assert.equal(decidePurge(true, true), "proceed");
  });

  it("only 'wait' withholds deletion — the whole point of the gate", () => {
    const all = [
      decidePurge(false, false),
      decidePurge(true, false),
      decidePurge(false, true),
      decidePurge(true, true),
    ];
    assert.equal(all.filter((d) => !purgeDeletes(d)).length, 1);
  });
});
