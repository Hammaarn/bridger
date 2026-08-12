import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { mintInvite, newInviteCode, redeemInvite, parseInvite } from "../invites";
import { authorize, clearRegistryCache, createRoom, parseRoom, type RoomRecord } from "../room-registry";
import { INVITE_KEY, ROOM_KEY } from "../store";
import { FakeStore, T0, plus } from "./fake-store";

beforeEach(() => clearRegistryCache());

async function room() {
  const store = new FakeStore();
  const created = await createRoom(store, {
    topic: "paste-and-go",
    ownerLabel: "JudgeMySite",
    peerLabel: "Trigvanta",
    now: T0,
  });
  const loadRoom = async (id: string): Promise<RoomRecord | null> =>
    parseRoom(await store.get(ROOM_KEY(id)));
  return { store, room: created.room, loadRoom };
}

describe("join codes", () => {
  it("is readable out of a chat window — no confusable characters", () => {
    for (let i = 0; i < 200; i++) {
      const code = newInviteCode();
      assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      assert.doesNotMatch(code, /[ILOU]/, "I, L, O and U are excluded on purpose");
    }
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 500 }, () => newInviteCode()));
    assert.equal(seen.size, 500);
  });

  it("redeems into a working token for the right side", async () => {
    const { store, room: r, loadRoom } = await room();
    const { code } = await mintInvite(store, r, "b", T0);

    const result = await redeemInvite(store, code, T0, loadRoom);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    clearRegistryCache();
    const auth = await authorize(store, { presentedToken: result.token, now: T0 });
    assert.equal(auth.ok, true);
    assert.equal(auth.ok && auth.token.side, "b", "the code decides the side, not the caller");
    assert.equal(auth.ok && auth.token.roomId, r.id);
  });

  it("BURNS on first use — the whole security property", async () => {
    const { store, room: r, loadRoom } = await room();
    const { code } = await mintInvite(store, r, "b", T0);

    assert.equal((await redeemInvite(store, code, T0, loadRoom)).ok, true);

    const second = await redeemInvite(store, code, T0, loadRoom);
    assert.deepEqual(second, { ok: false, reason: "unknown" });
    assert.equal(await store.get(INVITE_KEY(code)), null, "the record must be gone, not just flagged");
  });

  it("two simultaneous redemptions produce exactly ONE token", async () => {
    const { store, room: r, loadRoom } = await room();
    const { code } = await mintInvite(store, r, "b", T0);

    // Both read the record before either deletes it — the classic
    // time-of-check/time-of-use window. The `del` return value is the lock.
    const [x, y] = await Promise.all([
      redeemInvite(store, code, T0, loadRoom),
      redeemInvite(store, code, T0, loadRoom),
    ]);

    const winners = [x, y].filter((r2) => r2.ok);
    assert.equal(winners.length, 1, "a single-use code that issues two tokens is not single-use");
    const loser = [x, y].find((r2) => !r2.ok);
    assert.ok(loser && !loser.ok && ["already-used", "unknown"].includes(loser.reason));
  });

  it("expires, and says so rather than 'unknown'", async () => {
    const { store, room: r, loadRoom } = await room();
    const { code } = await mintInvite(store, r, "b", T0, { ttlSeconds: 60 });

    const late = await redeemInvite(store, code, plus(T0, 61_000), loadRoom);
    assert.deepEqual(late, { ok: false, reason: "expired" });
  });

  it("mints a token that EXPIRES — unlike the MCP path", async () => {
    const { store, room: r, loadRoom } = await room();
    const { code } = await mintInvite(store, r, "b", T0, { tokenTtlSeconds: 3600 });
    const result = await redeemInvite(store, code, T0, loadRoom);
    assert.ok(result.ok);
    if (!result.ok) return;

    clearRegistryCache();
    assert.equal((await authorize(store, { presentedToken: result.token, now: plus(T0, 60_000) })).ok, true);

    clearRegistryCache();
    assert.deepEqual(
      await authorize(store, { presentedToken: result.token, now: plus(T0, 3_601_000) }),
      { ok: false, reason: "expired" },
      "a token that reached a model's context must not live forever",
    );
  });

  it("is case-insensitive on redemption — it will be retyped", async () => {
    const { store, room: r, loadRoom } = await room();
    const { code } = await mintInvite(store, r, "b", T0);
    const result = await redeemInvite(store, code.toLowerCase(), T0, loadRoom);
    assert.equal(result.ok, true);
  });

  it("tolerates surrounding whitespace from a copy-paste", async () => {
    const { store, room: r, loadRoom } = await room();
    const { code } = await mintInvite(store, r, "b", T0);
    assert.equal((await redeemInvite(store, `  ${code}\n`, T0, loadRoom)).ok, true);
  });

  it("survives a malformed record rather than throwing into the join path", () => {
    assert.equal(parseInvite("not json"), null);
    assert.equal(parseInvite(JSON.stringify({ roomId: "r1", side: "z" })), null);
    assert.equal(parseInvite(JSON.stringify({ roomId: "r1", side: "a" }))?.side, "a");
  });
});
