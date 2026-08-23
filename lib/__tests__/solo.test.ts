/**
 * SOLO MODE (S#281) -- one operator, several of their own models.
 *
 * The property under test is not "more seats work". It is that widening the
 * room model did not weaken the room type the product exists for. A `trust`
 * room must behave EXACTLY as it did, containment included, and every
 * assertion about solo here has a trust-room twin asserting the opposite.
 *
 * `DECISIONS.md` 2026-08-23 (S#281).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { FakeStore } from "./fake-store";
import {
  authorize,
  createRoom,
  createSoloRoom,
  clearRegistryCache,
  otherSeats,
  seatsFor,
  parseRoom,
  seat,
  MAX_SOLO_SEATS,
  SEAT_IDS,
} from "../room-registry";
import { ROOM_SHAPES, defaultShapeFor } from "../room-shapes";
import { appendEntry } from "../entries";
import { wire, wireCtxFor, type OpContext } from "../operations";

const T0 = new Date("2026-08-23T12:00:00.000Z");

async function solo(labels = ["Claude", "Gemini", "GPT"]) {
  clearRegistryCache();
  const store = new FakeStore();
  const { room, tokens } = await createSoloRoom(store, {
    topic: "my models, one room",
    seatLabels: labels,
    now: T0,
  });
  const auths = [];
  for (const t of tokens) {
    const a = await authorize(store, { presentedToken: t.token, now: T0 });
    assert.ok(a.ok, `seat ${t.side} must authorize`);
    auths.push(a.token);
  }
  return { store, room, tokens, auths };
}

async function trust() {
  clearRegistryCache();
  const store = new FakeStore();
  const { room, ownerToken, peerToken } = await createRoom(store, {
    topic: "two companies",
    ownerLabel: "JudgeMySite",
    peerLabel: "Trigvanta",
    now: T0,
  });
  const a = await authorize(store, { presentedToken: ownerToken, now: T0 });
  const b = await authorize(store, { presentedToken: peerToken, now: T0 });
  assert.ok(a.ok && b.ok);
  return { store, room, a: a.token, b: b.token };
}

describe("a solo room seats more than two", () => {
  it("mints one working token per seat, all joined immediately", async () => {
    const { room, tokens } = await solo();
    assert.equal(tokens.length, 3);
    assert.deepEqual(seatsFor(room), ["a", "b", "c"]);
    for (const s of seatsFor(room)) {
      assert.ok(seat(room, s).joinedAt, `seat ${s} should be joined — nobody is being waited on`);
    }
  });

  it("gives every seat a DISTINCT code, even when the labels collide", async () => {
    // The most likely solo room in the world is one person's own models, and
    // "claude" / "claude-opus" is exactly how they get named. A shared code
    // would make entry ids ambiguous.
    const { room } = await solo(["Claude", "Claude Opus", "Claude Sonnet"]);
    const codes = seatsFor(room).map((s) => seat(room, s).code);
    assert.equal(new Set(codes).size, codes.length, `codes collided: ${codes.join(", ")}`);
  });

  it("otherSeats returns the rest of the table, not a boolean flip", async () => {
    const { room } = await solo();
    assert.deepEqual(otherSeats(room, "a"), ["b", "c"]);
    assert.deepEqual(otherSeats(room, "c"), ["a", "b"]);
  });

  it("refuses fewer than two seats and more than the ceiling", async () => {
    const store = new FakeStore();
    await assert.rejects(
      () => createSoloRoom(store, { topic: "t", seatLabels: ["only me"], now: T0 }),
      /seats/,
      "one seat is a notepad, not a bridge",
    );
    await assert.rejects(
      () =>
        createSoloRoom(store, {
          topic: "t",
          seatLabels: Array.from({ length: MAX_SOLO_SEATS + 1 }, (_, i) => `m${i}`),
          now: T0,
        }),
      /seats/,
    );
  });

  it("the ceiling matches the seat vocabulary — neither can drift alone", () => {
    assert.equal(MAX_SOLO_SEATS, SEAT_IDS.length);
  });
});

describe("[!!] containment: the marker fires where it means something, and nowhere else", () => {
  /** Build a wire context by hand for a given room + reader. */
  const ctxFor = (room: Parameters<typeof wireCtxFor>[0]["room"], token: never) =>
    wireCtxFor({ room, token } as unknown as OpContext);

  it("a TRUST room still contains the PEER's text — nothing was weakened", async () => {
    const { store, room, a, b } = await trust();
    const entry = await appendEntry(store, room, b, { type: "note", title: "from them", body: "hello" }, T0);
    const out = wire(entry, ctxFor(room, a as never));
    assert.match(
      String(out.title),
      /UNTRUSTED-PARTNER-TEXT/,
      "a trust room MUST still contain the other company's text",
    );
  });

  it("[!!] a TRUST room no longer contains YOUR OWN text (F4)", async () => {
    // The bug: `wire()` runs on the entry you just posted, so the confirmation
    // of your own `post` came back labelled "DATA FROM THE OTHER COMPANY".
    const { store, room, a } = await trust();
    const entry = await appendEntry(store, room, a, { type: "note", title: "my own words", body: "mine" }, T0);
    const out = wire(entry, ctxFor(room, a as never));
    assert.doesNotMatch(
      String(out.title),
      /UNTRUSTED-PARTNER-TEXT/,
      "your own sentence was being returned to you wrapped as a foreign company's",
    );
    assert.equal(out.title, "my own words", "and it should come back unchanged");
  });

  it("[!!] a SOLO room contains NOTHING — the marker must not cry wolf", async () => {
    const { store, room, auths } = await solo();
    const entry = await appendEntry(
      store,
      room,
      auths[1]!,
      { type: "note", title: "gemini says", body: "hi" },
      T0,
    );
    const out = wire(entry, ctxFor(room, auths[0]! as never));
    assert.doesNotMatch(String(out.title), /UNTRUSTED-PARTNER-TEXT/);
    assert.equal(out.title, "gemini says");
  });

  it("wire() with NO context contains everything — the default must fail safe", async () => {
    const { store, room, b, a } = await trust();
    const entry = await appendEntry(store, room, b, { type: "note", title: "x", body: "y" }, T0);
    void a;
    const out = wire(entry);
    assert.match(
      String(out.title),
      /UNTRUSTED-PARTNER-TEXT/,
      "a call site that forgets context must be over-cautious, never exposed",
    );
  });
});

describe("the kind default protects existing rooms", () => {
  it("[!!] a room stored before `kind` existed reads as trust, never solo", () => {
    // Reading it as solo would silently strip the containment markers from the
    // live cross-company room. This is the single most dangerous default in
    // the feature.
    const legacy = parseRoom(
      JSON.stringify({
        id: "r1",
        topic: "t",
        sides: { a: { label: "A", code: "AAA" }, b: { label: "B", code: "BBB" } },
      }),
    );
    assert.equal(legacy?.kind, "trust");
  });

  it("a room stored with an unknown kind also reads as trust", () => {
    const weird = parseRoom(JSON.stringify({ id: "r2", kind: "something-else" }));
    assert.equal(weird?.kind, "trust", "an unrecognised kind must fail toward containment");
  });

  it("createRoom still makes trust rooms", async () => {
    const { room } = await trust();
    assert.equal(room.kind, "trust");
    assert.deepEqual(seatsFor(room), ["a", "b"]);
  });
});

describe("F2 room shapes", () => {
  it("there are exactly two, and each maps to a real phase", async () => {
    const { ROOM_SHAPES, shapeForPhase, defaultShapeFor } = await import("../room-shapes");
    assert.equal(ROOM_SHAPES.length, 2, "a third shape needs a third stage to exist first");
    assert.deepEqual(
      ROOM_SHAPES.map((s) => s.phase).sort(),
      ["build", "plan"],
      "every shape must correspond to a phase the room can actually be in",
    );
    assert.equal(shapeForPhase("plan").id, "plan-first");
    assert.equal(shapeForPhase("build").id, "record");
  });

  it("[!!] the defaults are the behaviour each room kind ALREADY had", () => {
    // The point of F2 is to make the phase a choice, not to change what anyone
    // gets by not choosing. If these ever flip, existing callers silently get a
    // different room than they got yesterday.
    assert.equal(defaultShapeFor("trust").phase, "plan");
    assert.equal(defaultShapeFor("solo").phase, "build");
  });

  it("every shape has a name that says what you GET", () => {
    for (const s of ROOM_SHAPES) {
      assert.ok(s.name.length > 0 && s.blurb.length > 0, `${s.id} needs a name and a blurb`);
      assert.doesNotMatch(
        s.name,
        /\bjust\b/i,
        `"${s.name}" — "just" tells someone their choice is the lesser one`,
      );
    }
  });

  it("[!!] room-shapes imports nothing that cannot run in a browser", async () => {
    // THE BUG THIS PINS: these constants first lived in `room-registry`, which
    // imports the store, which imports @upstash/redis and node:fs. Importing one
    // presentational constant into a client component therefore dragged the
    // whole server stack into the browser bundle and `next dev` died with
    // "the chunking context does not support external modules (request:
    // node:fs)".
    //
    // `next build` PASSED throughout — measured by ablation, not assumed — so
    // tsc + tests + build could not see it. This assertion is the only cheap
    // check that can.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../room-shapes.ts", import.meta.url), "utf8");
    const imports = [...src.matchAll(/^\s*import[^;]*from\s+"([^"]+)"/gm)].map((m) => m[1]!);
    assert.deepEqual(
      imports,
      [],
      `room-shapes must stay import-free so the client can read it; found: ${imports.join(", ")}`,
    );
  });
});
