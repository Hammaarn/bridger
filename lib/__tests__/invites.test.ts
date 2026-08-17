import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  INVITE_REREAD_SECONDS,
  mintInvite,
  newInviteCode,
  redeemInvite,
  parseInvite,
} from "../invites";
import { authorize, clearRegistryCache, createRoom, parseRoom, type RoomRecord } from "../room-registry";
import { INVITE_KEY, ROOM_KEY } from "../store";
import { FakeStore, T0, plus } from "./fake-store";

beforeEach(() => clearRegistryCache());

async function room() {
  const store = new FakeStore();
  const created = await createRoom(store, {
    topic: "paste-and-go",
    ownerLabel: "JudgeMySite",
    peerLabel: "Northwind",
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

  it("RE-READS return the SAME token — the fix for the demo that died", async () => {
    // S#276. This test used to assert the opposite ("BURNS on first use") and
    // that property is what convinced Northwind's agent the service was broken:
    // it fetched, got a token, fetched again to confirm, got a 404, and never
    // used the credential it was holding.
    const { store, room: r, loadRoom } = await room();
    const { code } = await mintInvite(store, r, "b", T0);

    const first = await redeemInvite(store, code, T0, loadRoom);
    assert.ok(first.ok);
    if (!first.ok) return;
    assert.equal(first.reused, false, "the first read is the mint");

    const second = await redeemInvite(store, code, plus(T0, 5_000), loadRoom);
    assert.ok(second.ok, "a retry must not look like a broken service");
    if (!second.ok) return;
    assert.equal(second.token, first.token, "the same code must not yield a second credential");
    assert.equal(second.reused, true, "and the document must say so rather than imply a re-issue");
  });

  it("mints exactly ONE token no matter how many times it is read", async () => {
    const { store, room: r, loadRoom } = await room();
    const { code } = await mintInvite(store, r, "b", T0);

    const reads = [];
    for (let i = 0; i < 5; i++) {
      reads.push(await redeemInvite(store, code, plus(T0, i * 1000), loadRoom));
    }

    const tokens = new Set(reads.map((x) => (x.ok ? x.token : `refused:${x.reason}`)));
    assert.equal(tokens.size, 1, "five reads, one credential");
    assert.equal(reads.filter((x) => x.ok && !x.reused).length, 1, "exactly one mint");
  });

  // NAMED FOR WHAT IT ASSERTS, not for what it would be nice to prove. It does
  // NOT show that both callers receive the token: a loser that arrives while
  // the winner is still mid-flight legitimately gets `mint-in-progress`, and
  // this test accepts that. What it does show is that no concurrent read ever
  // mints a SECOND credential and no concurrent read is ever told the code is
  // unknown or spent. Ablating the writeback leaves this test green, which is
  // how the overstated name was caught.
  it("concurrent redemptions never mint twice, and never refuse terminally", async () => {
    const { store, room: r, loadRoom } = await room();
    const { code } = await mintInvite(store, r, "b", T0);

    // Both read the record before either deletes it — the classic
    // time-of-check/time-of-use window. The `del` return value is still the
    // lock; what changed in S#276 is that the loser re-reads and finds the
    // token instead of being refused.
    const [x, y] = await Promise.all([
      redeemInvite(store, code, T0, loadRoom),
      redeemInvite(store, code, T0, loadRoom),
    ]);

    const minted = [x, y].filter((r2) => r2.ok && !r2.reused);
    assert.equal(minted.length, 1, "a code that mints twice is not single-mint");

    for (const outcome of [x, y]) {
      // A loser mid-flight is acceptable and is told to retry; a loser told the
      // code is unknown or spent is the bug this whole change exists to kill.
      if (!outcome.ok) {
        assert.equal(outcome.reason, "mint-in-progress");
        continue;
      }
      assert.equal(outcome.token, minted[0].ok && minted[0].token);
    }
  });

  it("stops re-reading when the window closes, and says already-used not unknown", async () => {
    const { store, room: r, loadRoom } = await room();
    const { code } = await mintInvite(store, r, "b", T0);
    assert.equal((await redeemInvite(store, code, T0, loadRoom)).ok, true);

    const late = await redeemInvite(
      store,
      code,
      plus(T0, (INVITE_REREAD_SECONDS + 1) * 1000),
      loadRoom,
    );
    assert.deepEqual(late, { ok: false, reason: "already-used" });
  });

  it("drops the plaintext token the moment the window closes", async () => {
    // The whole reason the window is short: this record is the only place in
    // the store that holds a live credential in the clear.
    const { store, room: r, loadRoom } = await room();
    const { code } = await mintInvite(store, r, "b", T0);
    const first = await redeemInvite(store, code, T0, loadRoom);
    assert.ok(first.ok);
    if (!first.ok) return;

    assert.match(
      String(await store.get(INVITE_KEY(code))),
      /"token":/,
      "inside the window the plaintext is deliberately there",
    );

    await redeemInvite(store, code, plus(T0, (INVITE_REREAD_SECONDS + 1) * 1000), loadRoom);
    assert.equal(
      await store.get(INVITE_KEY(code)),
      null,
      "past the window the record holding the plaintext must be gone, not just ignored",
    );
  });

  it("a code that was never real says unknown, not already-used", async () => {
    // The tombstone must not make every typo look like a spent code — that
    // would send someone asking for a fresh link when they mistyped one.
    const { store, loadRoom } = await room();
    const never = await redeemInvite(store, "ZZZZ-ZZZZ-ZZZZ", T0, loadRoom);
    assert.deepEqual(never, { ok: false, reason: "unknown" });
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
