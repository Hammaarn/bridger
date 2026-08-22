import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyPlan,
  EMPTY_PLAN,
  parsePlan,
  planGuidance,
  PlanRefused,
  readiness,
  type Plan,
} from "../plan";

const T = "2026-08-22T20:00:00.000Z";

function build(...changes: Array<[Parameters<typeof applyPlan>[1], Parameters<typeof applyPlan>[2]]>): Plan {
  let plan = EMPTY_PLAN;
  for (const [actor, change] of changes) plan = applyPlan(plan, actor, change, T).plan;
  return plan;
}

describe("the plan — a document both sides converge on", () => {
  it("both sides raise items into one board, each namespaced to its raiser", () => {
    const plan = build(
      ["a", { op: "add", id: "ACM-P-001", title: "Idempotency header", note: "we send X-Idem-Key" }],
      ["b", { op: "add", id: "NOR-P-001", title: "Edge strips X- headers", note: "src/edge.ts:14" }],
    );
    assert.deepEqual(
      plan.items.map((i) => [i.id, i.raisedBy]),
      [
        ["ACM-P-001", "a"],
        ["NOR-P-001", "b"],
      ],
    );
    assert.equal(plan.items[1].note, "src/edge.ts:14", "the raiser's own context rides with the item");
  });

  it("[!!] only the OWNER may agree — a commitment made for somebody else is worthless", () => {
    const plan = build(["a", { op: "add", id: "ACM-P-001", title: "x", owner: "b" }]);
    assert.throws(
      () => applyPlan(plan, "a", { op: "set", id: "ACM-P-001", state: "agreed" }, T),
      PlanRefused,
      "side a must not be able to agree on side b's behalf",
    );
    // ...and the owner can.
    const ok = applyPlan(plan, "b", { op: "set", id: "ACM-P-001", state: "agreed" }, T);
    assert.equal(ok.plan.items[0].state, "agreed");
  });

  it("agreeing to UNOWNED work is refused, and the refusal says why", () => {
    const plan = build(["a", { op: "add", id: "ACM-P-001", title: "x" }]);
    assert.throws(
      () => applyPlan(plan, "a", { op: "set", id: "ACM-P-001", state: "agreed" }, T),
      /commits nobody/,
    );
  });

  it("`both` may be agreed by either side — neither is being spoken for", () => {
    const plan = build(["a", { op: "add", id: "ACM-P-001", title: "x", owner: "both" }]);
    assert.equal(applyPlan(plan, "a", { op: "set", id: "ACM-P-001", state: "agreed" }, T).plan.items[0].state, "agreed");
    assert.equal(applyPlan(plan, "b", { op: "set", id: "ACM-P-001", state: "agreed" }, T).plan.items[0].state, "agreed");
  });

  it("NEGATIVE CONTROL: everything that is NOT a commitment stays open to both sides", () => {
    // Collaboration is the point. Only agreement is gated; proposing an owner,
    // retitling and dropping are not, because gating those builds a workflow
    // engine and people route around workflow engines.
    const plan = build(["a", { op: "add", id: "ACM-P-001", title: "x", owner: "b" }]);
    assert.doesNotThrow(() => applyPlan(plan, "a", { op: "set", id: "ACM-P-001", title: "y" }, T));
    assert.doesNotThrow(() => applyPlan(plan, "a", { op: "set", id: "ACM-P-001", owner: "a" }, T));
    assert.doesNotThrow(() => applyPlan(plan, "a", { op: "set", id: "ACM-P-001", state: "dropped" }, T));
  });

  it("completion is COMPUTED, and it names what is blocking", () => {
    const plan = build(
      ["a", { op: "add", id: "ACM-P-001", title: "owned, agreed", owner: "a" }],
      ["a", { op: "add", id: "ACM-P-002", title: "nobody's" }],
    );
    const agreed = applyPlan(plan, "a", { op: "set", id: "ACM-P-001", state: "agreed" }, T).plan;
    const r = readiness(agreed);

    assert.equal(r.complete, false);
    assert.equal(r.unowned, 1);
    assert.deepEqual(r.blocking, ["ACM-P-002 has no owner"]);
  });

  it("[!!] an EMPTY plan is not a complete one", () => {
    // Nothing to do and nothing agreed are the same shape to a boolean and are
    // opposite situations. The same absence-versus-emptiness trap that has bitten
    // this project in four other places.
    assert.equal(readiness(EMPTY_PLAN).complete, false);
  });

  it("a dropped item stops blocking without pretending it was done", () => {
    const plan = build(["a", { op: "add", id: "ACM-P-001", title: "not needed" }]);
    const dropped = applyPlan(plan, "b", { op: "set", id: "ACM-P-001", state: "dropped" }, T).plan;
    const r = readiness(dropped);
    assert.equal(r.complete, false, "a plan of only dropped items has agreed nothing");
    assert.equal(r.dropped, 1);
    assert.deepEqual(r.blocking, []);
  });

  it("a change that changes nothing is reported, not written", () => {
    const plan = build(["a", { op: "add", id: "ACM-P-001", title: "x", owner: "a" }]);
    const same = applyPlan(plan, "a", { op: "set", id: "ACM-P-001", title: "x" }, T);
    assert.equal(same.summary, "");
    assert.equal(same.plan, plan, "the untouched plan is returned by identity");
  });

  it("refuses a duplicate id and an unknown id, each with a usable message", () => {
    const plan = build(["a", { op: "add", id: "ACM-P-001", title: "x" }]);
    assert.throws(() => applyPlan(plan, "a", { op: "add", id: "ACM-P-001", title: "y" }, T), /already exists/);
    assert.throws(() => applyPlan(plan, "a", { op: "set", id: "NOPE-P-9", title: "y" }, T), /No plan item/);
  });

  it("a corrupt stored plan reads as empty rather than throwing on the hot path", () => {
    assert.deepEqual(parsePlan("{{not json"), EMPTY_PLAN);
    assert.deepEqual(parsePlan(null), EMPTY_PLAN);
    assert.deepEqual(parsePlan({ items: "nope" }), EMPTY_PLAN);
    assert.equal(parsePlan({ items: [{ id: "A", title: "t" }, { broken: true }] }).items.length, 1);
  });
});

describe("plan guidance — the live channel carrying its first real feature", () => {
  it("says nothing outside the plan phase", () => {
    const plan = build(["a", { op: "add", id: "ACM-P-001", title: "x" }]);
    assert.equal(planGuidance(plan, "a", "build"), null);
  });

  it("an empty plan is told how to start, in terms of what to write", () => {
    const g = planGuidance(EMPTY_PLAN, "a", "plan");
    assert.match(g!, /list every aspect/i);
    assert.match(g!, /your own codebase/i);
  });

  it("names YOUR outstanding items by id, not a count", () => {
    const plan = build(
      ["a", { op: "add", id: "ACM-P-001", title: "x", owner: "a" }],
      ["b", { op: "add", id: "NOR-P-001", title: "y", owner: "b" }],
    );
    const g = planGuidance(plan, "a", "plan")!;
    assert.match(g, /ACM-P-001/);
    assert.doesNotMatch(g, /NOR-P-001/, "the other side's work is not your prompt");
  });

  it("tells a finished plan to move on, rather than leaving it to a feeling", () => {
    let plan = build(["a", { op: "add", id: "ACM-P-001", title: "x", owner: "a" }]);
    plan = applyPlan(plan, "a", { op: "set", id: "ACM-P-001", state: "agreed" }, T).plan;
    assert.match(planGuidance(plan, "a", "plan")!, /plan phase is finished/i);
  });
});
