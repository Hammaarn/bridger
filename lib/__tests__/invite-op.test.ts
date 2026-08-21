import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { redeemInvite } from "../invites";
import { OperationRefused, opInvite } from "../operations";
import {
  clearRegistryCache,
  createRoom,
  parseRoom,
  type RoomRecord,
  type SideId,
  type TokenRecord,
} from "../room-registry";
import { INVITE_KEY, ROOM_INVITE_KEY, ROOM_KEY } from "../store";
import { FakeStore, T0, plus } from "./fake-store";

/**
 * THE BROWSER'S INVITE BUTTON — the rule, not the button.
 *
 * Until S#279 invites were CLI-only, so the browser flow's only handoff was the
 * raw `br_live_...` token on the minted screen: the recommended way to invite a
 * partner was to paste a live credential into a durable chat message. That is
 * the exact artefact a partner's AI is right to refuse — Trigvanta's Claude
 * declined precisely that in S#275 and was correct to.
 *
 * These exercise `opInvite`, which is where the guards live so both transports
 * inherit them (invariant 11). The button is one caller of it.
 */

beforeEach(() => clearRegistryCache());

const PASTE = process.env.BRIDGER_PASTE_PATH;

/** Restores the flag even when the body throws, so one case cannot poison the next. */
async function withPastePath(value: string | undefined, fn: () => Promise<void>) {
  const before = process.env.BRIDGER_PASTE_PATH;
  if (value === undefined) delete process.env.BRIDGER_PASTE_PATH;
  else process.env.BRIDGER_PASTE_PATH = value;
  try {
    await fn();
  } finally {
    if (before === undefined) delete process.env.BRIDGER_PASTE_PATH;
    else process.env.BRIDGER_PASTE_PATH = before;
  }
}

async function bridge() {
  const store = new FakeStore();
  const created = await createRoom(store, {
    topic: "Orders API",
    ownerLabel: "JudgeMySite",
    peerLabel: "Trigvanta",
    now: T0,
  });
  const loadRoom = async (id: string): Promise<RoomRecord | null> =>
    parseRoom(await store.get(ROOM_KEY(id)));
  return { store, room: created.room, loadRoom };
}

function token(room: RoomRecord, side: SideId, role: TokenRecord["role"]): TokenRecord {
  return {
    id: `tok-${side}-${role}`,
    roomId: room.id,
    side,
    label: room.sides[side].label,
    code: room.sides[side].code,
    role,
    dailyCap: 400,
    active: true,
    createdAt: T0.toISOString(),
    expiresAt: null,
  };
}

const ctxOf = (store: FakeStore, room: RoomRecord, tok: TokenRecord, now = T0) => ({
  store,
  room,
  token: tok,
  now,
});

describe("opInvite — the join link the browser could not make", () => {
  it("mints a link for the OTHER seat by default — inviting is what you do to a partner", async () =>
    await withPastePath("1", async () => {
      const { store, room } = await bridge();
      const out = await opInvite(ctxOf(store, room, token(room, "a", "participant")), {});
      assert.equal(out.forSide, "b");
      assert.equal(out.forLabel, "Trigvanta");
      assert.match(out.joinPath, /^\/j\/[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      assert.equal(out.replacedPreviousLink, false, "nothing to replace on the first call");
    }));

  it("hands back a code that actually redeems, for the side it names", async () =>
    await withPastePath("1", async () => {
      const { store, room, loadRoom } = await bridge();
      const out = await opInvite(ctxOf(store, room, token(room, "a", "participant")), {});
      const redeemed = await redeemInvite(store, out.code, T0, loadRoom);
      assert.equal(redeemed.ok, true);
      assert.equal(redeemed.ok && redeemed.invite.side, "b");
    }));

  it("[!!] a VIEWER cannot mint a credential for anyone", async () =>
    await withPastePath("1", async () => {
      const { store, room } = await bridge();
      await assert.rejects(
        () => opInvite(ctxOf(store, room, token(room, "a", "viewer")), {}),
        (e: unknown) => e instanceof OperationRefused && e.terminal,
      );
      // Negative control on the STORE, not just on the throw: a refusal that
      // still wrote an invite would pass an exception-only assertion.
      assert.equal(await store.get(ROOM_INVITE_KEY(room.id, "b")), null);
    }));

  it("[!!] refuses when join links are switched off, rather than minting a link that 404s", async () =>
    await withPastePath(undefined, async () => {
      const { store, room } = await bridge();
      await assert.rejects(
        () => opInvite(ctxOf(store, room, token(room, "a", "participant")), {}),
        (e: unknown) =>
          e instanceof OperationRefused && e.terminal && /switched off/i.test(e.message),
      );
      assert.equal(
        await store.get(ROOM_INVITE_KEY(room.id, "b")),
        null,
        "a real credential behind a dead door is the worst of both",
      );
    }));

  it("[!!] a second link SUPERSEDES the first — two live codes for one seat is the bug", async () =>
    await withPastePath("1", async () => {
      const { store, room, loadRoom } = await bridge();
      const ctx = ctxOf(store, room, token(room, "a", "participant"));

      const first = await opInvite(ctx, {});
      const second = await opInvite(ctx, {});

      assert.notEqual(first.code, second.code);
      assert.equal(second.replacedPreviousLink, true);
      assert.equal(await store.get(INVITE_KEY(first.code)), null, "the old code is gone");

      // The one that matters: the old link no longer buys anything.
      const dead = await redeemInvite(store, first.code, T0, loadRoom);
      assert.equal(dead.ok, false);

      // Positive control in the same breath — a refusal only means something
      // beside an acceptance.
      const live = await redeemInvite(store, second.code, T0, loadRoom);
      assert.equal(live.ok, true);
    }));

  it("[!!] does NOT supersede a link that has already been redeemed — the re-read window is load-bearing", async () =>
    await withPastePath("1", async () => {
      const { store, room, loadRoom } = await bridge();
      const ctx = ctxOf(store, room, token(room, "a", "participant"));

      const first = await opInvite(ctx, {});
      const redeemed = await redeemInvite(store, first.code, T0, loadRoom);
      assert.equal(redeemed.ok, true);

      const second = await opInvite(ctx, {});
      assert.equal(second.replacedPreviousLink, false);

      // The far side may be mid-retry on the first link. Destroying it there is
      // how the first live partner demo died (S#276) — the same token must keep
      // coming back for the whole window.
      const again = await redeemInvite(store, first.code, plus(T0, 60_000), loadRoom);
      assert.equal(again.ok, true, "a redeemed code stays re-readable");
      assert.equal(
        again.ok && again.token,
        redeemed.ok && redeemed.token,
        "and it is the SAME credential, not a second one",
      );
    }));

  it("invites your own seat when asked — a token lost with a laptop is a real case", async () =>
    await withPastePath("1", async () => {
      const { store, room } = await bridge();
      const out = await opInvite(ctxOf(store, room, token(room, "a", "participant")), { side: "a" });
      assert.equal(out.forSide, "a");
      assert.equal(out.forLabel, "JudgeMySite");
    }));

  it("clamps the tunables instead of trusting them", async () =>
    await withPastePath("1", async () => {
      const { store, room } = await bridge();
      const ctx = ctxOf(store, room, token(room, "a", "participant"));

      const huge = await opInvite(ctx, { ttlMinutes: 99999, tokenDays: 99999 });
      assert.equal(huge.linkExpiresInMinutes, 1440);
      assert.equal(huge.tokenExpiresInDays, 90);

      const tiny = await opInvite(ctx, { ttlMinutes: 0, tokenDays: 0 });
      assert.equal(tiny.linkExpiresInMinutes, 5);
      assert.equal(tiny.tokenExpiresInDays, 1);

      const nonsense = await opInvite(ctx, { ttlMinutes: Number.NaN });
      assert.equal(nonsense.linkExpiresInMinutes, 30, "NaN falls back to the default, not to 5");
    }));

  it("the pointer names the code, so nothing has to scan to find the live link", async () =>
    await withPastePath("1", async () => {
      const { store, room } = await bridge();
      const out = await opInvite(ctxOf(store, room, token(room, "a", "participant")), {});
      assert.equal(await store.get(ROOM_INVITE_KEY(room.id, "b")), out.code);
    }));

  it("the environment is left exactly as it was found", () => {
    assert.equal(process.env.BRIDGER_PASTE_PATH, PASTE);
  });
});
