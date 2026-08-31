import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { prefersHtml, renderAboutHtml } from "../about-page";

/**
 * THE POINT OF THESE IS THE MACHINE PATH, NOT THE HTML.
 *
 * `/api/about` is the one route an agent is invited to read BEFORE it presents a
 * credential, and every verification command we publish — in `VERIFY.md`, on the
 * landing page, in the README, and inside the payload itself — is a bare `curl`.
 * Serving that a document instead of JSON would break the endpoint's entire
 * reason for existing, silently, for exactly the reader who is being most
 * careful.
 *
 * So the negative cases below are the load-bearing ones.
 */
describe("about: a browser gets HTML, everything else keeps its bytes", () => {
  const WILDCARD = ["*", "/", "*"].join("");

  const machine: Array<[string, string | null]> = [
    ["curl, which sends a wildcard", WILDCARD],
    ["no Accept header at all", null],
    ["an empty Accept header", ""],
    ["fetch() default in Node", WILDCARD],
    ["an explicit JSON request", "application/json"],
    ["JSON with a quality value", "application/json, text/plain;q=0.9"],
    ["JSON ranked ahead of HTML", "application/json, text/html;q=0.8"],
  ];

  for (const [name, accept] of machine) {
    it(`serves JSON to ${name}`, () => {
      assert.equal(prefersHtml(accept), false);
    });
  }

  const browsers: Array<[string, string]> = [
    [
      "Chrome",
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    ],
    ["Safari", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"],
    ["a bare text/html", "text/html"],
    ["HTML ranked ahead of JSON", "text/html, application/json;q=0.9"],
  ];

  for (const [name, accept] of browsers) {
    it(`serves HTML to ${name}`, () => {
      assert.equal(prefersHtml(accept), true);
    });
  }
});

describe("about: the rendering is of the payload, never a second copy of it", () => {
  const sample = {
    service: "bridger",
    what: "A shared record. See https://example.com/x for more.",
    permissions: { requests: "none", oauth: false },
    limits: { perTokenPerMinute: 20 },
    cannotVerify: ["The operator can read every room.", "No third party has audited this."],
  };

  const html = renderAboutHtml(sample, "https://bridger.nexus");

  it("declares a language and a title — the two things the review named", () => {
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<title>[^<]+<\/title>/);
  });

  it("renders every top-level key, including ones it was never told about", () => {
    // `cannotVerify` is in the known order; a key that is NOT must still appear,
    // or adding a field to the payload would silently drop it from the page.
    const withNovel = renderAboutHtml({ ...sample, brandNewField: "hello" }, "https://x.test");
    assert.match(withNovel, /Brand New Field/);
    assert.match(withNovel, /hello/);
  });

  it("carries the actual values, not a paraphrase of them", () => {
    assert.match(html, /No third party has audited this\./);
    assert.match(html, /20/);
    assert.match(html, />no</); // oauth: false renders as "no"
  });

  it("escapes markup in the payload rather than emitting it", () => {
    const nasty = renderAboutHtml({ what: "<script>alert(1)</script>" }, "https://x.test");
    assert.ok(!nasty.includes("<script>alert(1)</script>"));
    assert.match(nasty, /&lt;script&gt;/);
  });

  it("turns a bare URL into a link", () => {
    assert.match(html, /<a href="https:\/\/example\.com\/x"/);
  });

  it("splits a capital run into words — `callsAModel`, not `Calls AModel`", () => {
    const h = renderAboutHtml({ callsAModel: false, cannotVerify: ["x"] }, "https://x.test");
    assert.match(h, /Calls A Model/);
    assert.ok(!h.includes("Calls AModel"), "capital run stayed fused to the next word");
    assert.match(h, /Cannot Verify/);
  });
});
