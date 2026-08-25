import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { FakeStore } from "./fake-store";
import { clearRegistryCache, readRoomActivity, writeAudit } from "../room-registry";

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
  /**
   * The registry caches are module-level and these cases deliberately REUSE
   * room ids across fresh stores, which no real process does -- room ids are
   * unique and a process has one store. Every other suite already resets here;
   * this one did not, because until S#283 the tally was the one record read
   * straight from the store every time.
   */
  beforeEach(() => clearRegistryCache());

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

describe("the tally cache — what it may and may not do", () => {
  beforeEach(() => clearRegistryCache());

  it("[!!] skips the re-read: a second call to the same room costs ONE command", async () => {
    // The saving this exists for. The first call has nothing cached and reads;
    // the second must not, because we wrote that value ourselves.
    const store = new FakeStore();
    let gets = 0;
    const spy = new Proxy(store, {
      get(t, p, r) {
        const v = Reflect.get(t, p, r);
        if (p !== "get") return typeof v === "function" ? v.bind(t) : v;
        return async (...a: unknown[]) => {
          gets++;
          return (v as (...x: unknown[]) => Promise<unknown>).apply(t, a);
        };
      },
    });

    await writeAudit(spy as unknown as FakeStore, row("roomA", "2026-08-22T10:00:00.000Z"));
    const afterFirst = gets;
    await writeAudit(spy as unknown as FakeStore, row("roomA", "2026-08-22T10:00:01.000Z"));
    assert.equal(gets, afterFirst, "the second call must not re-read what it just wrote");

    // ...and the number it produced is still right.
    assert.equal((await readRoomActivity(store, "roomA"))?.calls, 2);
  });

  it("NEGATIVE CONTROL: a different room still reads, and its count starts at one", async () => {
    const store = new FakeStore();
    await writeAudit(store, row("roomA", "2026-08-22T10:00:00.000Z"));
    await writeAudit(store, row("roomB", "2026-08-22T10:00:00.000Z"));
    assert.equal((await readRoomActivity(store, "roomA"))?.calls, 1);
    assert.equal((await readRoomActivity(store, "roomB"))?.calls, 1, "one room must not seed another");
  });

  it("[!!] a FAILED write drops the cache instead of compounding on it", async () => {
    // If the setex fails, the value we hoped to store is not what is stored.
    // Caching it anyway would make the next call add one to a number the
    // database never accepted, and the error would never surface.
    const store = new FakeStore();
    await writeAudit(store, row("roomC", "2026-08-22T10:00:00.000Z"));
    assert.equal((await readRoomActivity(store, "roomC"))?.calls, 1);

    store.failWhen = (k: string) => k.includes("activity");
    await writeAudit(store, row("roomC", "2026-08-22T10:00:01.000Z"));
    store.failWhen = null;

    // The failed call left the stored value alone; the NEXT good call must
    // build on what is actually there, not on the value that failed to land.
    await writeAudit(store, row("roomC", "2026-08-22T10:00:02.000Z"));
    assert.equal(
      (await readRoomActivity(store, "roomC"))?.calls,
      2,
      "a write that threw must not be counted, and must not corrupt the next one",
    );
  });
});
