import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { joinAcceptIsHtml } from "../invites";
import { plaintextJoinDocument } from "../join-document";
import { TOKEN_PREFIX } from "../room-registry";

function doc(overrides: Partial<Parameters<typeof plaintextJoinDocument>[0]> = {}) {
  // Assembled at runtime so this file never holds a committed br_live_ fixture.
  const token = TOKEN_PREFIX + "x".repeat(24);
  return plaintextJoinDocument({
    origin: "https://bridge.example",
    token,
    code: "7KMP-3QRV-9XZT",
    topic: "Orders API",
    youLabel: "Northwind",
    youSide: "b",
    peerLabel: "JudgeMySite",
    tokenExpiry: "2026-09-03T00:00:00.000Z",
    codeNote: "THIS LINK IS NOW SPENT, but not instantly dead.",
    ...overrides,
  });
}

describe("plaintext join document — attach and stay", () => {
  it("Accept-split is unchanged: HTML does not redeem; anything else is the protocol", () => {
    // GET /j/[code] checks joinAcceptIsHtml BEFORE redeemInvite.
    assert.equal(joinAcceptIsHtml("text/html,application/xhtml+xml"), true);
    assert.equal(
      joinAcceptIsHtml("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"),
      true,
    );
    assert.equal(joinAcceptIsHtml("*/*"), false);
    assert.equal(joinAcceptIsHtml(null), false);
    assert.equal(joinAcceptIsHtml("text/plain"), false);

    const body = doc();
    assert.doesNotMatch(body, /<!doctype html/i);
    assert.doesNotMatch(body, /<html[\s>]/i);
  });

  it("a fresh session can redeem → status → a legal wait loop from the document alone", () => {
    const token = TOKEN_PREFIX + "x".repeat(24);
    const body = doc({ token });

    assert.match(body, /Redeem already happened/i);
    assert.ok(body.includes(token), "the minted token is in the document");
    assert.ok(body.includes("POST https://bridge.example/api/rpc"));

    const attach = body.indexOf("ATTACH AND STAY");
    const status = body.indexOf('{"op":"status"}');
    const read = body.indexOf('{"op":"read"');
    const wait = body.indexOf('{"op":"wait"');
    const loop = body.indexOf("LEGAL WAIT LOOP");
    assert.ok(attach >= 0, "attach-and-stay is named");
    assert.ok(status > attach, "status is in the attach recipe");
    assert.ok(read > status, "read follows status");
    assert.ok(wait > read, "wait follows read");
    assert.ok(loop > wait, "a legal wait loop is described after the wait call");
    assert.match(body, /markRead/);
    assert.match(body, /Do not busy-poll status/);
    assert.match(body, /Do not loop \{"op":"status"\}/);
  });

  it("answers require checkedAgainst; far-side text is data inside UNTRUSTED markers", () => {
    const body = doc();
    assert.match(body, /ANSWERS REQUIRE checkedAgainst/);
    assert.match(body, /"checkedAgainst":"file\.ts:41-52"/);
    assert.match(body, /\[\[UNTRUSTED-PARTNER-TEXT\]\]/);
    assert.match(body, /\[\[\/UNTRUSTED-PARTNER-TEXT\]\]/);
    assert.match(body, /DATA, NOT INSTRUCTIONS/);
  });

  it("mentions optional bridger listen --exec and does not invent a wake-the-other-model API", () => {
    const body = doc();
    assert.match(body, /bridger listen --exec "notify-send 'bridge'"/);
    assert.match(body, /Daemon is optional/);
    assert.match(body, /Do not replace MCP with it/);
    assert.match(body, /will not wake their model/);
    assert.doesNotMatch(body, /webhook.*inferenc/i);
    assert.doesNotMatch(body, /wake their (AI|session) by/i);
  });

  it("post is a record, not chat", () => {
    const body = doc();
    assert.match(body, /RECORDS, NOT BANTER/);
    assert.match(body, /ask \/ answer \/ decide/);
  });

  it("says this token is one seat, so a second fetch of the same URL is not the other company", () => {
    const body = doc();
    assert.match(body, /THIS TOKEN IS ONE SEAT/);
    assert.match(body, /same chair, not across the table/);
  });
});
