import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  appendEntry,
  describeContractChange,
  getStatus,
  openQuestions,
  readEntries,
  setContract,
  signOffs,
} from "../entries";
import { authorize, clearRegistryCache, createRoom, parseRoom, type RoomRecord } from "../room-registry";
import { opPurge, opReopen, opSignoff } from "../operations";
import { executePurge, purgeState, recordPurgeConsent } from "../purge";
import { mintInvite, redeemInvite } from "../invites";
import { ENTRIES_KEY, PASTE_PATH_DAILY_CAP, ROOM_KEY, TOKEN_KEY } from "../store";
import { hashToken } from "../room-registry";
import { FakeStore, T0, plus } from "./fake-store";

beforeEach(() => clearRegistryCache());

async function bridge() {
  const store = new FakeStore();
  const { room, ownerToken, peerToken } = await createRoom(store, {
    topic: "lifecycle",
    ownerLabel: "JudgeMySite",
    peerLabel: "Trigvanta",
    now: T0,
  });
  const a = await authorize(store, { presentedToken: ownerToken, now: T0 });
  const b = await authorize(store, { presentedToken: peerToken, now: T0 });
  assert.ok(a.ok && b.ok);
  return { store, room, jms: a.token, tri: b.token };
}

const ctx = (store: FakeStore, room: RoomRecord, token: any, now = T0) => ({ store, room, token, now });

describe("D4a — a question stays closed only while the asker accepts it", () => {
  it("reopening puts it back on their list", async () => {
    const { store, room, jms, tri } = await bridge();
    const q = await appendEntry(store, room, jms, { type: "question", title: "grade?", body: "" }, T0);
    await appendEntry(
      store,
      room,
      tri,
      { type: "answer", title: "maybe", body: "maybe", answers: q.id },
      plus(T0, 1000),
    );

    assert.equal(openQuestions(await readEntries(store, room.id), "b").length, 0, "answered = closed");

    await opReopen(ctx(store, room, jms, plus(T0, 2000)), {
      questionId: q.id,
      why: "that is a different question — I asked about the verdict event",
    });

    const open = openQuestions(await readEntries(store, room.id), "b");
    assert.equal(open.length, 1, "the asker said it was not answered, so it is open");
    assert.equal(open[0].reopened, true);
    assert.equal(open[0].yours, true, "and it is THEIR turn again");
  });

  it("a later answer closes it again — newest wins, compared by seq", async () => {
    const { store, room, jms, tri } = await bridge();
    const q = await appendEntry(store, room, jms, { type: "question", title: "grade?", body: "" }, T0);
    await appendEntry(store, room, tri, { type: "answer", title: "x", body: "x", answers: q.id }, T0);
    await opReopen(ctx(store, room, jms), { questionId: q.id, why: "no" });
    await appendEntry(store, room, tri, { type: "answer", title: "y", body: "y", answers: q.id }, T0);

    assert.equal(openQuestions(await readEntries(store, room.id), "b").length, 0);
  });

  it("only the ASKER may reopen — otherwise the signal means nothing", async () => {
    const { store, room, jms, tri } = await bridge();
    const q = await appendEntry(store, room, jms, { type: "question", title: "grade?", body: "" }, T0);
    await appendEntry(store, room, tri, { type: "answer", title: "x", body: "x", answers: q.id }, T0);

    await assert.rejects(
      () => opReopen(ctx(store, room, tri), { questionId: q.id, why: "I think my answer was fine" }),
      /THEIR question, not yours/,
    );
  });

  it("refuses an unknown id rather than silently recording nothing", async () => {
    const { store, room, jms } = await bridge();
    await assert.rejects(
      () => opReopen(ctx(store, room, jms), { questionId: "JMS-Q-999", why: "x" }),
      /No question JMS-Q-999/,
    );
  });
});

describe("D4b — a contract change says what changed", () => {
  it("summarises added and removed lines instead of '<N> chars'", async () => {
    const { store, room, jms } = await bridge();
    await setContract(store, room, jms, "protocol: 1\nfield: a\nfield: b", "v1", T0);
    const entry = await setContract(store, room, jms, "protocol: 1\nfield: a\nfield: c", "v2", T0);

    assert.match(entry.body, /chars/);
    assert.match(entry.body, /\+1\/-1 lines/);
    assert.match(entry.body, /\+ field: c/);
    assert.match(entry.body, /- field: b/);
    assert.doesNotMatch(entry.body, /^\d+ chars$/, "the old body was just a character count");
  });

  it("names a creation as a creation", () => {
    assert.match(describeContractChange(null, "a\nb"), /created — 2 lines/);
  });

  it("truncates rather than pasting a 100k contract into the ledger", () => {
    const before = "";
    const after = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const out = describeContractChange("x", after);
    assert.ok(out.length < 600, "a ledger entry must stay skimmable");
    assert.match(out, /truncated/);
  });
});

describe("D4c — signing off turns silence into a fact", () => {
  it("the peer sees it on status", async () => {
    const { store, room, jms, tri } = await bridge();
    await opSignoff(ctx(store, room, tri), { note: "back Thursday" });

    const status = await getStatus(store, room, jms);
    assert.equal(status.peerSignedOff?.note, "back Thursday");
  });

  it("any later write clears it — being back IS the signal", async () => {
    const { store, room, jms, tri } = await bridge();
    await opSignoff(ctx(store, room, tri), {});
    await appendEntry(store, room, tri, { type: "note", title: "actually, one more", body: "" }, T0);

    assert.equal(signOffs(await readEntries(store, room.id)).b, undefined);
    assert.equal((await getStatus(store, room, jms)).peerSignedOff, undefined);
  });

  it("your own sign-off is not shown back to you as the peer's", async () => {
    const { store, room, jms } = await bridge();
    await opSignoff(ctx(store, room, jms), {});
    assert.equal((await getStatus(store, room, jms)).peerSignedOff, undefined);
  });
});

describe("D2 — a paste-path token gets half the budget", () => {
  it("mints at PASTE_PATH_DAILY_CAP, not the MCP default", async () => {
    const store = new FakeStore();
    const { room } = await createRoom(store, {
      topic: "t",
      ownerLabel: "A",
      peerLabel: "B",
      now: T0,
    });
    const { code } = await mintInvite(store, room, "b", T0);
    const result = await redeemInvite(store, code, T0, async (id) =>
      parseRoom(await store.get(ROOM_KEY(id))),
    );
    assert.ok(result.ok);
    if (!result.ok) return;

    clearRegistryCache();
    const auth = await authorize(store, { presentedToken: result.token, now: T0 });
    assert.ok(auth.ok);
    assert.equal(
      auth.ok && auth.token.dailyCap,
      PASTE_PATH_DAILY_CAP,
      "the token that reaches a model's context is the one that can leak",
    );
  });
});

describe("D6 — purge takes BOTH sides", () => {
  it("one side's consent deletes nothing", async () => {
    const { store, room, jms } = await bridge();
    await appendEntry(store, room, jms, { type: "note", title: "keep me", body: "" }, T0);

    const result = await opPurge(ctx(store, room, jms), { consent: true });
    assert.equal(result.bothAgreed, false);
    assert.equal((await readEntries(store, room.id)).length, 1, "nothing may be removed on one consent");
  });

  it("both sides agreeing unlocks it", async () => {
    const { store, room, jms, tri } = await bridge();
    await opPurge(ctx(store, room, jms), { consent: true });
    const second = await opPurge(ctx(store, room, tri), { consent: true });
    assert.equal(second.bothAgreed, true);
    assert.equal((await purgeState(store, room)).bothAgreed, true);
  });

  it("consent can be withdrawn", async () => {
    const { store, room, jms, tri } = await bridge();
    await opPurge(ctx(store, room, jms), { consent: true });
    await opPurge(ctx(store, room, tri), { consent: true });
    await opPurge(ctx(store, room, jms), { consent: false });
    assert.equal((await purgeState(store, room)).bothAgreed, false);
  });

  it("executePurge removes the entries, the room AND every token", async () => {
    const store = new FakeStore();
    const { room, ownerToken, peerToken } = await createRoom(store, {
      topic: "t",
      ownerLabel: "A",
      peerLabel: "B",
      now: T0,
    });
    const a = await authorize(store, { presentedToken: ownerToken, now: T0 });
    assert.ok(a.ok);
    await appendEntry(store, room, a.token, { type: "note", title: "x", body: "" }, T0);

    const removed = await executePurge(store, room);

    assert.ok(removed.includes(ENTRIES_KEY(room.id)));
    assert.ok(removed.includes(ROOM_KEY(room.id)));
    assert.ok(removed.includes(TOKEN_KEY(hashToken(ownerToken))), "tokens must die with the room");
    assert.ok(removed.includes(TOKEN_KEY(hashToken(peerToken))));

    clearRegistryCache();
    assert.deepEqual(await authorize(store, { presentedToken: ownerToken, now: T0 }), {
      ok: false,
      reason: "unknown-token",
    });
    assert.deepEqual(await readEntries(store, room.id), []);
  });

  it("records consent with a timestamp so it can expire", async () => {
    const { store, room } = await bridge();
    const state = await recordPurgeConsent(store, room, "a", T0);
    assert.equal(state.a, T0.toISOString());
    assert.equal(state.b, null);
  });
});
