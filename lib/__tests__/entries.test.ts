import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  appendEntry,
  getCursor,
  getStatus,
  openQuestions,
  readEntries,
  setContract,
  setCursor,
  waitForNew,
  getContract,
} from "../entries";
import {
  authorize,
  clearRegistryCache,
  createRoom,
  bumpIdleStreak,
  type RoomRecord,
  type TokenRecord,
} from "../room-registry";
import { ENTRIES_KEY, MAX_EMPTY_WAIT_STREAK, MAX_IDLE_STREAK } from "../store";
import { FakeStore, T0, plus } from "./fake-store";

/** A room with both sides resolved to real, token-proven identities. */
async function bridge() {
  const store = new FakeStore();
  const { room, ownerToken, peerToken } = await createRoom(store, {
    topic: "judgemysite x Northwind — live review API",
    ownerLabel: "JudgeMySite",
    peerLabel: "Northwind",
    now: T0,
  });
  const a = await authorize(store, { presentedToken: ownerToken, now: T0 });
  const b = await authorize(store, { presentedToken: peerToken, now: T0 });
  assert.ok(a.ok && b.ok);
  return { store, room, jms: a.token, tri: b.token };
}

const ask = (
  store: FakeStore,
  room: RoomRecord,
  who: TokenRecord,
  title: string,
  now = T0,
) => appendEntry(store, room, who, { type: "question", title, body: title }, now);

beforeEach(() => clearRegistryCache());

describe("entry IDs", () => {
  it("namespaces by author and increments per type", async () => {
    const { store, room, jms, tri } = await bridge();

    const q1 = await ask(store, room, jms, "does 422 refund the key?");
    const q2 = await ask(store, room, jms, "what is the beat contract?");
    const a1 = await appendEntry(
      store,
      room,
      tri,
      { type: "answer", title: "yes", body: "yes", answers: q1.id, checkedAgainst: "lib/usage.ts:88" },
      T0,
    );

    assert.equal(q1.id, "JMS-Q-001");
    assert.equal(q2.id, "JMS-Q-002");
    assert.equal(a1.id, "NOR-A-001", "the other side counts in its own namespace");
  });

  it("takes side and code from the TOKEN, so a side cannot write as the other", async () => {
    const { store, room, tri } = await bridge();
    const entry = await appendEntry(
      store,
      room,
      tri,
      // A caller trying to look like the other party. These fields do not exist
      // on AppendInput, so the attempt cannot even be expressed — this asserts
      // the resulting entry is stamped from the token regardless.
      { type: "note", title: "posing as JMS", body: "..." },
      T0,
    );
    assert.equal(entry.side, "b");
    assert.equal(entry.code, "NOR");
    assert.equal(entry.author, "Northwind");
    assert.ok(entry.id.startsWith("NOR-"));
  });

  it("gives a strictly increasing seq across BOTH sides", async () => {
    const { store, room, jms, tri } = await bridge();
    const seqs: number[] = [];
    for (const who of [jms, tri, tri, jms, tri]) {
      seqs.push((await appendEntry(store, room, who, { type: "note", title: "x", body: "x" }, T0)).seq);
    }
    assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
  });
});

describe("provenance", () => {
  it("records what a claim was checked against, or null — never a bare boolean", async () => {
    const { store, room, jms } = await bridge();
    const checked = await appendEntry(
      store,
      room,
      jms,
      { type: "answer", title: "released on 422", body: "yes", answers: "NOR-Q-001", checkedAgainst: "lib/external/usage-report.ts:41" },
      T0,
    );
    const unchecked = await appendEntry(
      store,
      room,
      jms,
      { type: "answer", title: "probably released", body: "I think so", answers: "NOR-Q-002" },
      T0,
    );

    assert.equal(checked.checkedAgainst, "lib/external/usage-report.ts:41");
    assert.equal(unchecked.checkedAgainst, null, "absent evidence must read as unchecked");
  });
});

describe("open questions are derived, never stored", () => {
  it("closes a question when an answer references it", async () => {
    const { store, room, jms, tri } = await bridge();
    const q = await ask(store, room, jms, "does 422 refund the key?");

    let open = openQuestions(await readEntries(store, room.id), "b");
    assert.equal(open.length, 1);
    assert.equal(open[0].yours, true, "it is the peer's turn to answer");

    await appendEntry(
      store,
      room,
      tri,
      { type: "answer", title: "yes", body: "yes", answers: q.id, checkedAgainst: "x.ts:1" },
      T0,
    );

    open = openQuestions(await readEntries(store, room.id), "b");
    assert.equal(open.length, 0);
  });

  it("marks whose turn it is from the viewer's side", async () => {
    const { store, room, jms, tri } = await bridge();
    await ask(store, room, jms, "mine");
    await ask(store, room, tri, "theirs");

    const entries = await readEntries(store, room.id);
    const fromJms = openQuestions(entries, "a");
    assert.deepEqual(
      fromJms.map((q) => q.yours),
      [false, true],
      "your own open question is not your turn",
    );
  });

  it("two answers to the same question do not corrupt anything", async () => {
    const { store, room, jms, tri } = await bridge();
    const q = await ask(store, room, jms, "double-answered");
    for (const t of [tri, tri]) {
      await appendEntry(store, room, t, { type: "answer", title: "a", body: "a", answers: q.id }, T0);
    }
    const open = openQuestions(await readEntries(store, room.id), "b");
    assert.equal(open.length, 0, "append-only means a race is just two entries");
  });
});

describe("readEntries filters", () => {
  it("filters by sinceSeq, type, id and limit", async () => {
    const { store, room, jms, tri } = await bridge();
    const q = await ask(store, room, jms, "q1");
    await appendEntry(store, room, tri, { type: "note", title: "n1", body: "" }, T0);
    await appendEntry(store, room, jms, { type: "decision", title: "d1", body: "", why: "because" }, T0);

    assert.equal((await readEntries(store, room.id)).length, 3);
    assert.equal((await readEntries(store, room.id, { sinceSeq: q.seq })).length, 2);
    assert.equal((await readEntries(store, room.id, { types: ["decision"] })).length, 1);
    assert.equal((await readEntries(store, room.id, { ids: [q.id] }))[0].id, q.id);
    assert.equal((await readEntries(store, room.id, { limit: 1 }))[0].title, "d1", "limit keeps the newest");
  });

  it("skips corrupt rows instead of throwing the whole read", async () => {
    const { store, room, jms } = await bridge();
    await ask(store, room, jms, "good");
    await store.rpush(ENTRIES_KEY(room.id), "{ not json");
    await store.rpush(ENTRIES_KEY(room.id), JSON.stringify({ nope: true }));

    const entries = await readEntries(store, room.id);
    assert.equal(entries.length, 1, "one bad row must not take the ledger down");
  });
});

describe("cursor and unread", () => {
  it("counts only the PEER's entries as unread", async () => {
    const { store, room, jms, tri } = await bridge();
    await ask(store, room, jms, "mine 1");
    await ask(store, room, jms, "mine 2");
    await appendEntry(store, room, tri, { type: "note", title: "theirs", body: "" }, T0);

    const status = await getStatus(store, room, jms);
    assert.equal(status.unread, 1, "your own writes are not news to you");
    assert.equal(status.latestSeq, 3);
    assert.equal(status.totalEntries, 3);
  });

  it("never moves the cursor backwards", async () => {
    const { store, room } = await bridge();
    assert.equal(await setCursor(store, room.id, "a", 5), 5);
    assert.equal(await setCursor(store, room.id, "a", 2), 5, "a stale call must not resurrect read entries");
    assert.equal(await getCursor(store, room.id, "a"), 5);
  });

  it("reports whether the peer has ever joined", async () => {
    const { store, room, jms } = await bridge();
    const status = await getStatus(store, room, jms);
    assert.equal(status.peer.joined, false, "an un-joined peer must not look merely idle");
    assert.equal(status.peer.label, "Northwind");
    assert.equal(status.you.label, "JudgeMySite");
  });
});

describe("seq survives a trim", () => {
  it("keeps cursors correct after old entries are dropped from the buffer", async () => {
    const { store, room, jms, tri } = await bridge();
    for (let i = 0; i < 5; i++) await ask(store, room, jms, `q${i}`);
    const latest = await appendEntry(store, room, tri, { type: "note", title: "newest", body: "" }, T0);

    // Simulate the MAX_ENTRIES trim dropping the oldest rows.
    await store.ltrim(ENTRIES_KEY(room.id), -2, -1);

    const remaining = await readEntries(store, room.id);
    assert.equal(remaining.length, 2);
    assert.equal(
      remaining[remaining.length - 1].seq,
      latest.seq,
      "seq is a counter, not a list index — trimming must not renumber history",
    );
    assert.equal((await readEntries(store, room.id, { sinceSeq: latest.seq })).length, 0);
  });
});

describe("contract", () => {
  it("stores the doc and logs who changed it", async () => {
    const { store, room, jms } = await bridge();
    const entry = await setContract(store, room, jms, "POST /api/external/live-review", "v1 wire format", T0);

    const contract = await getContract(store, room.id);
    assert.equal(contract?.body, "POST /api/external/live-review");
    assert.equal(contract?.updatedBy, "JudgeMySite");
    assert.equal(entry.type, "contract");
    assert.equal(entry.title, "v1 wire format");
  });
});

describe("waitForNew", () => {
  const fakeClock = () => {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
  };

  it("returns as soon as the PEER writes", async () => {
    const { store, room, jms, tri } = await bridge();
    const clock = fakeClock();
    const before = (await getStatus(store, room, jms)).latestSeq;

    // Land the peer's entry before the wait begins — the wait must see it on
    // its first poll rather than sleeping through work that already happened.
    await appendEntry(store, room, tri, { type: "note", title: "over to you", body: "" }, T0);

    const res = await waitForNew(store, room, jms, {
      sinceSeq: before,
      timeoutMs: 5000,
      pollMs: 100,
      ...clock,
    });
    assert.equal(res.timedOut, false);
    assert.equal(res.entries.length, 1);
    assert.equal(res.entries[0].title, "over to you");
  });

  it("ignores your OWN writes — a wait is for the other side", async () => {
    const { store, room, jms } = await bridge();
    const clock = fakeClock();
    const before = (await getStatus(store, room, jms)).latestSeq;
    await ask(store, room, jms, "my own question");

    const res = await waitForNew(store, room, jms, {
      sinceSeq: before,
      timeoutMs: 300,
      pollMs: 100,
      ...clock,
    });
    assert.equal(res.timedOut, true, "hearing your own echo is not an answer");
    assert.equal(res.entries.length, 0);
  });

  it("times out cleanly — a quiet bridge is not an error", async () => {
    const { store, room, jms } = await bridge();
    const clock = fakeClock();
    const res = await waitForNew(store, room, jms, {
      sinceSeq: 0,
      timeoutMs: 500,
      pollMs: 100,
      ...clock,
    });
    assert.equal(res.timedOut, true);
    assert.deepEqual(res.entries, []);
    assert.ok(res.waitedMs <= 500);
  });
});

describe("the idle brake — writing is working, not spinning", () => {
  it("a write CLEARS the idle streak, from the one seam every write funnels through", async () => {
    const { store, room, jms } = await bridge();

    assert.equal(await bumpIdleStreak(store, jms.id), 1);
    assert.equal(await bumpIdleStreak(store, jms.id), 2);
    assert.equal(await bumpIdleStreak(store, jms.id), 3);

    await ask(store, room, jms, "does the verdict event carry a grade?");

    assert.equal(
      await bumpIdleStreak(store, jms.id),
      1,
      "an agent that posted a question is doing work — it must not inherit the poller's brake",
    );
  });

  it("setContract clears it too — it is a write, and it routes through appendEntry", async () => {
    const { store, room, jms } = await bridge();
    await bumpIdleStreak(store, jms.id);
    await bumpIdleStreak(store, jms.id);

    await setContract(store, room, jms, "protocol: 1", "first cut", T0);

    assert.equal(await bumpIdleStreak(store, jms.id), 1);
  });

  it("the streak is per TOKEN — one side spinning does not brake the other", async () => {
    const { store, jms, tri } = await bridge();
    for (let i = 0; i < 5; i++) await bumpIdleStreak(store, jms.id);
    assert.equal(await bumpIdleStreak(store, tri.id), 1);
  });

  it("waiting is stricter than merely reading, and both thresholds are live", () => {
    assert.ok(
      MAX_EMPTY_WAIT_STREAK < MAX_IDLE_STREAK,
      "a wait says 'I expect something now', so it gets less rope than a status check-in",
    );
  });
});
