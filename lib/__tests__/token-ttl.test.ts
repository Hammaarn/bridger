import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  authorize,
  clearRegistryCache,
  createRoom,
  hashToken,
  issueToken,
  revokeSide,
} from "../room-registry";
import {
  DEFAULT_TOKEN_TTL_DAYS,
  ROOM_TTL_SECONDS,
  TOKEN_KEY,
  TOKEN_RENEW_WITHIN_DAYS,
} from "../store";
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
    // [S#286] REWRITTEN, and the reason is the feature. This used to call at
    // day 89 to prove "still valid the day before", then at day 91 to prove
    // "expired". Renewal makes those two facts incompatible: the day-89 call
    // now pushes the expiry out, which is precisely what it is for. So the
    // boundary is asserted on a token nobody touches, and the "still valid the
    // day before" half moved to its own test below, where it belongs.
    const { store, ownerToken } = await room();

    // One early call, deliberately OUTSIDE the renewal window, so we know the
    // token is live without that observation changing its expiry.
    const early = await authorize(store, {
      presentedToken: ownerToken,
      now: new Date(T0.getTime() + 30 * DAY),
    });
    assert.equal(early.ok, true, "valid at 30 days, and untouched by renewal");
    assert.equal(
      early.ok === true && (early.token.renewedAt ?? null),
      null,
      "60 days of life left is not inside the window -- if this ever renews, the window is wrong",
    );

    clearRegistryCache();
    const after = await authorize(store, {
      presentedToken: ownerToken,
      now: new Date(T0.getTime() + (DEFAULT_TOKEN_TTL_DAYS + 1) * DAY),
    });
    assert.equal(after.ok, false);
    assert.equal(after.ok === false && after.reason, "expired");
  });

  it("[!!] but a token that was USED near its expiry survives it — the whole point", async () => {
    const { store, ownerToken } = await room();
    const used = await authorize(store, {
      presentedToken: ownerToken,
      now: new Date(T0.getTime() + (DEFAULT_TOKEN_TTL_DAYS - 1) * DAY),
    });
    assert.ok(used.ok, "still valid the day before");

    clearRegistryCache();
    const later = await authorize(store, {
      presentedToken: ownerToken,
      now: new Date(T0.getTime() + (DEFAULT_TOKEN_TTL_DAYS + 1) * DAY),
    });
    assert.ok(
      later.ok,
      "before S#286 this was a 401 that deregistered the operator's MCP tools mid-session",
    );
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

/**
 * THE S#286 REGRESSION SET.
 *
 * Note what the pre-existing suite above could NOT catch, because it is the
 * same shape as the `Vary: Accept` miss in S#285: "and it actually refuses once
 * that date passes" passed throughout, and the token was dying 60 days earlier
 * than that test asserts -- by KEY EVICTION, which `FakeStore` does not
 * simulate and a local dev server has no way to show you. The suite was testing
 * the field while production was killed by the fuse.
 *
 * So these assert the FUSE, not the field.
 */
describe("[S#286] the record must outlive the credential it describes", () => {
  it("[!!] a token's key fuse is longer than its own expiry, not the room constant", async () => {
    const { store, ownerToken } = await room();
    const ttl = store.ttlOf(TOKEN_KEY(hashToken(ownerToken)));
    assert.ok(ttl !== undefined, "the token record must carry a fuse at all");

    const secondsToExpiry = DEFAULT_TOKEN_TTL_DAYS * 24 * 60 * 60;
    assert.ok(
      ttl! > secondsToExpiry,
      `fuse ${ttl}s must outlive the ${secondsToExpiry}s expiry it describes -- ` +
        `before S#286 it was ROOM_TTL_SECONDS (${ROOM_TTL_SECONDS}s), so the record ` +
        `was evicted at 30 days and the refusal degraded to unknown-token`,
    );
  });

  it("[!!] revoking does not make the record immortal", async () => {
    const { store, room: r, ownerToken } = await room();
    const key = TOKEN_KEY(hashToken(ownerToken));
    assert.ok(store.ttlOf(key) !== undefined, "precondition: minted with a fuse");

    await revokeSide(store, r, "a");
    assert.ok(
      store.ttlOf(key) !== undefined,
      "bare SET clears a TTL in Redis, so every revoked token used to leak a permanent key",
    );

    clearRegistryCache();
    const out = await authorize(store, { presentedToken: ownerToken, now: T0 });
    assert.equal(out.ok === false && out.reason, "revoked", "and it must still say revoked");
  });
});

describe("[S#286] renew on use — the self-maintaining half", () => {
  const at = (days: number) => new Date(T0.getTime() + days * DAY);

  it("does NOT renew a token that is nowhere near expiry", async () => {
    // The negative control. Without it, "renewal works" is indistinguishable
    // from "we rewrite the token on every single call", which would be a
    // database cost bug wearing a feature's clothes.
    const { store, ownerToken } = await room();
    const out = await authorize(store, { presentedToken: ownerToken, now: at(1) });
    assert.ok(out.ok);
    assert.equal(out.token.renewedAt ?? null, null, "a young token must not be rewritten");
    const days = (Date.parse(out.token.expiresAt!) - T0.getTime()) / DAY;
    assert.equal(Math.round(days), DEFAULT_TOKEN_TTL_DAYS, "its expiry must be untouched");
  });

  it("[!!] renews a token that has dropped into the window, without changing the string", async () => {
    const { store, ownerToken } = await room();
    const when = at(DEFAULT_TOKEN_TTL_DAYS - TOKEN_RENEW_WITHIN_DAYS + 1);
    const out = await authorize(store, { presentedToken: ownerToken, now: when });
    assert.ok(out.ok);

    const left = (Date.parse(out.token.expiresAt!) - when.getTime()) / DAY;
    assert.equal(Math.round(left), DEFAULT_TOKEN_TTL_DAYS, "expiry pushed back to a full term");
    assert.ok(out.token.renewedAt, "and stamped, so an operator can see it is being kept alive");

    // THE POINT OF THE WHOLE FEATURE: same credential, still works. If this
    // ever fails, the operator is back to paste-and-restart.
    clearRegistryCache();
    const again = await authorize(store, { presentedToken: ownerToken, now: when });
    assert.ok(again.ok, "the SAME token string must still authorise after renewal");
  });

  it("keeps an in-use token alive indefinitely across renewal periods", async () => {
    const { store, ownerToken } = await room();
    let now = T0;
    for (let i = 0; i < 8; i += 1) {
      now = new Date(now.getTime() + (DEFAULT_TOKEN_TTL_DAYS - TOKEN_RENEW_WITHIN_DAYS + 1) * DAY);
      clearRegistryCache();
      const out = await authorize(store, { presentedToken: ownerToken, now });
      assert.ok(out.ok, `still valid after ${i + 1} renewal period(s) — roughly ${((i + 1) * 61 / 365).toFixed(1)} years`);
    }
  });

  it("still lets an ABANDONED token die on the original clock", async () => {
    // The security property from `DEFAULT_TOKEN_TTL_DAYS` must survive: renewal
    // is driven by traffic, so no traffic means no renewal.
    const { store, ownerToken } = await room();
    const out = await authorize(store, {
      presentedToken: ownerToken,
      now: at(DEFAULT_TOKEN_TTL_DAYS + 1),
    });
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.reason, "expired");
  });

  it("does not try to renew an explicitly immortal token", async () => {
    const { store, room: r } = await room();
    const raw = await issueToken(store, r, "b", T0, null);
    clearRegistryCache();
    const out = await authorize(store, { presentedToken: raw, now: at(400) });
    assert.ok(out.ok);
    assert.equal(out.token.expiresAt, null);
    assert.equal(out.token.renewedAt ?? null, null);
  });

  it("renews on the MINIMAL path too — the listener is what runs unattended", async () => {
    const { store, ownerToken } = await room();
    const when = at(DEFAULT_TOKEN_TTL_DAYS - TOKEN_RENEW_WITHIN_DAYS + 1);
    const out = await authorize(store, { presentedToken: ownerToken, now: when, minimal: true });
    assert.ok(out.ok);
    assert.ok(
      out.token.renewedAt,
      "/api/since is the cheapest path and the one most likely to be running while nobody watches",
    );
  });
});
