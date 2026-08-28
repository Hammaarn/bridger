/**
 * The evidence index — what a room's agreement actually rests on.
 *
 * This aggregation lived in `app/page.tsx` until S#284, which meant the human
 * WATCHING could see it and the agent WRITING could not. Moving it here is the
 * same argument the codebase has made about two transports and one credential
 * scan: one implementation, or the two readings drift and two parties end up
 * disagreeing about the same record.
 *
 * What these pin:
 *   - numbers are stable as the room grows (they are chips in prose);
 *   - the raw string survives untouched, because it is the human's ground truth;
 *   - a permalink resolves against the CITING side's repo and never the other's;
 *   - the file grouping is the integration surface, and it is derived.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildEvidenceIndex } from "../evidence";
import type { Entry, EntryType } from "../entries";
import type { RoomRecord, SideId } from "../room-registry";

let seq = 0;
const entry = (side: SideId, checkedAgainst: string | null, type: EntryType = "answer"): Entry => {
  seq += 1;
  return {
    id: `${side === "a" ? "CLA" : "CLB"}-X-${String(seq).padStart(3, "0")}`,
    seq,
    type,
    side,
    code: side === "a" ? "CLA" : "CLB",
    author: side === "a" ? "JudgeMySite" : "Northwind",
    ts: "2026-08-28T12:00:00.000Z",
    title: "t",
    body: "b",
    answers: null,
    why: null,
    checkedAgainst,
    basis: null,
  } as Entry;
};

const room = (aRepo?: string, aRef?: string, bRepo?: string, bRef?: string): RoomRecord =>
  ({
    id: "room-1",
    kind: "trust",
    sides: {
      a: { label: "JudgeMySite", code: "CLA", joinedAt: null, repo: aRepo, repoRef: aRef },
      b: { label: "Northwind", code: "CLB", joinedAt: null, repo: bRepo, repoRef: bRef },
    },
  }) as unknown as RoomRecord;

describe("the index is derived, and its numbers are stable", () => {
  it("numbers by FIRST appearance and dedupes by raw string", () => {
    // The numbers are chips shown next to prose. If they renumbered as the room
    // grew, every earlier reference in the transcript would silently rot.
    const idx = buildEvidenceIndex([
      entry("a", "lib/store.ts:41"),
      entry("b", "api/team.js:166-169"),
      entry("a", "lib/store.ts:41"),
    ]);
    assert.equal(idx.sources.length, 2);
    assert.equal(idx.sources[0].n, 1);
    assert.equal(idx.sources[0].citedBy.length, 2, "the same artifact cited twice is one source, two claims");
    assert.equal(idx.sources[1].n, 2);
  });

  it("keeps the raw string byte-identical", () => {
    // citation.ts: "The raw string, unchanged. Always the source of truth for a
    // human." Normalising it here would quietly rewrite somebody's evidence.
    const weird = "  the codebase, mostly around the store  ";
    assert.equal(buildEvidenceIndex([entry("a", weird)]).sources[0].raw, weird);
  });

  it("grades the citation, never the claim", () => {
    const idx = buildEvidenceIndex([entry("a", "the codebase"), entry("b", "lib/store.ts:41")]);
    assert.equal(idx.sources[0].weak, true, "prose with no locator is a gesture");
    assert.equal(idx.sources[1].weak, false);
    assert.equal("score" in idx.sources[0], false, "there must be no quality number here");
  });
});

describe("[!!] which side rested on what — the dimension the flat list never had", () => {
  it("tracks the citing side, and notices when both cite the same artifact", () => {
    const idx = buildEvidenceIndex([
      entry("a", "lib/store.ts:41"),
      entry("b", "lib/store.ts:41"),
    ]);
    assert.deepEqual(idx.sources[0].sides, ["a", "b"]);
    assert.deepEqual(idx.sources[0].citedBy.map((c) => c.side), ["a", "b"]);
  });

  it("counts per side", () => {
    const idx = buildEvidenceIndex([
      entry("a", "lib/store.ts:41"),
      entry("a", "lib/store.ts:613"),
      entry("b", "api/team.js:166"),
    ]);
    assert.equal(idx.perSide.a.claims, 2);
    assert.equal(idx.perSide.b.claims, 1);
  });
});

describe("the integration surface — the same evidence, grouped by file", () => {
  it("collapses two spans of one file into one file with two sources", () => {
    // This is the view a planning agent wants and the flat list cannot give:
    // lib/store.ts:41 and lib/store.ts:613 are two citations and ONE seam.
    const idx = buildEvidenceIndex([
      entry("a", "lib/store.ts:41"),
      entry("a", "lib/store.ts:613"),
    ]);
    assert.equal(idx.files.length, 1);
    assert.equal(idx.files[0].path, "lib/store.ts");
    assert.deepEqual(idx.files[0].sources, [1, 2]);
    assert.equal(idx.files[0].claims, 2);
  });

  it("ranks by how many claims rest on the file", () => {
    // The artifact holding up six claims is the one to weigh first — and the
    // one an attacker would most want wrong.
    const idx = buildEvidenceIndex([
      entry("a", "rare.ts:1"),
      entry("a", "hot.ts:1"),
      entry("b", "hot.ts:2"),
      entry("b", "hot.ts:3"),
    ]);
    assert.equal(idx.files[0].path, "hot.ts");
    assert.equal(idx.files[0].claims, 3);
  });

  it("NEGATIVE CONTROL: citations with no path produce no file", () => {
    // A URL, a command and prose are all real evidence and none of them is a
    // file. Inventing a path for them would fabricate the surface.
    const idx = buildEvidenceIndex([
      entry("a", "https://example.com/spec"),
      entry("a", "npm test"),
      entry("a", "the codebase"),
    ]);
    assert.equal(idx.sources.length, 3);
    assert.equal(idx.files.length, 0);
  });
});

describe("[!!] a permalink resolves against the CITING side's repo, never the other's", () => {
  it("links a citation using the repo of the side that wrote it", () => {
    const idx = buildEvidenceIndex(
      [entry("a", "lib/store.ts:41")],
      room("https://github.com/Hammaarn/bridger", "abc1234"),
    );
    assert.match(String(idx.sources[0].citedBy[0].url), /Hammaarn\/bridger\/blob\/abc1234\/lib\/store\.ts#L41/);
    assert.equal(idx.sources[0].citedBy[0].pinned, true, "a sha is pinned, a branch is not");
  });

  it("does not resolve a side's citation against the OTHER side's repo", () => {
    // The dangerous failure: a link that opens and shows you somebody else's
    // file. Side B declared nothing here, so B's citation gets no link.
    const idx = buildEvidenceIndex(
      [entry("b", "lib/store.ts:41")],
      room("https://github.com/Hammaarn/bridger", "abc1234"),
    );
    assert.equal(idx.sources[0].citedBy[0].url, null);
  });

  it("leaves the source-level link null when two sides resolve it differently", () => {
    const idx = buildEvidenceIndex(
      [entry("a", "lib/store.ts:41"), entry("b", "lib/store.ts:41")],
      room("https://github.com/Hammaarn/bridger", "abc1234", "https://github.com/other/repo", "def5678"),
    );
    assert.equal(idx.sources[0].url, null, "one string, two repos — the per-citation urls carry the truth");
    assert.equal(idx.sources[0].citedBy.filter((c) => c.url).length, 2);
  });

  it("NEGATIVE CONTROL: with no repo declared, everything still indexes and nothing links", () => {
    const idx = buildEvidenceIndex([entry("a", "lib/store.ts:41")]);
    assert.equal(idx.sources.length, 1);
    assert.equal(idx.sources[0].citedBy[0].url, null);
  });
});

describe("what carries no citation at all", () => {
  it("counts uncited answers and decisions — allowed, and visible on purpose", () => {
    // "An unchecked answer is fine. An unchecked answer dressed as a verified
    // one is not." Counting them is how the first half stays honest.
    const idx = buildEvidenceIndex([
      entry("a", null, "answer"),
      entry("b", null, "decision"),
      entry("a", "lib/store.ts:41", "answer"),
    ]);
    assert.equal(idx.uncited, 2);
  });

  it("NEGATIVE CONTROL: a note without a citation is not an uncited claim", () => {
    // A status line asserts nothing, so demanding a receipt from it would make
    // the counter meaningless.
    assert.equal(buildEvidenceIndex([entry("a", null, "note")]).uncited, 0);
  });

  it("an empty room indexes to nothing rather than throwing", () => {
    const idx = buildEvidenceIndex([]);
    assert.deepEqual(idx.sources, []);
    assert.deepEqual(idx.files, []);
    assert.equal(idx.uncited, 0);
  });
});
