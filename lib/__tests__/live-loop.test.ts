/**
 * THE THREE DEFECTS THE FIRST LIVE TWO-AGENT RUN FOUND (S#276).
 *
 * None of these were caught by 269 passing tests. All three were caught within
 * minutes of two real Claude sessions talking to each other over the bridge for
 * the first time, which is the entire argument for run-green over unit-green.
 *
 *   1. `wait` could not see entries that were ALREADY unread, so two agents who
 *      each wrote-then-waited deadlocked with the answer sitting in the ledger.
 *   2. The idle brake was evaluated AFTER the wait, so a caller already told to
 *      stop was made to burn the full 45s before being told again.
 *   3. `markJoined` was only called by the MCP transport, so a partner who
 *      joined by the paste path was reported as never having connected — by the
 *      UI, the CLI, `status.peer.joined` and `/api/whoami` alike.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { discountedCost, opAsk, opRead, opWait, opStatus } from "../operations";
import {
  bumpIdleStreak,
  clearRegistryCache,
  createRoom,
  markJoined,
  parseRoom,
  peekIdleStreak,
  bumpWaste,
  peekWaste,
  type RoomRecord,
} from "../room-registry";
import { BLOCKED_CALL_DISCOUNT, BLOCKED_CALL_MS, ROOM_KEY, WASTE_BUDGET_BYTES } from "../store";
import { FakeStore, T0, plus } from "./fake-store";

beforeEach(() => clearRegistryCache());



async function bridge() {
  const store = new FakeStore();
  const { room, ownerToken, peerToken } = await createRoom(store, {
    topic: "live loop",
    ownerLabel: "A",
    peerLabel: "B",
    now: T0,
  });
  void ownerToken;
  void peerToken;
  const load = async (): Promise<RoomRecord> =>
    (await parseRoom(await store.get(ROOM_KEY(room.id)))) as RoomRecord;
  return { store, room, load };
}

/** A context for one side, resolved fresh so it sees the current room record. */
async function ctxFor(store: FakeStore, room: RoomRecord, side: "a" | "b", now: Date) {
  return {
    store,
    room,
    now,
    token: {
      id: `tok-${side}`,
      roomId: room.id,
      side,
      label: room.sides[side].label,
      code: room.sides[side].code,
      role: "participant" as const,
      dailyCap: 400,
      active: true,
      createdAt: T0.toISOString(),
      expiresAt: null,
    },
  };
}

describe("[!!] wait must never block while the caller has something unread", () => {
  it("returns an entry written BEFORE the wait started", async () => {
    // THE DEADLOCK, reproduced. B answers, THEN A waits. Before the fix, A's
    // `since` defaulted to latestSeq -- already past B's entry -- so A blocked
    // for a sequence number that would never come while B's answer sat unread.
    const { store, room } = await bridge();
    const b = await ctxFor(store, room, "b", T0);
    await opAsk(b, { title: "written before A ever waits", body: "..." });

    const a = await ctxFor(store, room, "a", plus(T0, 1000));
    const res = await opWait(a, { timeoutSeconds: 1 });

    assert.equal(res.timedOut, false, "a wait with unread content must not block");
    assert.equal(res.count, 1);
  });

  it("two sides that each write-then-wait cannot deadlock", async () => {
    // The exact sequence that stalled the real bridge: B writes, B waits (empty,
    // correctly), A waits and MUST get B's entry rather than blocking too.
    const { store, room } = await bridge();
    const b = await ctxFor(store, room, "b", T0);
    await opAsk(b, { title: "B speaks", body: "..." });
    const bWait = await opWait(b, { timeoutSeconds: 1 });
    assert.equal(bWait.timedOut, true, "B has nothing unread -- blocking is correct for B");

    const a = await ctxFor(store, room, "a", plus(T0, 1000));
    const aWait = await opWait(a, { timeoutSeconds: 1 });
    assert.equal(aWait.timedOut, false, "A holds unread content and must be handed it");
  });

  it("an explicit `since` is still honoured", async () => {
    // NEGATIVE CONTROL: the fix must not make `wait` ignore its own argument,
    // which would turn every wait into a read and break the live loop instead.
    const { store, room } = await bridge();
    const b = await ctxFor(store, room, "b", T0);
    await opAsk(b, { title: "seq 1", body: "..." });

    const a = await ctxFor(store, room, "a", plus(T0, 1000));
    const res = await opWait(a, { since: 99, timeoutSeconds: 1 });
    assert.equal(res.timedOut, true, "explicitly waiting past the end must still block");
  });
});

describe("[!!] the brake is denominated in WASTED BYTES, not in call count", () => {
  it("a long run of empty waits does NOT terminate the caller", async () => {
    // THE PROPERTY THE WHOLE REWORK EXISTS FOR. A listener is by construction a
    // run of empty waits. Under the old consecutive-count brake it died on the
    // 4th one -- i.e. exactly when the partner was slow, i.e. the case a
    // listener exists for. An empty wait is ~155B, so the budget must absorb
    // dozens of them.
    const { store, room } = await bridge();
    const a = await ctxFor(store, room, "a", T0);
    for (let i = 0; i < 20; i++) {
      const res = await opWait(a, { timeoutSeconds: 0 });
      assert.equal(res.timedOut, true, `wait ${i + 1} should time out, not refuse`);
    }
    assert.ok(
      (await peekWaste(store, a.token.id)) < WASTE_BUDGET_BYTES,
      "20 empty waits must be nowhere near the budget",
    );
  });

  it("an expensive spinner trips far sooner than a cheap one", async () => {
    // The cost asymmetry must do the weighting with no per-operation ceilings:
    // status is ~8x the bytes of an empty wait, so it must burn budget ~8x
    // faster. This is the anti-correlation fix stated as a measurement.
    // The room must be POPULATED for this to mean anything: status carries open
    // questions and cursors, so on an empty fixture it is nearly as small as a
    // wait and the test would pass or fail on nothing. Measured on the real
    // bridge S#276: status ~1,220 B vs empty wait ~155 B.
    const { store, room } = await bridge();
    const pricey = await ctxFor(store, room, "a", T0);
    for (let i = 0; i < 3; i++) {
      await opAsk(pricey, { title: `open question number ${i} on this bridge`, body: "context here" });
    }

    const cheap = await ctxFor(store, room, "b", T0);
    await opRead(cheap, { since: 0, markRead: true }); // B catches up, so its waits are genuinely empty

    for (let i = 0; i < 5; i++) await opWait(cheap, { timeoutSeconds: 0 });
    for (let i = 0; i < 5; i++) await opStatus(pricey);

    const waited = await peekWaste(store, cheap.token.id);
    const spun = await peekWaste(store, pricey.token.id);
    assert.ok(waited > 0 && spun > 0, "control: both must actually be charged something");
    assert.ok(spun > waited * 2, `status (${spun}B) must outspend wait (${waited}B) by a wide margin`);
  });

  it("refuses over-budget BEFORE waiting, not after", async () => {
    const { store, room } = await bridge();
    const a = await ctxFor(store, room, "a", T0);
    await bumpWaste(store, a.token.id, WASTE_BUDGET_BYTES + 1);

    const started = Date.now();
    await assert.rejects(() => opWait(a, { timeoutSeconds: 30 }), /STOP\./);
    const elapsed = Date.now() - started;
    // The bug was 44s of real waiting before repeating a refusal already given.
    assert.ok(elapsed < 2000, `refusal took ${elapsed}ms -- it must not wait first`);
  });

  it("a WRITE clears the debt — which the old docstring claimed and the code did not do", async () => {
    const { store, room } = await bridge();
    const a = await ctxFor(store, room, "a", T0);
    await bumpWaste(store, a.token.id, 5_000);
    await bumpIdleStreak(store, a.token.id);

    await opAsk(a, { title: "doing work, not spinning", body: "..." });

    assert.equal(await peekWaste(store, a.token.id), 0, "a write must clear wasted bytes");
    assert.equal(await peekIdleStreak(store, a.token.id), 0, "and the streak the docstring promised");
  });

  it("[!!] a STUCK CURSOR loop is charged, not reset — the hole the cursor fix opened", async () => {
    // Found by side B, S#276, and it is a regression THIS session introduced:
    // defaulting `wait` to the caller's cursor fixed a deadlock and, in the same
    // stroke, made a client that never calls markRead get the same entries back
    // instantly, forever. `learned = count > 0` then reset the budget on every
    // one of those ~2 kB responses, so the brake was blind to the most expensive
    // loop in the product.
    const { store, room } = await bridge();
    const writer = await ctxFor(store, room, "a", T0);
    await opAsk(writer, { title: "something worth reading once", body: "x".repeat(400) });

    const stuck = await ctxFor(store, room, "b", T0);
    const first = await opWait(stuck, { timeoutSeconds: 0 });
    assert.equal(first.count, 1, "the first delivery is genuinely informative");
    assert.equal(await peekWaste(store, stuck.token.id), 0, "and must reset the budget");

    // Same call again. Cursor never advanced, so the same entry comes back.
    let last = 0;
    for (let i = 0; i < 3; i++) {
      const again = await opWait(stuck, { timeoutSeconds: 0 });
      assert.equal(again.count, 1, "the stuck client is served the same entry again");
      last = await peekWaste(store, stuck.token.id);
    }
    assert.ok(last > 0, "re-serving what it already had must COST, not reset");
  });

  it("a blocked call is charged far less than an instant one", async () => {
    // The unit is the caller's CONTEXT, spent per turn. A call that blocked 45s
    // consumed wall clock and cannot be part of a tight loop; a call returning
    // in 0.15s can. Without this discount one budget has to be generous enough
    // for an 8-hour listener and tight enough to stop a spinner, which is
    // impossible when the payloads are only ~8x apart.
    const { store, room } = await bridge();
    const blocked = await ctxFor(store, room, "a", T0);
    const instant = await ctxFor(store, room, "b", T0);
    instant.token.id = "tok-instant";

    // The REAL rule, imported -- not re-implemented here. A local copy would
    // agree with itself under any ablation, which is what the first version of
    // this test did.
    const cheap = discountedCost(1000, BLOCKED_CALL_MS + 1);
    const dear = discountedCost(1000, 0);
    assert.ok(cheap > 0 && dear > 0, "control: both charged something");
    assert.ok(dear > cheap * 5, `instant (${dear}) must cost far more than blocked (${cheap})`);
  });

  it("the budget actually covers the overnight listener we now recommend", async () => {
    // B's arithmetic, turned into an assertion so the constant cannot drift away
    // from the use case the join document tells partners to run: 8 hours of
    // 45-second empty waits at ~155 B each, discounted for blocking.
    const waitsIn8Hours = (8 * 60 * 60) / 45;
    const cost = waitsIn8Hours * Math.ceil(155 * BLOCKED_CALL_DISCOUNT);
    assert.ok(
      cost < WASTE_BUDGET_BYTES,
      `an 8h listener costs ${cost} B against a ${WASTE_BUDGET_BYTES} B budget — it must fit`,
    );
    // NEGATIVE CONTROL: the budget must still be tight on the expensive path,
    // or "it fits" would just mean "the budget is infinite".
    assert.ok(WASTE_BUDGET_BYTES / 1220 < 20, "a status spinner must still trip inside ~20 calls");
  });

  it("peeking advances neither counter", async () => {
    // NEGATIVE CONTROL: if peek bumped, the refusal would arrive early and the
    // escalation the far side relies on would silently change.
    const { store } = await bridge();
    await bumpIdleStreak(store, "tok-x");
    await bumpWaste(store, "tok-x", 100);
    for (let i = 0; i < 3; i++) {
      assert.equal(await peekIdleStreak(store, "tok-x"), 1);
      assert.equal(await peekWaste(store, "tok-x"), 100);
    }
  });
});

describe("[!!] joining is recorded on EVERY transport, not just MCP", () => {
  it("a side that has acted is not reported as never having connected", async () => {
    const { store, room, load } = await bridge();

    const before = await load();
    assert.equal(before.sides.b.joinedAt, null, "control: B has not acted yet");

    // What the shared gate now does on any authenticated request.
    await markJoined(store, before, "b", T0);

    const after = await load();
    assert.notEqual(
      after.sides.b.joinedAt,
      null,
      "B acted, so every surface reporting 'has not connected' would be lying",
    );

    clearRegistryCache();
    const a = await ctxFor(store, after, "a", plus(T0, 1000));
    const status = await opStatus(a);
    assert.equal(status.peer.joined, true, "status.peer.joined is the field that lied");
  });

  it("marking is idempotent — the first contact time is not overwritten", async () => {
    const { store, room, load } = await bridge();
    await markJoined(store, room, "b", T0);
    const first = (await load()).sides.b.joinedAt;
    await markJoined(store, await load(), "b", plus(T0, 60_000));
    assert.equal((await load()).sides.b.joinedAt, first, "joinedAt records the FIRST contact");
  });
});
