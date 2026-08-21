import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { canonical, entryHash, verifyChain, type ChainedEntry } from "../chain";
import { appendEntry, readEntries } from "../entries";
import { authorize, clearRegistryCache, createRoom } from "../room-registry";
import { FakeStore, T0 } from "./fake-store";

beforeEach(() => clearRegistryCache());

async function bridge() {
  const store = new FakeStore();
  const { room, ownerToken } = await createRoom(store, {
    topic: "chain",
    ownerLabel: "JudgeMySite",
    peerLabel: "Northwind",
    now: T0,
  });
  const a = await authorize(store, { presentedToken: ownerToken, now: T0 });
  assert.ok(a.ok);
  return { store, room, jms: a.token };
}

const write = (store: FakeStore, room: any, tok: any, title: string, body = "b") =>
  appendEntry(store, room, tok, { type: "note", title, body }, T0);

describe("canonical — the serialisation the hash is computed over", () => {
  const base: ChainedEntry = {
    id: "AAA-N-001",
    seq: 1,
    type: "note",
    side: "a",
    code: "AAA",
    author: "A",
    ts: T0.toISOString(),
    title: "ab",
    body: "c",
    answers: null,
    why: null,
    checkedAgainst: null,
  basis: null,
  };

  it("[!!] length-prefixes, so a boundary cannot be moved between two fields", () => {
    // Without length prefixes, {title:"ab", body:"c"} and {title:"a", body:"bc"}
    // serialise to the same bytes and hash identically — an attacker could move
    // text across a field boundary invisibly.
    const shifted = { ...base, title: "a", body: "bc" };
    assert.notEqual(canonical(base), canonical(shifted));
    assert.notEqual(entryHash(null, base), entryHash(null, shifted));
  });

  it("distinguishes null from the string 'null'", () => {
    assert.notEqual(canonical({ ...base, why: null }), canonical({ ...base, why: "null" }));
  });

  it("is stable across key insertion order — same data, same hash", () => {
    const reordered = {
      checkedAgainst: base.checkedAgainst,
      why: base.why,
      answers: base.answers,
      body: base.body,
      title: base.title,
      ts: base.ts,
      author: base.author,
      code: base.code,
      side: base.side,
      type: base.type,
      seq: base.seq,
      id: base.id,
    } as ChainedEntry;
    assert.equal(canonical(reordered), canonical(base));
  });

  it("every covered field changes the hash", () => {
    const fields: Array<[keyof ChainedEntry, unknown]> = [
      ["id", "AAA-N-002"], ["seq", 2], ["type", "question"], ["side", "b"],
      ["code", "BBB"], ["author", "B"], ["ts", "2020-01-01T00:00:00.000Z"],
      ["title", "different"], ["body", "different"], ["answers", "X-Q-1"],
      ["why", "because"], ["checkedAgainst", "file.ts:1"],
    ];
    for (const [k, v] of fields) {
      assert.notEqual(
        entryHash(null, { ...base, [k]: v } as ChainedEntry),
        entryHash(null, base),
        `changing ${String(k)} must change the hash`,
      );
    }
  });
});

describe("the chain, written through the real append path", () => {
  it("every entry carries a hash, and each links to the one before", async () => {
    const { store, room, jms } = await bridge();
    await write(store, room, jms, "one");
    await write(store, room, jms, "two");
    await write(store, room, jms, "three");

    const entries = (await readEntries(store, room.id)) as ChainedEntry[];
    assert.equal(entries.length, 3);
    assert.equal(entries[0].prevHash, null, "the first entry anchors the chain");
    assert.equal(entries[1].prevHash, entries[0].hash);
    assert.equal(entries[2].prevHash, entries[1].hash);
    for (const e of entries) assert.match(e.hash!, /^[0-9a-f]{64}$/);
  });

  it("[!!] the hash SURVIVES the read path — parseEntry rebuilds field by field", async () => {
    const { store, room, jms } = await bridge();
    await write(store, room, jms, "one");
    const [e] = (await readEntries(store, room.id)) as ChainedEntry[];
    assert.ok(e.hash, "a chain that is stripped on read is decorative");
    assert.equal(verifyChain([e]).ok, true);
  });

  it("verifies clean", async () => {
    const { store, room, jms } = await bridge();
    for (const t of ["a", "b", "c", "d"]) await write(store, room, jms, t);
    const v = verifyChain((await readEntries(store, room.id)) as ChainedEntry[]);
    assert.equal(v.ok, true);
    assert.equal(v.ok === true && v.verified, 4);
    assert.equal(v.ok === true && v.unchained, 0);
  });
});

describe("[!!] detection — what the whole feature is for", () => {
  async function threeEntries() {
    const { store, room, jms } = await bridge();
    for (const t of ["one", "two", "three"]) await write(store, room, jms, t);
    return (await readEntries(store, room.id)) as ChainedEntry[];
  }

  it("catches a single edited word in the middle of the record", async () => {
    const entries = await threeEntries();
    entries[1].body = "quietly changed";
    const v = verifyChain(entries);
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "hash-mismatch");
    assert.equal(v.ok === false && v.at.seq, entries[1].seq);
  });

  it("catches an edited checkedAgainst — the field a forger would most want to change", async () => {
    const entries = await threeEntries();
    entries[2].checkedAgainst = "lib/somewhere-that-supports-me.ts:1";
    assert.equal(verifyChain(entries).ok, false);
  });

  it("catches a DELETED entry", async () => {
    const entries = await threeEntries();
    entries.splice(1, 1);
    const v = verifyChain(entries);
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "broken-link");
  });

  it("catches REORDERED entries", async () => {
    const entries = await threeEntries();
    [entries[1], entries[2]] = [entries[2], entries[1]];
    assert.equal(verifyChain(entries).ok, false);
  });

  it("catches an entry INSERTED with a recomputed hash but the wrong link", async () => {
    const entries = await threeEntries();
    const forged: ChainedEntry = { ...entries[0], id: "AAA-N-099", seq: 99, title: "forged" };
    forged.prevHash = entries[0].hash;
    forged.hash = entryHash(forged.prevHash!, forged);
    entries.splice(1, 0, forged); // valid in itself, but entries[2] no longer links
    assert.equal(verifyChain(entries).ok, false);
  });
});

describe("honest edges — absence must not read as tampering, or as success", () => {
  it("pre-chain entries verify as UNCHAINED, not as broken", () => {
    const legacy = [
      { id: "OLD-N-001", seq: 1, type: "note", side: "a", code: "OLD", author: "A",
        ts: T0.toISOString(), title: "t", body: "b", answers: null, why: null,
        checkedAgainst: null } as ChainedEntry,
    ];
    const v = verifyChain(legacy);
    assert.equal(v.ok, true);
    assert.equal(v.ok === true && v.unchained, 1);
    assert.equal(v.ok === true && v.verified, 0);
    assert.match(v.note, /no entry .* carries a hash/i);
  });

  it("[!!] an EMPTY verdict says so rather than reporting success", () => {
    const v = verifyChain([]);
    assert.equal(v.ok, true);
    assert.equal(v.ok === true && v.verified, 0);
    assert.equal(v.ok === true && v.head, null);
    assert.match(v.note, /Nothing to verify/i);
  });

  it("an unhashed entry AFTER hashed ones is a break, not history", async () => {
    const { store, room, jms } = await bridge();
    await write(store, room, jms, "one");
    const entries = (await readEntries(store, room.id)) as ChainedEntry[];
    entries.push({ ...entries[0], id: "X-N-9", seq: 9, hash: undefined, prevHash: undefined });
    assert.equal(verifyChain(entries).ok, false);
  });

  it("reports the segment it covered, and never implies anything outside it", async () => {
    const { store, room, jms } = await bridge();
    for (const t of ["a", "b", "c"]) await write(store, room, jms, t);
    const all = (await readEntries(store, room.id)) as ChainedEntry[];
    // Simulate a trim: the oldest row has left the server.
    const v = verifyChain(all.slice(1));
    assert.equal(v.ok, true, "a trimmed segment is still internally verifiable");
    assert.equal(v.ok === true && v.from, all[1].seq);
    assert.equal(v.ok === true && v.to, all[2].seq);
  });

  it("[!!] the success note REFUSES to claim more than it proved", async () => {
    const { store, room, jms } = await bridge();
    await write(store, room, jms, "one");
    const v = verifyChain((await readEntries(store, room.id)) as ChainedEntry[]);
    assert.equal(v.ok, true);
    // The server computes these hashes. A self-consistent chain served by the
    // party that could have rewritten it proves nothing on its own, and the
    // note must say so or the feature is theatre.
    assert.match(v.ok === true ? v.note : "", /does NOT prove/i);
  });
});
