/**
 * THE PERMALINK RESOLVER (S#281).
 *
 * Half of this file is security. The repo field is self-declared and every
 * citation in the room renders as a link to it, so an unvalidated value is a
 * phishing primitive inside a product whose pitch is that its record can be
 * trusted. Those cases are marked [!!] and are the ones that must never regress.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyCitation } from "../citation";
import { parseRepo, citationUrl, isPinned, repoLabel } from "../repo-link";

const GH = parseRepo("https://github.com/Hammaarn/bridger", "6a190ac");
const GH_HEAD = parseRepo("https://github.com/Hammaarn/bridger");

describe("[!!] a declared repo is validated, never trusted", () => {
  it("refuses a host that is not a known forge", () => {
    // THE ATTACK: every citation in the room becomes a link the far side
    // controls. This single assertion is the whole defence.
    assert.equal(parseRepo("https://evil.example/a/b"), null);
    assert.equal(parseRepo("https://github.com.evil.example/a/b"), null);
    assert.equal(parseRepo("https://notgithub.com/a/b"), null);
  });

  it("refuses non-https, including the script schemes", () => {
    assert.equal(parseRepo("http://github.com/a/b"), null);
    assert.equal(parseRepo("javascript:alert(1)"), null);
    assert.equal(parseRepo("data:text/html,<script>"), null);
  });

  it("refuses anything that is not exactly owner/name", () => {
    assert.equal(parseRepo("https://github.com/onlyowner"), null);
    assert.equal(parseRepo("https://github.com/a/b/blob/main/x.ts"), null, "a deep link is a different intent, not a repo");
    assert.equal(parseRepo("https://github.com/"), null);
  });

  it("rebuilds the URL from parsed parts rather than echoing input", () => {
    const r = parseRepo("https://GitHub.com/Hammaarn/bridger.git/?x=1#frag");
    assert.equal(r?.url, "https://github.com/Hammaarn/bridger", "query, fragment and .git must not survive");
  });

  it("falls back to HEAD on a junk ref instead of interpolating it", () => {
    const r = parseRepo("https://github.com/a/b", "../../etc/passwd");
    assert.equal(r?.ref, "HEAD");
  });
});

describe("a citation becomes a line-anchored URL", () => {
  it("single line", () => {
    const c = classifyCitation("lib/store.ts:41");
    assert.equal(c.kind, "line");
    assert.equal(
      citationUrl(c, GH),
      "https://github.com/Hammaarn/bridger/blob/6a190ac/lib/store.ts#L41",
    );
  });

  it("a range, anchored across both ends", () => {
    const c = classifyCitation("lib/store.ts:41-58");
    assert.equal(c.kind, "range");
    assert.equal(
      citationUrl(c, GH),
      "https://github.com/Hammaarn/bridger/blob/6a190ac/lib/store.ts#L41-L58",
    );
  });

  it("a whole file gets the file, with no invented line", () => {
    const c = classifyCitation("lib/store.ts");
    assert.equal(citationUrl(c, GH), "https://github.com/Hammaarn/bridger/blob/6a190ac/lib/store.ts");
  });

  it("HEAD when no ref was declared — never a guessed branch name", () => {
    const c = classifyCitation("lib/store.ts:41");
    assert.match(String(citationUrl(c, GH_HEAD)), /\/blob\/HEAD\//);
  });

  it("gitlab uses its own blob path and anchor form", () => {
    const gl = parseRepo("https://gitlab.com/acme/api", "v2");
    const c = classifyCitation("src/main.rs:10-12");
    assert.equal(citationUrl(c, gl), "https://gitlab.com/acme/api/-/blob/v2/src/main.rs#L10-12");
  });

  it("a host whose format we have NOT verified links to the root, not a guess", () => {
    const cb = parseRepo("https://codeberg.org/acme/api");
    const c = classifyCitation("src/main.rs:10");
    assert.equal(citationUrl(c, cb), "https://codeberg.org/acme/api", "a guessed anchor that 404s is worse than a root link");
  });
});

describe("[!!] it declines to link rather than link wrongly", () => {
  it("no repo declared → no link, exactly as before this feature", () => {
    assert.equal(citationUrl(classifyCitation("lib/store.ts:41"), null), null);
  });

  it("an unlocated citation has nothing to point at", () => {
    assert.equal(citationUrl(classifyCitation("the codebase"), GH), null);
  });

  it("a citation that is ALREADY a url is left alone", () => {
    // Rewriting it would be an open redirect dressed as a convenience.
    assert.equal(citationUrl(classifyCitation("https://example.com/spec"), GH), null);
  });

  it("a path escaping the repo is refused", () => {
    assert.equal(citationUrl(classifyCitation("../../../etc/passwd:1"), GH), null);
    assert.equal(citationUrl(classifyCitation("/etc/passwd:1"), GH), null);
  });

  it("path segments are encoded, not concatenated raw", () => {
    const c = classifyCitation("lib/a b.ts:3");
    const u = citationUrl(c, GH);
    if (u) assert.doesNotMatch(u, / /, "a raw space would break the link");
  });
});

describe("the ref tells a reader whether the link can rot", () => {
  it("a sha is pinned, a branch is not", () => {
    assert.equal(isPinned(GH!), true, "6a190ac is a commit");
    assert.equal(isPinned(parseRepo("https://github.com/a/b", "main")!), false);
    assert.equal(isPinned(GH_HEAD!), false, "HEAD moves with the default branch");
  });

  it("the label names the ref only when it is not HEAD", () => {
    assert.equal(repoLabel(GH!), "Hammaarn/bridger @ 6a190ac");
    assert.equal(repoLabel(GH_HEAD!), "Hammaarn/bridger");
  });
});

describe("[!!] end to end: a citation in a real room resolves to its AUTHOR's repo", () => {
  it("side A's citation uses A's repo, side B's uses B's — never the reader's", async () => {
    // THE BUG THIS EXISTS FOR: resolving against whoever is READING produces a
    // confident link to a same-named file in the wrong project. Both sides here
    // cite `lib/store.ts:41` on purpose, so a reader-based resolver would pass
    // every other assertion in this file and still be wrong.
    const { FakeStore } = await import("./fake-store");
    const { createRoom, authorize, setSideIdentity, clearRegistryCache } = await import(
      "../room-registry"
    );
    const { appendEntry } = await import("../entries");
    const { wire } = await import("../operations");

    clearRegistryCache();
    const store = new FakeStore();
    const T0 = new Date("2026-08-23T12:00:00.000Z");
    const { room, ownerToken, peerToken } = await createRoom(store, {
      topic: "t",
      ownerLabel: "Acme",
      peerLabel: "Northwind",
      now: T0,
    });
    const a = await authorize(store, { presentedToken: ownerToken, now: T0 });
    const b = await authorize(store, { presentedToken: peerToken, now: T0 });
    assert.ok(a.ok && b.ok);

    let r = await setSideIdentity(store, room, "a", {
      repo: "https://github.com/acme/checkout",
      repoRef: "aaaaaaa",
    });
    r = await setSideIdentity(store, r, "b", {
      repo: "https://github.com/northwind/api",
      repoRef: "bbbbbbb",
    });

    const same = "lib/store.ts:41";
    const eA = await appendEntry(
      store, r, a.token,
      { type: "note", title: "from A", body: "", checkedAgainst: same },
      T0,
    );
    const eB = await appendEntry(
      store, r, b.token,
      { type: "note", title: "from B", body: "", checkedAgainst: same },
      T0,
    );

    // Read BOTH from side A's point of view. If the resolver used the reader's
    // repo, both would come back pointing at acme.
    const ctx = { room: r, viewerSide: "a" as const };
    const outA = wire(eA, ctx) as { checkedUrl?: string };
    const outB = wire(eB, ctx) as { checkedUrl?: string };

    assert.equal(outA.checkedUrl, "https://github.com/acme/checkout/blob/aaaaaaa/lib/store.ts#L41");
    assert.equal(
      outB.checkedUrl,
      "https://github.com/northwind/api/blob/bbbbbbb/lib/store.ts#L41",
      "B's citation resolved against the READER's repo — a confident link to the wrong project",
    );
  });

  it("a side with no repo declared yields no link at all", async () => {
    const { FakeStore } = await import("./fake-store");
    const { createRoom, authorize, clearRegistryCache } = await import("../room-registry");
    const { appendEntry } = await import("../entries");
    const { wire } = await import("../operations");

    clearRegistryCache();
    const store = new FakeStore();
    const T0 = new Date("2026-08-23T12:00:00.000Z");
    const { room, ownerToken } = await createRoom(store, {
      topic: "t", ownerLabel: "A", peerLabel: "B", now: T0,
    });
    const a = await authorize(store, { presentedToken: ownerToken, now: T0 });
    assert.ok(a.ok);
    const e = await appendEntry(
      store, room, a.token,
      { type: "note", title: "x", body: "", checkedAgainst: "lib/store.ts:41" },
      T0,
    );
    const out = wire(e, { room, viewerSide: "a" }) as { checkedUrl?: string; checked: string };
    assert.equal(out.checkedUrl, undefined, "no repo must mean no field, not an empty one");
    assert.match(out.checked, /checked-against/, "the citation itself is unaffected");
  });
});
