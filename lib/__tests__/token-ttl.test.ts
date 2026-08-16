import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { authorize, clearRegistryCache, createRoom, issueToken } from "../room-registry";
import { DEFAULT_TOKEN_TTL_DAYS } from "../store";
import { FakeStore, T0 } from "./fake-store";

beforeEach(() => clearRegistryCache());

const DAY = 24 * 60 * 60 * 1000;

async function room() {
  const store = new FakeStore();
  const created = await createRoom(store, {
    topic: "ttl",
    ownerLabel: "Us",
    peerLabel: "Them",
    now: T0,
  });
  return { store, ...created };
}

describe("token lifetime — 'forever' has to be asked for now", () => {
  it("[!!] a token minted by createRoom EXPIRES", async () => {
    const { store, ownerToken } = await room();
    const out = await authorize(store, { presentedToken: ownerToken, now: T0 });
    assert.ok(out.ok);
    assert.notEqual(
      out.token.expiresAt,
      null,
      "every token minted before S#275 was immortal because `null` was positional filler",
    );
  });

  it(`that expiry is ${DEFAULT_TOKEN_TTL_DAYS} days out`, async () => {
    const { store, ownerToken } = await room();
    const out = await authorize(store, { presentedToken: ownerToken, now: T0 });
    assert.ok(out.ok && out.token.expiresAt);
    const days = (new Date(out.token.expiresAt).getTime() - T0.getTime()) / DAY;
    assert.equal(Math.round(days), DEFAULT_TOKEN_TTL_DAYS);
  });

  it("[!!] and it actually refuses once that date passes", async () => {
    const { store, ownerToken } = await room();
    const before = await authorize(store, {
      presentedToken: ownerToken,
      now: new Date(T0.getTime() + (DEFAULT_TOKEN_TTL_DAYS - 1) * DAY),
    });
    assert.equal(before.ok, true, "still valid the day before");

    clearRegistryCache();
    const after = await authorize(store, {
      presentedToken: ownerToken,
      now: new Date(T0.getTime() + (DEFAULT_TOKEN_TTL_DAYS + 1) * DAY),
    });
    assert.equal(after.ok, false);
    assert.equal(after.ok === false && after.reason, "expired");
  });

  it("a viewer and an answerer expire too — the roles were the worst filler offenders", async () => {
    const { store, room: r } = await room();
    for (const role of ["viewer", "answerer"] as const) {
      const raw = await issueToken(store, r, "b", T0, undefined, role);
      clearRegistryCache();
      const out = await authorize(store, { presentedToken: raw, now: T0 });
      assert.ok(out.ok, `${role} should authorise`);
      assert.notEqual(out.token.expiresAt, null, `${role} must not be immortal`);
    }
  });

  it("an explicit null still means forever — the escape hatch survives, it just has to be written", async () => {
    const { store, room: r } = await room();
    const raw = await issueToken(store, r, "b", T0, null);
    clearRegistryCache();
    const out = await authorize(store, { presentedToken: raw, now: T0 });
    assert.ok(out.ok);
    assert.equal(out.token.expiresAt, null);
  });

  it("an explicit date is honoured over the default", async () => {
    const { store, room: r } = await room();
    const exp = new Date(T0.getTime() + 3 * DAY).toISOString();
    const raw = await issueToken(store, r, "b", T0, exp);
    clearRegistryCache();
    const out = await authorize(store, { presentedToken: raw, now: T0 });
    assert.ok(out.ok);
    assert.equal(out.token.expiresAt, exp);
  });
});
