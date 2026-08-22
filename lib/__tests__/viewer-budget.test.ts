import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { FakeStore, T0, plus } from "./fake-store";
import {
  authorize,
  clearRegistryCache,
  createRoom,
  issueToken,
  parseRoom,
} from "../room-registry";
import {
  DEFAULT_DAILY_CAP,
  PASTE_PATH_DAILY_CAP,
  ROOM_KEY,
  ROOM_USAGE_KEY,
  USAGE_KEY,
  VIEWER_DAILY_CAP,
} from "../store";

async function freshRoom() {
  const store = new FakeStore();
  const created = await createRoom(store, {
    topic: "judgemysite x Northwind",
    ownerLabel: "JudgeMySite",
    peerLabel: "Northwind",
    now: T0,
  });
  return { store, ...created };
}

/** Spread calls over minutes so the per-minute limiter is never what stops us. */
const spread = (i: number) => plus(T0, Math.floor(i / 10) * 60_000);
const day = T0.toISOString().slice(0, 10);

/** Read the token id the way the registry derives it, without re-implementing it. */
async function idOf(store: FakeStore, token: string) {
  const out = await authorize(store, { presentedToken: token, now: T0 });
  assert.equal(out.ok, true, "setup call must succeed");
  return (out as { token: { id: string } }).token.id;
}

beforeEach(() => clearRegistryCache());

/**
 * S#280. A friend's watch tab spent 406 of a 400-a-day budget and stalled, on a
 * room that had seen twelve entries all day. Erik asked whether a viewer needs a
 * daily cap at all — and the answer was sitting three lines above it: the code
 * already reasons that a viewer "cannot write and calls no model, so the loop
 * this limit exists to stop cannot happen on it", applies that to the per-MINUTE
 * ceiling, and then charged the per-DAY one as if it were an agent.
 */
describe("viewer budget — a watcher must not be billed like a worker", () => {
  it("a viewer is no longer stopped at the agent's daily cap", async () => {
    const { store, room, ownerToken: _o } = await freshRoom();
    void _o;
    const viewer = await issueToken(store, room, "a", T0, undefined, "viewer");
    const id = await idOf(store, viewer);

    // Exactly where the real tab died.
    store.kv.set(USAGE_KEY(id, day), DEFAULT_DAILY_CAP);
    const out = await authorize(store, { presentedToken: viewer, now: spread(1) });
    assert.equal(out.ok, true, "400 calls must no longer stop a watcher");
  });

  it("but it is still BOUNDED — this raised the ceiling, it did not remove it", async () => {
    const { store, room } = await freshRoom();
    const viewer = await issueToken(store, room, "a", T0, undefined, "viewer");
    const id = await idOf(store, viewer);

    store.kv.set(USAGE_KEY(id, day), VIEWER_DAILY_CAP);
    assert.deepEqual(await authorize(store, { presentedToken: viewer, now: spread(1) }), {
      ok: false,
      reason: "daily-cap",
    });
  });

  it("[!!] a watcher cannot starve the work — viewer calls are not charged to the room", async () => {
    // The half that matters. Raising the viewer's own cap WITHOUT this would
    // have made the incident worse: a tab left open overnight would spend the
    // room's 600 and then both sides' agents would be refused with
    // `room-daily-cap`, whose message tells them not even to ask for a
    // replacement token. An annoyance becomes an outage of the real work.
    const { store, room } = await freshRoom();
    const viewer = await issueToken(store, room, "a", T0, undefined, "viewer");

    const before = Number(store.kv.get(ROOM_USAGE_KEY(room.id, day)) ?? 0);
    for (let i = 0; i < 5; i++) {
      await authorize(store, { presentedToken: viewer, now: spread(i) });
    }
    const after = Number(store.kv.get(ROOM_USAGE_KEY(room.id, day)) ?? 0);
    assert.equal(after, before, "five viewer calls must not move the room's budget");
  });

  it("NEGATIVE CONTROL: a participant is still charged to the room, and still stopped by it", async () => {
    const { store, room, ownerToken } = await freshRoom();

    await authorize(store, { presentedToken: ownerToken, now: T0 });
    assert.equal(
      Number(store.kv.get(ROOM_USAGE_KEY(room.id, day)) ?? 0),
      1,
      "a participant must still count against the room",
    );

    const stored = parseRoom(await store.get(ROOM_KEY(room.id)));
    await store.set(ROOM_KEY(room.id), JSON.stringify({ ...stored, dailyCap: 1 }));
    clearRegistryCache();

    assert.deepEqual(await authorize(store, { presentedToken: ownerToken, now: spread(11) }), {
      ok: false,
      reason: "room-daily-cap",
    });
  });

  it("a link-minted viewer keeps its NARROWER cap — that number is about how the credential travels", async () => {
    // PASTE_PATH_DAILY_CAP exists because a link passes through chat logs and
    // transcripts, making it the credential most likely to leak. That reasoning
    // is about DELIVERY, not about the role, so the role's larger ceiling must
    // not quietly undo it.
    const { store, room } = await freshRoom();
    const viewer = await issueToken(store, room, "a", T0, undefined, "viewer");
    const id = await idOf(store, viewer);

    // Select by ID, not by prefix: three tokens exist on this room and the
    // first `bridger:tok:` key is the OWNER's, so a prefix match silently
    // rewrote the wrong record and the test passed nothing.
    const key = [...store.kv.keys()].find(
      (k) => k.startsWith("bridger:tok:") && JSON.parse(String(store.kv.get(k))).id === id,
    )!;
    const rec = JSON.parse(String(store.kv.get(key)));
    store.kv.set(key, JSON.stringify({ ...rec, dailyCap: PASTE_PATH_DAILY_CAP }));
    clearRegistryCache();
    store.kv.set(USAGE_KEY(id, day), PASTE_PATH_DAILY_CAP);

    assert.deepEqual(await authorize(store, { presentedToken: viewer, now: spread(1) }), {
      ok: false,
      reason: "daily-cap",
    });
  });
});
