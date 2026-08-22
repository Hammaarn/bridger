import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeStore } from "./fake-store";
import { readRoomActivity, writeAudit } from "../room-registry";

const row = (roomId: string | null, ts: string) => ({
  ts,
  tokenId: "tok",
  roomId,
  side: "a" as const,
  tool: "status",
  status: "ok" as const,
});

/**
 * D6. The rolling audit log is one global list, so a busy room evicts a quiet
 * one — and the quiet returning partner is precisely the row the funnel
 * argument needs. This tally is the part that cannot be evicted, which makes
 * "is it correct" a question worth a test rather than a look.
 */
describe("room activity — the tally the audit window cannot evict", () => {
  it("counts calls and records the day", async () => {
    const store = new FakeStore();
    await writeAudit(store, row("room1", "2026-08-22T10:00:00.000Z"));
    await writeAudit(store, row("room1", "2026-08-22T11:00:00.000Z"));

    const a = await readRoomActivity(store, "room1");
    assert.equal(a?.calls, 2);
    assert.deepEqual(a?.days, ["2026-08-22"], "two calls on one day is still one day");
  });

  it("[!!] came back = a second DAY, which is the only claim the table makes", async () => {
    const store = new FakeStore();
    await writeAudit(store, row("room1", "2026-08-20T10:00:00.000Z"));
    await writeAudit(store, row("room1", "2026-08-22T09:00:00.000Z"));

    const a = await readRoomActivity(store, "room1");
    assert.equal(a?.days.length, 2, "used on two days is the definition of coming back");
  });

  it("firstAt is a MINIMUM and lastAt a MAXIMUM — an out-of-order row must not move them the wrong way", async () => {
    // Found S#280 by backdating a row: `lastAt` was assigned unconditionally, so
    // an out-of-order write drove "last used" BACKWARDS. In production rows
    // arrive in order and this is unreachable, which is exactly why it would
    // have survived — and the operator table built on it would have been
    // quietly wrong.
    const store = new FakeStore();
    await writeAudit(store, row("room1", "2026-08-22T10:00:00.000Z"));
    await writeAudit(store, row("room1", "2026-08-20T10:00:00.000Z"));

    const a = await readRoomActivity(store, "room1");
    assert.equal(a?.firstAt, "2026-08-20T10:00:00.000Z", "the earliest timestamp seen");
    assert.equal(a?.lastAt, "2026-08-22T10:00:00.000Z", "the latest, NOT the most recently written");
    assert.deepEqual(a?.days, ["2026-08-20", "2026-08-22"], "days stay sorted, so the cap drops the oldest");
  });

  it("rooms do not contaminate each other", async () => {
    const store = new FakeStore();
    await writeAudit(store, row("room1", "2026-08-22T10:00:00.000Z"));
    await writeAudit(store, row("room2", "2026-08-22T10:00:00.000Z"));

    assert.equal((await readRoomActivity(store, "room1"))?.calls, 1);
    assert.equal((await readRoomActivity(store, "room2"))?.calls, 1);
  });

  it("NEGATIVE CONTROL: a room with no calls has no tally, and a row with no room writes none", async () => {
    const store = new FakeStore();
    await writeAudit(store, row(null, "2026-08-22T10:00:00.000Z"));

    assert.equal(await readRoomActivity(store, "never-used"), null, "absent, not zero");
    assert.equal([...store.kv.keys()].filter((k) => k.includes("activity")).length, 0);
  });

  it("a half-written record reads as ABSENT rather than as zero usage", async () => {
    const store = new FakeStore();
    store.kv.set("bridger:activity:room1", JSON.stringify({ calls: "lots" }));
    assert.equal(await readRoomActivity(store, "room1"), null);
  });

  it("a failing store never takes the request down with it", async () => {
    // writeAudit is called on the hot path of every request. Logging is
    // best-effort by design, and a bridge that 500s because its logger is down
    // is a worse outcome than a missing tally.
    const store = new FakeStore();
    store.failWhen = (k) => k.includes("activity");
    await assert.doesNotReject(writeAudit(store, row("room1", "2026-08-22T10:00:00.000Z")));
  });
});
