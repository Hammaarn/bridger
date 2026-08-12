import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";

import {
  CACHE_TTL_MS,
  authorize,
  bumpWaitStreak,
  canWrite,
  DENY_MESSAGE,
  resetWaitStreak,
  TERMINAL_DENIALS,
  clearRegistryCache,
  closeRoom,
  createRoom,
  deriveCode,
  disambiguateCode,
  hashToken,
  issueToken,
  parseRoom,
  parseToken,
  revokeSide,
  rotateSide,
  TOKEN_PREFIX,
} from "../room-registry";
import {
  DEFAULT_DAILY_CAP,
  DEFAULT_ROOM_DAILY_CAP,
  KILL_SWITCH,
  RATE_LIMIT_PER_MINUTE,
  ROOM_KEY,
} from "../store";
import { FakeStore, T0, plus } from "./fake-store";

const ORIGINAL_DISABLED = process.env.BRIDGER_DISABLED;

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

beforeEach(() => {
  clearRegistryCache();
  delete process.env.BRIDGER_DISABLED;
});

after(() => {
  if (ORIGINAL_DISABLED === undefined) delete process.env.BRIDGER_DISABLED;
  else process.env.BRIDGER_DISABLED = ORIGINAL_DISABLED;
});

describe("token secrecy", () => {
  it("persists only hashes — a registry dump cannot call the bridge", async () => {
    const { store, ownerToken, peerToken } = await freshRoom();
    const dump = JSON.stringify([...store.kv.entries()]) + JSON.stringify([...store.sets.entries()]);

    assert.equal(dump.includes(ownerToken), false, "owner token found in stored state");
    assert.equal(dump.includes(peerToken), false, "peer token found in stored state");
    assert.equal(dump.includes(hashToken(ownerToken)), true, "hash should be what is stored");
  });

  it("mints two distinct tokens, one per side, with the expected prefix", async () => {
    const { store, ownerToken, peerToken } = await freshRoom();
    assert.notEqual(ownerToken, peerToken);
    assert.ok(ownerToken.startsWith(TOKEN_PREFIX));
    assert.ok(peerToken.startsWith(TOKEN_PREFIX));

    const owner = await authorize(store, { presentedToken: ownerToken, now: T0 });
    const peer = await authorize(store, { presentedToken: peerToken, now: T0 });
    assert.equal(owner.ok && owner.token.side, "a");
    assert.equal(peer.ok && peer.token.side, "b");
    assert.equal(owner.ok && owner.token.code, "JMS");
    assert.equal(peer.ok && peer.token.code, "TRI");
  });

  it("never lets two sides share an entry-ID namespace", async () => {
    const store = new FakeStore();
    const { room } = await createRoom(store, {
      topic: "same name both sides",
      ownerLabel: "Acme",
      peerLabel: "Acme",
      now: T0,
    });
    assert.notEqual(
      room.sides.a.code,
      room.sides.b.code,
      "colliding codes would let one side overwrite the other's entry IDs",
    );
  });
});

describe("authorize — denials", () => {
  it("no token presented", async () => {
    const { store } = await freshRoom();
    const out = await authorize(store, { presentedToken: null, now: T0 });
    assert.deepEqual(out, { ok: false, reason: "no-token" });
  });

  it("no store at all fails CLOSED", async () => {
    const out = await authorize(null, { presentedToken: "br_live_whatever", now: T0 });
    assert.deepEqual(out, { ok: false, reason: "registry-unavailable" });
  });

  it("env kill switch stops the bridge before any read", async () => {
    const { store, ownerToken } = await freshRoom();
    process.env.BRIDGER_DISABLED = "true";
    const out = await authorize(store, { presentedToken: ownerToken, now: T0 });
    assert.deepEqual(out, { ok: false, reason: "bridge-disabled" });
  });

  it("redis kill switch stops the bridge", async () => {
    const { store, ownerToken } = await freshRoom();
    await store.set(KILL_SWITCH, "1");
    const out = await authorize(store, { presentedToken: ownerToken, now: T0 });
    assert.deepEqual(out, { ok: false, reason: "bridge-disabled" });
  });

  it("unknown token", async () => {
    const { store } = await freshRoom();
    const out = await authorize(store, { presentedToken: "br_live_nope", now: T0 });
    assert.deepEqual(out, { ok: false, reason: "unknown-token" });
  });

  it("revoked token", async () => {
    const { store, room, peerToken } = await freshRoom();
    await revokeSide(store, room, "b");
    const out = await authorize(store, { presentedToken: peerToken, now: T0 });
    assert.deepEqual(out, { ok: false, reason: "revoked" });
  });

  it("closed room answers room-closed, not unknown-token", async () => {
    const { store, room, ownerToken } = await freshRoom();
    await closeRoom(store, room);
    const out = await authorize(store, { presentedToken: ownerToken, now: T0 });
    assert.deepEqual(out, { ok: false, reason: "room-closed" });
  });

  it("missing room answers room-missing", async () => {
    const { store, room, ownerToken } = await freshRoom();
    store.kv.delete(ROOM_KEY(room.id));
    clearRegistryCache();
    const out = await authorize(store, { presentedToken: ownerToken, now: T0 });
    assert.deepEqual(out, { ok: false, reason: "room-missing" });
  });
});

describe("authorize — failure behaviour", () => {
  it("fails CLOSED when the registry cannot be read and nothing is cached", async () => {
    const { store, ownerToken } = await freshRoom();
    clearRegistryCache();
    store.failAll();
    const out = await authorize(store, { presentedToken: ownerToken, now: T0 });
    assert.deepEqual(out, { ok: false, reason: "registry-unavailable" });
  });

  it("serves a cached record through a blip, inside the bounded grace", async () => {
    const { store, ownerToken } = await freshRoom();
    const warm = await authorize(store, { presentedToken: ownerToken, now: T0 });
    assert.equal(warm.ok, true);

    store.failWhen = (k) => k.startsWith("bridger:tok:") || k.startsWith("bridger:room:");
    const during = await authorize(store, {
      presentedToken: ownerToken,
      now: plus(T0, CACHE_TTL_MS * 1.5),
    });
    assert.equal(during.ok, true, "a single blip must not drop a partner mid-integration");
  });

  it("STOPS once the blip outlives the grace window", async () => {
    const { store, ownerToken } = await freshRoom();
    await authorize(store, { presentedToken: ownerToken, now: T0 });

    store.failAll();
    const after2x = await authorize(store, {
      presentedToken: ownerToken,
      now: plus(T0, CACHE_TTL_MS * 2 + 1),
    });
    assert.deepEqual(after2x, { ok: false, reason: "registry-unavailable" });
  });

  it("a revocation is never outlived by the cache", async () => {
    const { store, room, peerToken } = await freshRoom();
    const warm = await authorize(store, { presentedToken: peerToken, now: T0 });
    assert.equal(warm.ok, true);

    await revokeSide(store, room, "b"); // clears the cache as part of the mutation
    const out = await authorize(store, { presentedToken: peerToken, now: plus(T0, 1) });
    assert.deepEqual(out, { ok: false, reason: "revoked" });
  });
});

describe("budget — the loop that burned a quota", () => {
  it("stops at the daily cap, and the refusal is TERMINAL", async () => {
    const { store, ownerToken } = await freshRoom();
    // Spread across minutes so the per-minute limit is not what stops us.
    let last: Awaited<ReturnType<typeof authorize>> | null = null;
    for (let i = 0; i <= DEFAULT_DAILY_CAP; i++) {
      last = await authorize(store, {
        presentedToken: ownerToken,
        now: plus(T0, Math.floor(i / 10) * 60_000),
      });
      if (!last.ok) break;
    }
    assert.deepEqual(last, { ok: false, reason: "daily-cap" });
    assert.equal(TERMINAL_DENIALS.has("daily-cap"), true);
    assert.match(DENY_MESSAGE["daily-cap"], /^STOP\./, "an agent must read this as terminal");
    assert.match(DENY_MESSAGE["daily-cap"], /Do not call any bridger tool again/);
  });

  it("`charge: false` reads the token without spending budget", async () => {
    const { store, ownerToken } = await freshRoom();
    for (let i = 0; i < 200; i++) {
      const out = await authorize(store, { presentedToken: ownerToken, now: T0, charge: false });
      assert.equal(out.ok, true);
    }
    // The whole per-minute allowance must still be intact.
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) {
      assert.equal((await authorize(store, { presentedToken: ownerToken, now: T0 })).ok, true);
    }
    assert.deepEqual(await authorize(store, { presentedToken: ownerToken, now: T0 }), {
      ok: false,
      reason: "rate-limited",
    });
  });

  it("every refusal that is terminal says STOP first", () => {
    for (const reason of TERMINAL_DENIALS) {
      assert.match(DENY_MESSAGE[reason], /^STOP/, `${reason} must not read as retryable`);
    }
  });

  it("counts the empty-wait streak and resets it when something lands", async () => {
    const { store } = await freshRoom();
    assert.equal(await bumpWaitStreak(store, "tok1"), 1);
    assert.equal(await bumpWaitStreak(store, "tok1"), 2);
    assert.equal(await bumpWaitStreak(store, "tok1"), 3);
    await resetWaitStreak(store, "tok1");
    assert.equal(await bumpWaitStreak(store, "tok1"), 1, "an arrival ends the streak");
  });

  it("a bookkeeping failure never refuses a call that was otherwise fine", async () => {
    const { store } = await freshRoom();
    store.failAll();
    assert.equal(await bumpWaitStreak(store, "tok1"), 0, "streak counting is best-effort");
  });
});

describe("rate limiting", () => {
  it("refuses past the per-minute cap and recovers in the next bucket", async () => {
    const { store, ownerToken } = await freshRoom();
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) {
      const out = await authorize(store, { presentedToken: ownerToken, now: T0 });
      assert.equal(out.ok, true, `call ${i + 1} should be allowed`);
    }
    const over = await authorize(store, { presentedToken: ownerToken, now: T0 });
    assert.deepEqual(over, { ok: false, reason: "rate-limited" });

    const nextMinute = await authorize(store, {
      presentedToken: ownerToken,
      now: plus(T0, 60_000),
    });
    assert.equal(nextMinute.ok, true, "a new minute is a new bucket");
  });

  it("an earlier denial does not consume the caller's budget", async () => {
    const { store, room, ownerToken } = await freshRoom();
    await closeRoom(store, room);
    for (let i = 0; i < 10; i++) {
      await authorize(store, { presentedToken: ownerToken, now: T0 });
    }
    // Reopen and confirm the full budget survived the refusals.
    await store.set(ROOM_KEY(room.id), JSON.stringify({ ...room, closed: false }));
    clearRegistryCache();
    const out = await authorize(store, { presentedToken: ownerToken, now: T0 });
    assert.equal(out.ok, true);
  });
});

describe("rotation", () => {
  it("rotate issues a working token and leaves the old one REVOKED, not unknown", async () => {
    const { store, room, peerToken } = await freshRoom();
    const fresh = await rotateSide(store, room, "b", plus(T0, 1000));

    const old = await authorize(store, { presentedToken: peerToken, now: plus(T0, 2000) });
    assert.deepEqual(
      old,
      { ok: false, reason: "revoked" },
      "a rotated-out token must say revoked — unknown-token reads like a typo",
    );

    const now = await authorize(store, { presentedToken: fresh, now: plus(T0, 2000) });
    assert.equal(now.ok, true);
    assert.equal(now.ok && now.token.side, "b");
  });

  it("rotating one side does not disturb the other", async () => {
    const { store, room, ownerToken } = await freshRoom();
    await rotateSide(store, room, "b", plus(T0, 1000));
    const owner = await authorize(store, { presentedToken: ownerToken, now: plus(T0, 2000) });
    assert.equal(owner.ok, true);
  });
});

describe("viewer role", () => {
  it("a viewer authenticates and reads, but cannot write", async () => {
    const { store, room } = await freshRoom();
    const viewerToken = await issueToken(store, room, "a", T0, null, "viewer");

    const out = await authorize(store, { presentedToken: viewerToken, now: T0 });
    assert.equal(out.ok, true, "a viewer must still authenticate — it is allowed to read");
    assert.equal(out.ok && out.token.role, "viewer");
    assert.equal(out.ok && canWrite(out.token), false);
  });

  it("a participant can write", async () => {
    const { store, ownerToken } = await freshRoom();
    const out = await authorize(store, { presentedToken: ownerToken, now: T0 });
    assert.equal(out.ok && out.token.role, "participant");
    assert.equal(out.ok && canWrite(out.token), true);
  });

  it("a token minted before roles existed still writes — no silent downgrade", () => {
    const legacy = parseToken(
      JSON.stringify({ id: "abc123456789", roomId: "r1", side: "a", label: "X", code: "XXX" }),
    );
    assert.equal(legacy?.role, "participant");
    assert.equal(canWrite(legacy!), true);
  });

  it("a corrupted role value fails SAFE for the partner, not closed", () => {
    const weird = parseToken(
      JSON.stringify({ id: "abc123456789", roomId: "r1", side: "a", role: "nonsense" }),
    );
    assert.equal(weird?.role, "participant", "only the exact string 'viewer' restricts");
  });

  it("rotating a side does NOT blind its viewer", async () => {
    const { store, room } = await freshRoom();
    const viewerToken = await issueToken(store, room, "b", T0, null, "viewer");
    await rotateSide(store, room, "b", plus(T0, 1000));

    const viewer = await authorize(store, { presentedToken: viewerToken, now: plus(T0, 2000) });
    assert.equal(
      viewer.ok,
      true,
      "rotating a leaked participant token must not silently kill an unrelated watcher",
    );
  });

  it("revoking a side with no role filter kills the viewer too", async () => {
    const { store, room } = await freshRoom();
    const viewerToken = await issueToken(store, room, "b", T0, null, "viewer");
    await revokeSide(store, room, "b");

    const viewer = await authorize(store, { presentedToken: viewerToken, now: plus(T0, 1) });
    assert.deepEqual(viewer, { ok: false, reason: "revoked" }, "'this partner is gone' means all of it");
  });
});

describe("deriveCode", () => {
  it("is deterministic and readable for the label shapes we expect", () => {
    assert.equal(deriveCode("JudgeMySite"), "JMS", "internal capitals win when there are >=2");
    assert.equal(deriveCode("Northwind"), "TRI", "one capital is not an acronym — take 3 letters");
    assert.equal(deriveCode("acme corp"), "ACX");
    assert.equal(deriveCode("Big Red Widget Co"), "BRW");
    assert.equal(deriveCode(""), "XXX");
    assert.equal(deriveCode("!!!"), "XXX");
    assert.equal(deriveCode("x"), "XXX");
  });

  it("disambiguates only when it must", () => {
    assert.equal(disambiguateCode("JMS", "TRI"), "JMS", "distinct codes are left alone");
    assert.equal(disambiguateCode("ACM", "ACM"), "ACB");
    assert.notEqual(disambiguateCode("ACM", "ACM"), "ACM");
  });
});

describe("parseRoom", () => {
  it("survives a malformed record rather than throwing into the auth path", () => {
    assert.equal(parseRoom(null), null);
    assert.equal(parseRoom("not json"), null);
    assert.equal(parseRoom(JSON.stringify({ nope: 1 })), null);
    const ok = parseRoom(JSON.stringify({ id: "r1" }));
    assert.equal(ok?.sides.a.code, "XXX");
    assert.equal(ok?.closed, false);
  });
});

describe("per-room budget — the ceiling a token cap cannot express", () => {
  /**
   * Rewrite the room's cap so these tests exercise the MECHANISM at small
   * numbers instead of burning 600 authorize calls to re-assert a constant.
   * The constant gets its own test below.
   */
  async function setRoomCap(store: FakeStore, roomId: string, cap: number) {
    const room = parseRoom(await store.get(ROOM_KEY(roomId)));
    await store.set(ROOM_KEY(roomId), JSON.stringify({ ...room, dailyCap: cap }));
    clearRegistryCache();
  }

  /** Spread calls over minutes so the per-minute limiter is never what stops us. */
  const spread = (i: number) => plus(T0, Math.floor(i / 10) * 60_000);

  it("CLOSES THE ROTATION BYPASS — a fresh token inherits the room's spend", async () => {
    const { store, room, ownerToken } = await freshRoom();
    await setRoomCap(store, room.id, 3);

    for (let i = 0; i < 3; i++) {
      assert.equal((await authorize(store, { presentedToken: ownerToken, now: spread(i) })).ok, true);
    }

    // The operator's honest response to a refusal: mint a new token.
    const rotated = await rotateSide(store, room, "a", T0);
    assert.notEqual(rotated, ownerToken, "rotation really did issue a different token");

    // Its OWN daily counter is at zero — before the room counter existed this
    // is exactly where a looping agent got a full budget back.
    const out = await authorize(store, { presentedToken: rotated, now: spread(3) });
    assert.deepEqual(out, { ok: false, reason: "room-daily-cap" });
  });

  it("two tokens on one room share the ceiling instead of each getting one", async () => {
    const { store, room, ownerToken, peerToken } = await freshRoom();
    await setRoomCap(store, room.id, 4);

    for (let i = 0; i < 2; i++) {
      assert.equal((await authorize(store, { presentedToken: ownerToken, now: spread(i) })).ok, true);
    }
    for (let i = 2; i < 4; i++) {
      assert.equal((await authorize(store, { presentedToken: peerToken, now: spread(i) })).ok, true);
    }

    assert.deepEqual(await authorize(store, { presentedToken: peerToken, now: spread(4) }), {
      ok: false,
      reason: "room-daily-cap",
    });
    assert.deepEqual(
      await authorize(store, { presentedToken: ownerToken, now: spread(5) }),
      { ok: false, reason: "room-daily-cap" },
      "the ceiling binds both sides, not just whoever crossed it",
    );
  });

  it("reports the NARROWEST limit — a token over its own cap is told so, not blamed on the room", async () => {
    const { store, room, ownerToken } = await freshRoom();
    // Room cap generous; the token's own cap is the binding one.
    await setRoomCap(store, room.id, 10_000);
    const hash = hashToken(ownerToken);
    const token = parseToken(await store.get(`bridger:tok:${hash}`));
    await store.set(`bridger:tok:${hash}`, JSON.stringify({ ...token, dailyCap: 2 }));
    clearRegistryCache();

    for (let i = 0; i < 2; i++) {
      assert.equal((await authorize(store, { presentedToken: ownerToken, now: spread(i) })).ok, true);
    }
    assert.deepEqual(
      await authorize(store, { presentedToken: ownerToken, now: spread(2) }),
      { ok: false, reason: "daily-cap" },
      "the two refusals send an operator to different places, so they must stay distinguishable",
    );
  });

  it("a room over its cap does not spend the caller's per-minute allowance for nothing", async () => {
    const { store, room, ownerToken } = await freshRoom();
    await setRoomCap(store, room.id, 1);
    assert.equal((await authorize(store, { presentedToken: ownerToken, now: T0 })).ok, true);
    // Refused for the room, not the minute — the reason must not degrade into
    // `rate-limited`, which reads as retryable and is the wrong instruction.
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(await authorize(store, { presentedToken: ownerToken, now: T0 }), {
        ok: false,
        reason: "room-daily-cap",
      });
    }
  });

  it("a room stored before room caps existed gets the default, never Infinity", () => {
    const legacy = parseRoom(JSON.stringify({ id: "r1", topic: "t", closed: false }));
    assert.equal(legacy?.dailyCap, DEFAULT_ROOM_DAILY_CAP);
    assert.equal(Number.isFinite(legacy?.dailyCap), true, "an uncapped bridge is the bug");
  });

  it("the default room cap BINDS — it is below two full token caps", () => {
    assert.ok(
      DEFAULT_ROOM_DAILY_CAP < 2 * DEFAULT_DAILY_CAP,
      "a room cap equal to the sum of its tokens' caps can never be the binding constraint, " +
        "which makes it decoration — the mistake the 120/min rate limit already taught us",
    );
    assert.ok(DEFAULT_ROOM_DAILY_CAP > DEFAULT_DAILY_CAP, "one side alone must not trip the room");
  });

  it("`room-daily-cap` is terminal, and tells the operator NOT to rotate", () => {
    assert.equal(TERMINAL_DENIALS.has("room-daily-cap"), true);
    assert.match(DENY_MESSAGE["room-daily-cap"], /^STOP\./);
    assert.match(
      DENY_MESSAGE["room-daily-cap"],
      /do not ask for a replacement token/i,
      "the counter closes the rotation path; the message has to close it in words too",
    );
  });
});
