import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { authorize, clearRegistryCache, createRoom, issueToken, markJoined } from "../room-registry";
import { OPAQUE_REFUSAL, STOPPED_REFUSAL, whoamiBody, whoamiRefusal } from "../whoami";
import { FakeStore, T0 } from "./fake-store";

beforeEach(() => clearRegistryCache());

async function bridge() {
  const store = new FakeStore();
  const { room, ownerToken, peerToken } = await createRoom(store, {
    topic: "whoami",
    ownerLabel: "JudgeMySite",
    peerLabel: "Gemini",
    now: T0,
  });
  const a = await authorize(store, { presentedToken: ownerToken, now: T0 });
  const b = await authorize(store, { presentedToken: peerToken, now: T0 });
  assert.ok(a.ok && b.ok);
  return { store, room, jms: a.token, gem: b.token };
}

describe("[!!] whoami refusals are INDISTINGUISHABLE — the endpoint must not be an oracle", () => {
  // The failure this prevents: 404 vs 401, or "expired" vs "revoked", lets a
  // prober enumerate rooms and confirm that a token was once real. None of that
  // helps an honest partner, who asks their operator for a fresh token either
  // way. If this test ever fails, whoami has become a reconnaissance tool.
  const reasons = ["unknown-token", "no-token", "revoked", "expired", "wrong-room", "banana"];

  it("every token-related reason yields byte-identical status AND body", () => {
    const shapes = reasons.map((r) => JSON.stringify(whoamiRefusal(r, 503)));
    const distinct = new Set(shapes);
    assert.equal(distinct.size, 1, `expected one shape, got ${distinct.size}: ${[...distinct].join(" | ")}`);
    assert.equal(whoamiRefusal("unknown-token", 503).status, 401);
  });

  it("the refusal carries no identifier — and naming the whole set is not a leak", () => {
    // The distinction this asserts, because it is easy to get backwards:
    // listing every possibility uniformly ("may be revoked, expired, or for a
    // different server") tells a prober NOTHING, because it is the same
    // sentence in all cases. What would leak is an IDENTIFIER — a room id, a
    // side, a token fragment — or a reason stated as the operative one.
    const { body } = whoamiRefusal("revoked", 503);
    for (const identifier of ["roomId", "room_", "tokenId", "sha", "hash", "side a", "side b", "br_live"]) {
      assert.ok(
        !body.error.toLowerCase().includes(identifier.toLowerCase()),
        `refusal text leaks identifier "${identifier}"`,
      );
    }
    // No reason is stated as THE reason: every candidate stays hedged behind "may be".
    assert.match(body.error, /may be/i);
    assert.ok(!/because|reason:|failed:/i.test(body.error), "must not state an operative reason");
    assert.equal(body.error, OPAQUE_REFUSAL);
    assert.equal(body.ok, false);
  });

  it("it tells the caller retrying cannot succeed — a generic 401 invites a loop", () => {
    // The quota incident in one sentence: an agent reads a bare 401 as "try
    // again". Every refusal on this bridge has to close that door in words.
    assert.match(whoamiRefusal("revoked", 503).body.error, /retrying will not change/i);
    assert.match(whoamiRefusal("bridge-disabled", 503).body.error, /retrying cannot succeed/i);
  });

  it("a STOPPED bridge is the one honest exception — and it still says nothing about the token", () => {
    // Collapsing this into the generic refusal would send a partner whose token
    // is perfectly good off to fetch a replacement that fails identically.
    const stopped = whoamiRefusal("bridge-disabled", 503);
    assert.equal(stopped.status, 503);
    assert.equal(stopped.body.error, STOPPED_REFUSAL);
    assert.notEqual(stopped.body.error, OPAQUE_REFUSAL);
    assert.match(stopped.body.error, /your token is not the problem/i);
  });
});

describe("whoami — what a VALID token is told", () => {
  it("returns who you are, who they are, and what to do next", async () => {
    const { room, jms } = await bridge();
    const body = whoamiBody(room, jms);

    assert.equal(body.ok, true);
    assert.equal(body.room.id, room.id);
    assert.equal(body.you.side, "a");
    assert.equal(body.you.label, "JudgeMySite");
    assert.equal(body.peer.label, "Gemini");
    assert.equal(body.you.canWrite, true);
    assert.match(body.next, /bridger_status/);
  });

  it("an answerer is pointed at ping, not status — the tool it does not have", async () => {
    const { store, room } = await bridge();
    const raw = await issueToken(store, room, "b", T0, null, "answerer");
    const out = await authorize(store, { presentedToken: raw, now: T0 });
    assert.ok(out.ok);

    const body = whoamiBody(room, out.token);
    assert.equal(body.you.role, "answerer");
    assert.equal(body.you.canWrite, true, "an answerer writes — smaller surface, not weaker");
    assert.match(body.next, /bridger_ping/);
    assert.ok(!body.next.includes("bridger_status"), "must not name a tool it cannot see");
  });

  it("a viewer is told it cannot write BEFORE it gets refused mid-task", async () => {
    const { store, room } = await bridge();
    const raw = await issueToken(store, room, "b", T0, null, "viewer");
    const out = await authorize(store, { presentedToken: raw, now: T0 });
    assert.ok(out.ok);
    assert.equal(whoamiBody(room, out.token).you.canWrite, false);
  });

  it("surfaces expiry rather than letting a partner discover it by failing", async () => {
    const { store, room } = await bridge();
    const exp = "2026-12-31T00:00:00.000Z";
    const raw = await issueToken(store, room, "b", T0, exp);
    const out = await authorize(store, { presentedToken: raw, now: T0 });
    assert.ok(out.ok);
    assert.equal(whoamiBody(room, out.token).you.expiresAt, exp);
  });

  it("reports whether the peer has actually connected — both states", async () => {
    // Holding a token is NOT connecting. `authorize` resolves a token;
    // `markJoined` records that a side actually reached the server, and only
    // the transport calls it. A partner who has been sent a token but never
    // used it must read as absent, or "have they started?" is unanswerable.
    const { store, room, jms } = await bridge();
    assert.equal(whoamiBody(room, jms).peer.joined, false, "a token in an inbox is not a connection");

    const after = await markJoined(store, room, "b", T0);
    assert.equal(whoamiBody(after, jms).peer.joined, true);
  });
});
