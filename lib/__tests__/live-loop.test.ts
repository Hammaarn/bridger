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

import { opAsk, opRead, opWait, opStatus } from "../operations";
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
import { ROOM_KEY, WASTE_BUDGET_BYTES } from "../store";
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
