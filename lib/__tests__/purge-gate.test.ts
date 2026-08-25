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

/**
 * WHAT PURGE ACTUALLY DELETES.
 *
 * The consent gate above answers "may this run". This answers the other half:
 * once it runs, is the room gone? `executePurge` enumerates keys by hand
 * because the `Store` interface has no SCAN -- which is the safer design and
 * also means a key namespace added later is silently NOT deleted until someone
 * adds it to the list. That is a promise ("delete everything this room owns")
 * kept by a hand-maintained list, so it gets a test that walks the store.
 */
describe("purge leaves nothing of the room behind", () => {
  async function purgedRoomStore() {
    const { FakeStore } = await import("./fake-store");
    const { createRoom, authorize, writePlan, writeAudit, clearRegistryCache } = await import(
      "../room-registry"
    );
    const { appendEntry } = await import("../entries");
    const { executePurge } = await import("../purge");
    const { EMPTY_PLAN } = await import("../plan");

    clearRegistryCache();
    const now = new Date("2026-08-25T10:00:00.000Z");
    const store = new FakeStore();
    const made = await createRoom(store, {
      topic: "purge me",
      ownerLabel: "A",
      peerLabel: "B",
      now,
    });
    const a = await authorize(store, { presentedToken: made.ownerToken, now });
    assert.ok(a.ok);

    await appendEntry(
      store,
      made.room,
      a.token,
      { type: "note", title: "something two companies wrote", body: "x".repeat(50) },
      now,
    );
    await writePlan(store, made.room.id, {
      ...EMPTY_PLAN,
      updatedAt: now.toISOString(),
      items: [
        {
          id: "ACM-P-001",
          title: "a plan item, which is content and not bookkeeping",
          note: "written by one side, visible to the other",
          owner: "a",
          state: "open",
          raisedBy: "a",
          at: now.toISOString(),
        },
      ],
    });
    await writeAudit(store, {
      ts: now.toISOString(),
      tokenId: "t",
      roomId: made.room.id,
      side: "a",
      tool: "post",
      status: "ok",
    });

    await executePurge(store, made.room);
    return { store, roomId: made.room.id };
  }

  /** Every key the fake store holds, across all three of its shapes. */
  function allKeys(store: {
    kv: Map<string, unknown>;
    lists: Map<string, unknown>;
    sets: Map<string, unknown>;
  }): string[] {
    return [...store.kv.keys(), ...store.lists.keys(), ...store.sets.keys()];
  }

  it("[!!] the PLAN is deleted -- it is room CONTENT, not bookkeeping", async () => {
    const { store, roomId } = await purgedRoomStore();
    const { PLAN_KEY } = await import("../store");
    assert.ok(
      !allKeys(store as never).includes(PLAN_KEY(roomId)),
      "a purged room must not leave its plan document on the server",
    );
  });

  it("no key naming this room survives, whatever it is", async () => {
    const { store, roomId } = await purgedRoomStore();
    const survivors = allKeys(store as never).filter((k) => k.includes(roomId));
    assert.deepEqual(
      survivors,
      [],
      `purge enumerates keys by hand, so a namespace added later survives it: ${survivors.join(", ")}`,
    );
  });
});
