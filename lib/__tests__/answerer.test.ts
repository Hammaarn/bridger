import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { appendEntry, getCursor } from "../entries";
import {
  authorize,
  canWrite,
  clearRegistryCache,
  createRoom,
  isAnswerer,
  parseToken,
  type RoomRecord,
} from "../room-registry";
import { opAsk, opPing, OperationRefused } from "../operations";
import { FakeStore, T0 } from "./fake-store";

beforeEach(() => clearRegistryCache());

async function bridge() {
  const store = new FakeStore();
  const { room, ownerToken, peerToken } = await createRoom(store, {
    topic: "answerer",
    ownerLabel: "JudgeMySite",
    peerLabel: "Gemini",
    now: T0,
  });
  const a = await authorize(store, { presentedToken: ownerToken, now: T0 });
  const b = await authorize(store, { presentedToken: peerToken, now: T0 });
  assert.ok(a.ok && b.ok);
  return { store, room, jms: a.token, gem: b.token };
}

const ctx = (store: FakeStore, room: RoomRecord, token: any, now = T0) => ({ store, room, token, now });

describe("answerer role — resolution keeps the widen-on-unknown safety property", () => {
  const base = { id: "t1", roomId: "r1", side: "a", label: "X", code: "XXX", createdAt: "", expiresAt: null };

  it("the exact string selects the role", () => {
    assert.equal(parseToken({ ...base, role: "answerer" })?.role, "answerer");
    assert.equal(parseToken({ ...base, role: "viewer" })?.role, "viewer");
  });

  it("anything unrecognised WIDENS to participant, never downgrades", () => {
    // The failure this prevents: a corrupted or newer role value silently
    // stripping a live partner's access mid-integration.
    for (const bad of [undefined, "", "Answerer", "ANSWERER", "answerer ", 7, null, {}]) {
      assert.equal(parseToken({ ...base, role: bad })?.role, "participant", `role=${JSON.stringify(bad)}`);
    }
  });

  it("an answerer WRITES — it is a smaller surface, not a weaker one", () => {
    const t = parseToken({ ...base, role: "answerer" })!;
    assert.equal(canWrite(t), true);
    assert.equal(isAnswerer(t), true);
    const v = parseToken({ ...base, role: "viewer" })!;
    assert.equal(canWrite(v), false);
    assert.equal(isAnswerer(v), false);
  });
});

describe("[!!] HIDING IS NOT GATING — the two-tool surface is cost, not permission", () => {
  it("an answerer may still perform an operation its tool list does not show", async () => {
    // THE POINT. `bridger_ask` is withheld from the answerer's tools/list to
    // save the caller ~150 tokens of standing schema per turn. That is ALL it
    // does. If this test ever starts failing because the operation refuses, a
    // permission has been smuggled into a cost optimisation, and the tool list
    // has silently become a security boundary that nothing else enforces.
    const { store, room, gem } = await bridge();
    const answerer = { ...gem, role: "answerer" as const };

    const entry = await opAsk(ctx(store, room, answerer), { title: "still allowed?", body: "" });
    assert.ok(entry, "operations.ts must treat an answerer exactly as a participant");
  });

  it("the real gate is untouched — a viewer is still refused by the same op", async () => {
    // A refusal only means something next to an acceptance in the same breath.
    const { store, room, gem } = await bridge();
    const viewer = { ...gem, role: "viewer" as const };
    await assert.rejects(
      () => opAsk(ctx(store, room, viewer), { title: "nope", body: "" }),
      (e: unknown) => e instanceof OperationRefused,
    );
  });
});

describe("opPing — one call, everything, then stop", () => {
  it("returns the questions awaiting YOU, and not the ones awaiting them", async () => {
    const { store, room, jms, gem } = await bridge();
    await appendEntry(store, room, jms, { type: "question", title: "what is the cap?", body: "" }, T0);
    await appendEntry(store, room, gem, { type: "question", title: "mine, not theirs", body: "" }, T0);

    const ping = await opPing(ctx(store, room, gem));
    assert.equal(ping.awaitingYou.length, 1);
    // `contain()` is typed `string | null` — null for an empty title. Assert it
    // survived rather than casting the null away, so an empty-title regression
    // shows up here instead of as a silent `null` on the wire.
    const title = ping.awaitingYou[0].title;
    assert.ok(title, "a titled question must survive containment as a string");
    assert.match(title, /what is the cap\?/);
  });

  it("delivers the entries too — so answering needs no second call", async () => {
    const { store, room, jms, gem } = await bridge();
    await appendEntry(store, room, jms, { type: "question", title: "q", body: "" }, T0);

    const ping = await opPing(ctx(store, room, gem));
    assert.ok(ping.newEntries.length > 0, "ping must carry the content, not just a count");
  });

  it("advances the cursor — a second ping does NOT re-deliver", async () => {
    // Re-delivery would grow the caller's context on every call, which is the
    // exact cost this operation exists to remove.
    const { store, room, jms, gem } = await bridge();
    await appendEntry(store, room, jms, { type: "question", title: "q", body: "" }, T0);

    const first = await opPing(ctx(store, room, gem));
    assert.ok(first.newEntries.length > 0);
    assert.ok((await getCursor(store, room.id, gem.side)) > 0);

    const second = await opPing(ctx(store, room, gem));
    assert.equal(second.newEntries.length, 0, "the same entries must not arrive twice");
  });

  it("its guidance names NO tool to look again with", async () => {
    // The S#272 bug in one assertion: the wait refusal pointed loops straight
    // at `bridger_status`, so the brake handed the agent its next poll.
    const { store, room, gem } = await bridge();
    const quiet = await opPing(ctx(store, room, gem));
    assert.equal(quiet.awaitingYou.length, 0);
    for (const probe of ["bridger_status", "bridger_read", "bridger_wait", "bridger_ping"]) {
      assert.ok(!quiet.guidance.includes(probe), `guidance must not name ${probe}`);
    }
    assert.match(quiet.guidance, /stop/i);
  });

  it("still brakes a ping loop — the point was to make polling unnecessary, not cheap", async () => {
    const { store, room, gem } = await bridge();
    let refused = false;
    for (let i = 0; i < 12; i++) {
      try {
        await opPing(ctx(store, room, gem));
      } catch (e) {
        refused = e instanceof OperationRefused;
        break;
      }
    }
    assert.ok(refused, "an idle ping loop must hit the brake like every other read");
  });
});
