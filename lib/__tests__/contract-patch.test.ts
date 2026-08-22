import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseContract, patchContract, renderContract, describePatch } from "../contract-patch";

const CONTRACT = `Both sides build against this document.

## Auth

Bearer token in the Authorization header.

## Errors

4xx are terminal. 5xx may be retried.

## Rate limits

20 per minute.`;

describe("contract patching — the clobber the far side found", () => {
  it("the failure it exists to prevent: two sides, two sections, both survive", () => {
    // This is the whole point. Before this, side A writing Auth and side B
    // writing Errors meant whichever landed second erased the other's work, and
    // the document afterwards looked perfectly fine.
    const a = patchContract(CONTRACT, { Auth: "Bearer token, or mTLS on the pilot." });
    const b = patchContract(a.body, { Errors: "4xx terminal. 5xx retry with backoff." });

    assert.match(b.body, /mTLS on the pilot/, "side A's edit must survive side B's");
    assert.match(b.body, /retry with backoff/, "side B's edit must land");
    assert.match(b.body, /20 per minute/, "a section nobody touched is untouched");
    assert.match(b.body, /^Both sides build against this document\./, "the preamble is nobody's to patch");
  });

  it("an absent heading is left alone — that is the difference from a replace", () => {
    const r = patchContract(CONTRACT, { Auth: "changed" });
    const after = parseContract(r.body);
    assert.equal(after.sections.get("Errors"), "4xx are terminal. 5xx may be retried.");
    assert.equal(after.sections.get("Rate limits"), "20 per minute.");
    assert.deepEqual(r.changed, ["Auth"]);
  });

  it("null deletes, and a new heading appends in patch order (RFC 7386)", () => {
    const r = patchContract(CONTRACT, { Errors: null, Idempotency: "Idempotency-Key on every write." });
    assert.doesNotMatch(r.body, /## Errors/);
    assert.match(r.body, /## Idempotency/);
    assert.deepEqual(r.removed, ["Errors"]);
    assert.deepEqual(r.added, ["Idempotency"]);
  });

  it("reports a no-op instead of writing one", () => {
    // Appending "the contract was updated" to the ledger when it was not is the
    // kind of true-and-useless entry that makes a record tiring to read.
    const r = patchContract(CONTRACT, { Auth: "Bearer token in the Authorization header." });
    assert.equal(r.noop, true);
    assert.equal(describePatch(r), "no change");
  });

  it("deleting a heading that is not there is a no-op, not an error", () => {
    const r = patchContract(CONTRACT, { Nonexistent: null });
    assert.equal(r.noop, true);
    assert.equal(r.body, renderContract(parseContract(CONTRACT)));
  });

  it("round-trips a document with no headings at all", () => {
    // The contract that exists in most rooms today: free prose, no structure.
    // Patching it must not eat it.
    const plain = "We agree to ship the pilot on the 14th.";
    const r = patchContract(plain, { Scope: "Checkout only." });
    assert.match(r.body, /ship the pilot on the 14th/, "the existing prose is the preamble and survives");
    assert.match(r.body, /## Scope/);
  });

  it("names the sections in the ledger line rather than counting bytes", () => {
    const r = patchContract(CONTRACT, { Auth: "mTLS.", Timeouts: "30s.", "Rate limits": null });
    assert.equal(describePatch(r), "changed Auth; added Timeouts; removed Rate limits");
  });
});
