/**
 * THE DATABASE BILL, PINNED (S#281).
 *
 * Every assertion here exists because a cheap-for-the-caller path was expensive
 * for us, and nothing in the codebase could see the difference. The unit under
 * test is Redis COMMANDS, which is what Upstash charges for and what ran out on
 * Faver when a loop went unnoticed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { FakeStore } from "./fake-store";
import { authorize, createRoom } from "../room-registry";

const T0 = new Date("2026-08-23T12:00:00.000Z");

/** Same shape as the other suites' local helper — a room with both sides live. */
async function bridge() {
  const store = new FakeStore();
  const { room, ownerToken, peerToken } = await createRoom(store, {
    topic: "redis cost",
    ownerLabel: "A",
    peerLabel: "B",
    now: T0,
  });
  const a = await authorize(store, { presentedToken: ownerToken, now: T0 });
  assert.ok(a.ok);
  return { store, room, jms: a.token };
}
import {
  POLL_START_MS,
  POLL_MAX_MS,
  POLL_GROWTH,
  waitForNew,
  setCursor,
  getCursor,
} from "../entries";
import { bumpWaste, peekWaste, noteOp } from "../room-registry";
import {
  CURSOR_KEY,
  OP_TRAIL_KEY,
  WASTE_KEY,
  ORPHAN_TTL_SECONDS,
  WASTE_WINDOW_SECONDS,
  OP_TRAIL_TTL_SECONDS,
  WASTE_BUDGET_BYTES,
} from "../store";

/** Poll count for a wait of this length, derived from the constants themselves. */
function pollsFor(timeoutMs: number): number {
  let elapsed = 0;
  let poll = POLL_START_MS;
  let n = 0;
  for (;;) {
    n++;
    if (elapsed + poll >= timeoutMs) return n;
    elapsed += poll;
    poll = Math.min(POLL_MAX_MS, Math.ceil(poll * POLL_GROWTH));
  }
}

describe("the wait poll backs off — the free tier depends on it", () => {
  it("a 45-second wait costs far fewer than 45 reads", () => {
    const polls = pollsFor(45_000);
    assert.ok(
      polls <= 12,
      `a 45s wait spends ${polls} Redis reads; the flat-1000ms version spent 45`,
    );
    // NEGATIVE CONTROL: a backoff that had silently stopped backing off, or one
    // whose cap was removed, would both pass the line above by accident — the
    // first by never growing, the second by growing without bound. Pin both.
    assert.ok(polls >= 5, `${polls} polls in 45s means the cap is not holding`);
  });

  it("the FIRST check is faster than the flat interval it replaced", () => {
    assert.ok(
      POLL_START_MS < 1000,
      "a live back-and-forth must not have got slower to make an idle one cheaper",
    );
  });

  it("[!!] the measured read count matches the arithmetic — the backoff really runs", async () => {
    // Without this the whole file would be testing a formula rather than the
    // code: `pollsFor` could agree with itself perfectly while `waitForNew`
    // ignored its own constants.
    const { store, room, jms } = await bridge();
    let t = 0;
    const res = await waitForNew(store, room, jms, {
      sinceSeq: 0,
      timeoutMs: 45_000,
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    });
    assert.equal(res.timedOut, true);
    assert.equal(
      res.reads,
      pollsFor(45_000),
      "the loop did not spend what the constants say it should",
    );
  });
});

describe("SET clears a TTL — the keys that were immortal", () => {
  it("[!!] a second waste bump does not strip the counter's expiry", async () => {
    const store = new FakeStore();
    await bumpWaste(store, "tok-1", 100);
    const afterFirst = store.ttlOf(WASTE_KEY("tok-1"));
    await bumpWaste(store, "tok-1", 100);
    const afterSecond = store.ttlOf(WASTE_KEY("tok-1"));

    assert.equal(afterFirst, WASTE_WINDOW_SECONDS, "control: the first bump sets a TTL");
    assert.equal(
      afterSecond,
      WASTE_WINDOW_SECONDS,
      "the second bump stripped the expiry — this counter never resets, so an " +
        "honest caller is refused forever",
    );
    assert.equal(await peekWaste(store, "tok-1"), 200, "control: it still counts");
  });

  it("[!!] a second op-trail write does not strip the trail's expiry", async () => {
    const store = new FakeStore();
    await noteOp(store, "tok-2", "s");
    assert.equal(store.ttlOf(OP_TRAIL_KEY("tok-2")), OP_TRAIL_TTL_SECONDS, "control");
    await noteOp(store, "tok-2", "r");
    assert.equal(
      store.ttlOf(OP_TRAIL_KEY("tok-2")),
      OP_TRAIL_TTL_SECONDS,
      "the trail became immortal on its second write",
    );
  });
});

describe("the five keys that never expired now carry a fuse", () => {
  it("the cursor gets a TTL, and advancing it keeps one", async () => {
    const store = new FakeStore();
    await setCursor(store, "room-1", "a", 5);
    assert.equal(store.ttlOf(CURSOR_KEY("room-1", "a")), ORPHAN_TTL_SECONDS);
    await setCursor(store, "room-1", "a", 9);
    assert.equal(
      store.ttlOf(CURSOR_KEY("room-1", "a")),
      ORPHAN_TTL_SECONDS,
      "advancing the cursor left it without an expiry",
    );
    assert.equal(await getCursor(store, "room-1", "a"), 9, "control: it still advances");
  });

  it("the fuse outlives any room by a wide margin", () => {
    // The fuse must never expire a counter a live room still needs. A room is
    // 30 days IDLE, refreshed on write, so the margin is what makes this safe.
    assert.ok(
      ORPHAN_TTL_SECONDS > 30 * 24 * 3600 * 10,
      "the fuse is too close to the room TTL to be safe",
    );
  });
});

describe("the budget the join document actually recommends", () => {
  it("18,000 bytes covers an eight-hour overnight listener at the DEFAULT interval", () => {
    const perWait = Math.ceil(155 * 0.1);
    const waits = WASTE_BUDGET_BYTES / perWait;
    const hoursAtDefault = (waits * 25) / 3600;
    assert.ok(
      hoursAtDefault >= 7.5,
      `${hoursAtDefault.toFixed(1)}h at the 25s default — the overnight case we ` +
        `recommend does not fit the budget written to allow it`,
    );
    // NEGATIVE CONTROL: "it fits" must not just mean "the budget is infinite".
    assert.ok(WASTE_BUDGET_BYTES / 1220 < 20, "a status spinner must still trip inside ~20 calls");
  });
});

describe("[!!] the end-to-end command cost of one idle wait", () => {
  /**
   * THE NUMBER THIS WHOLE FILE EXISTS FOR.
   *
   * Counted against the real operation rather than derived, because the poll
   * loop was only ever HALF the bill -- the fixed per-call overhead (kill
   * switch, rate limiter, daily counters, waste, idle streak, op trail, audit,
   * room tally) ran on every call too, and no arithmetic about polling would
   * have caught it.
   *
   * Measured on a SHORT wait and then extrapolated to the real 45-second one,
   * because `opWait` has no clock seam and a literal 45-second wait would put
   * forty seconds of sleeping into the suite. The extrapolation is honest: the
   * fixed overhead is what is measured, and the poll count comes from the same
   * constants the loop itself uses (pinned separately above, against the real
   * loop, so the two cannot drift apart silently).
   */
  it("costs far fewer commands than the poll loop alone used to", async () => {
    const { store, room, jms } = await bridge();
    const { opWait } = await import("../operations");

    let commands = 0;
    const REDIS_OPS = new Set([
      "get", "set", "setex", "del", "incr", "expire",
      "rpush", "lpush", "ltrim", "lrange", "llen", "sadd", "srem", "smembers",
    ]);
    const counting = new Proxy(store, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== "function") return v;
        if (!REDIS_OPS.has(String(prop))) return (v as (...a: unknown[]) => unknown).bind(target);
        return (...args: unknown[]) => {
          commands++;
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });

    const SHORT_SECONDS = 3;
    await opWait({ store: counting, room, token: jms, now: new Date() }, {
      timeoutSeconds: SHORT_SECONDS,
    });

    // LIVENESS: a proxy that stopped intercepting would report zero and sail
    // past any ceiling. Absence and success must never render the same.
    assert.ok(commands > 0, "the counter never fired — this test measured nothing");

    const shortPolls = pollsFor(SHORT_SECONDS * 1000);
    const fixedOverhead = commands - shortPolls;
    const realCost = fixedOverhead + pollsFor(45_000);

    assert.ok(
      fixedOverhead > 0,
      `fixed overhead computed as ${fixedOverhead} — the measurement is wrong`,
    );
    console.log(
      `      -> 45s idle wait = ${realCost} commands ` +
        `(${fixedOverhead} fixed + ${pollsFor(45_000)} polls); was ${fixedOverhead + 45}`,
    );
    assert.ok(
      realCost < 45,
      `a full 45s idle wait costs ${realCost} Redis commands ` +
        `(${fixedOverhead} fixed + ${pollsFor(45_000)} polls). The poll loop ALONE ` +
        `used to cost 45, before any fixed overhead was counted.`,
    );
  });
});

describe("[!!] bandwidth: an incremental read fetches the tail, not the room", () => {
  /**
   * THE FINDING THIS PINS (S#281 Upstash audit). Upstash meters bandwidth
   * (10 GB/month) as well as commands (500k/month), and only commands had ever
   * been audited. A read of a 1,000-entry room is ONE command and ~750 KB — so
   * bandwidth runs out after ~14,000 reads, at 2.8% of the command budget.
   * Counting commands could not see it.
   */
  async function roomWith(n: number) {
    const { createRoom, authorize, clearRegistryCache } = await import("../room-registry");
    const { appendEntry } = await import("../entries");
    clearRegistryCache();
    const store = new FakeStore();
    const made = await createRoom(store, {
      topic: "bw", ownerLabel: "A", peerLabel: "B", now: T0,
    });
    const a = await authorize(store, { presentedToken: made.ownerToken, now: T0 });
    assert.ok(a.ok);
    for (let i = 0; i < n; i++) {
      await appendEntry(store, made.room, a.token,
        { type: "note", title: `e${i}`, body: "x".repeat(400) }, T0);
    }
    return { store, room: made.room };
  }

  /** Bytes the store handed back, which is what Upstash bills as egress. */
  function bytesOf(rows: unknown[]): number {
    return rows.reduce<number>(
      (n, r) => n + Buffer.byteLength(typeof r === "string" ? r : JSON.stringify(r)),
      0,
    );
  }

  it("catching up on ONE entry does not transfer the whole room", async () => {
    const { store, room } = await roomWith(200);
    const { readEntries } = await import("../entries");

    let pulled = 0;
    const spy = new Proxy(store, {
      get(t, p, r) {
        const v = Reflect.get(t, p, r);
        if (p !== "lrange") return typeof v === "function" ? v.bind(t) : v;
        return async (...args: [string, number, number]) => {
          const out = await (v as (...a: unknown[]) => Promise<unknown[]>).apply(t, args);
          pulled += bytesOf(out);
          return out;
        };
      },
    });

    const fresh = await readEntries(spy, room.id, { sinceSeq: 199, latestSeq: 200 });
    assert.equal(fresh.length, 1, "control: exactly one entry is new");
    assert.ok(pulled > 0, "the spy never fired — this test measured nothing");
    assert.ok(
      pulled < 3000,
      `catching up on one entry pulled ${pulled} bytes; the whole room is ~150,000`,
    );
  });

  it("[!!] a cursor at the head does no list read AT ALL", async () => {
    const { store, room } = await roomWith(50);
    const { readEntries } = await import("../entries");
    let lranges = 0;
    const spy = new Proxy(store, {
      get(t, p, r) {
        const v = Reflect.get(t, p, r);
        if (p !== "lrange") return typeof v === "function" ? v.bind(t) : v;
        return async (...a: unknown[]) => {
          lranges++;
          return (v as (...x: unknown[]) => Promise<unknown[]>).apply(t, a);
        };
      },
    });
    const out = await readEntries(spy, room.id, { sinceSeq: 50, latestSeq: 50 });
    assert.deepEqual(out, []);
    assert.equal(lranges, 0, "nothing new must cost zero commands and zero bytes");
  });

  it("the bounded fetch is still EXACT — over-fetching cannot leak old entries", async () => {
    // The window is an optimisation, not the guarantee: the seq filter still
    // runs, so a window wider than reality (after a trim, or a stale cursor)
    // returns the right answer and merely costs more.
    const { store, room } = await roomWith(30);
    const { readEntries } = await import("../entries");
    const bounded = await readEntries(store, room.id, { sinceSeq: 25, latestSeq: 30 });
    const unbounded = await readEntries(store, room.id, { sinceSeq: 25 });
    assert.deepEqual(
      bounded.map((e) => e.id),
      unbounded.map((e) => e.id),
      "the bounded read must agree with the unbounded one, always",
    );
    // A deliberately absurd window: must still be exact, never duplicated.
    const wide = await readEntries(store, room.id, { sinceSeq: 25, latestSeq: 9999 });
    assert.deepEqual(wide.map((e) => e.id), unbounded.map((e) => e.id));
  });
});
