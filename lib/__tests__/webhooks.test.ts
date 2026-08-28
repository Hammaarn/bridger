/**
 * Wake-up hooks — the first outbound request this service makes.
 *
 * The bulk of this file is the SSRF guard, and that ratio is correct. Handing a
 * server an operator-supplied URL and asking it to POST there is a server-side
 * request forgery primitive by construction; everything else here is
 * bookkeeping by comparison.
 *
 * The other two properties worth stating up front, because both are silent
 * failures if they break:
 *   - your own write must never wake you (a room that feeds on its own tail);
 *   - the payload must never carry content (the far side consented to us
 *     reading their text, not to it being POSTed to a URL they have not seen).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  assertDeliverableUrl,
  isPublicAddress,
  signBody,
  verifySignature,
  registerWebhook,
  unregisterWebhook,
  listWebhooks,
  dispatchWake,
  deliverOnce,
  clearWebhookCache,
  redactWebhook,
  WebhookRejected,
  type RoomWebhook,
} from "../webhooks";
import { MAX_WEBHOOK_FAILURES, WEBHOOKS_KEY } from "../store";
import { FakeStore } from "./fake-store";

const ROOM = "room-1";
const T0 = new Date("2026-08-28T12:00:00.000Z");

beforeEach(() => clearWebhookCache());

// ── the guard ───────────────────────────────────────────────────────────────

describe("[!!] the SSRF guard — an operator-supplied URL the server will fetch", () => {
  const refused = (url: string) => {
    assert.throws(() => assertDeliverableUrl(url), WebhookRejected, `should have refused ${url}`);
  };

  it("refuses loopback in every spelling", () => {
    refused("https://localhost/hook");
    refused("https://sub.localhost/hook");
    refused("https://127.0.0.1/hook");
    refused("https://127.1.2.3/hook");
    refused("https://[::1]/hook");
  });

  it("refuses the private ranges, including the two people forget", () => {
    refused("https://10.0.0.1/h");
    refused("https://172.16.0.1/h");
    refused("https://172.31.255.254/h");
    refused("https://192.168.1.1/h");
    refused("https://100.64.0.1/h"); // carrier-grade NAT
    refused("https://[fd00::1]/h"); // unique local
    refused("https://[fe80::1]/h"); // link-local
  });

  it("[!!] refuses the cloud metadata address", () => {
    // 169.254.169.254 is the single most valuable SSRF target on any cloud
    // host: it hands out instance credentials to anything that asks.
    refused("https://169.254.169.254/latest/meta-data/");
    assert.equal(isPublicAddress("169.254.169.254"), false);
  });

  it("refuses a v4-mapped v6 address that hides a private v4", () => {
    // ::ffff:10.0.0.1 is 10.0.0.1 wearing a v6 hat, and a naive check passes it.
    assert.equal(isPublicAddress("::ffff:10.0.0.1"), false);
    assert.equal(isPublicAddress("::ffff:127.0.0.1"), false);
  });

  it("refuses internal-looking names", () => {
    refused("https://db.internal/h");
    refused("https://printer.local/h");
    refused("https://thing.home.arpa/h");
  });

  it("refuses plain http, and credentials smuggled into the URL", () => {
    refused("http://example.com/h");
    refused("https://user:pass@example.com/h");
  });

  it("refuses what cannot be parsed or is absurd", () => {
    refused("not-a-url");
    refused("");
    assert.throws(() => assertDeliverableUrl(undefined), WebhookRejected);
    refused("https://example.com/" + "a".repeat(2100));
  });

  it("NEGATIVE CONTROL: ordinary public https URLs are accepted", () => {
    // Without this the suite would pass if the guard refused everything, which
    // is the failure mode that looks exactly like working security.
    for (const ok of [
      "https://example.com/hooks/bridger",
      "https://gw.example.co.uk:8443/wake?x=1",
      "https://93.184.216.34/hook",
      "https://[2606:2800:220:1:248:1893:25c8:1946]/hook",
    ]) {
      assert.ok(assertDeliverableUrl(ok) instanceof URL, `should have accepted ${ok}`);
    }
  });

  it("NEGATIVE CONTROL: public addresses adjacent to private ranges pass", () => {
    // 172.15 and 172.32 bracket the private block; 100.128 sits just past CGNAT.
    assert.equal(isPublicAddress("172.15.0.1"), true);
    assert.equal(isPublicAddress("172.32.0.1"), true);
    assert.equal(isPublicAddress("100.128.0.1"), true);
    assert.equal(isPublicAddress("8.8.8.8"), true);
  });
});

// ── signing ─────────────────────────────────────────────────────────────────

describe("signing — so a receiver can prove the POST came from us", () => {
  it("is a stable prefixed hex HMAC", () => {
    const sig = signBody("s3cret", '{"a":1}');
    assert.match(sig, /^sha256=[0-9a-f]{64}$/);
    assert.equal(sig, signBody("s3cret", '{"a":1}'));
  });

  it("changes with the body and with the secret", () => {
    assert.notEqual(signBody("a", "{}"), signBody("b", "{}"));
    assert.notEqual(signBody("a", "{}"), signBody("a", "{ }"));
  });

  it("verifies, and rejects a wrong or truncated signature without throwing", () => {
    const body = '{"event":"entry"}';
    assert.equal(verifySignature("k", body, signBody("k", body)), true);
    assert.equal(verifySignature("k", body, signBody("other", body)), false);
    assert.equal(verifySignature("k", body, "sha256=short"), false);
    assert.equal(verifySignature("k", body, ""), false);
    assert.equal(verifySignature("k", body, undefined as unknown as string), false);
  });
});

// ── registration ────────────────────────────────────────────────────────────

describe("registration", () => {
  it("mints a secret when none is given, and shows it once", async () => {
    const store = new FakeStore();
    const { hook, secret } = await registerWebhook(store, ROOM, { side: "a", url: "https://e.example/h" }, T0);
    assert.ok(secret.length >= 20);
    assert.equal(hook.secret, secret);
    assert.equal(redactWebhook(hook).secretSet, true);
    assert.equal("secret" in redactWebhook(hook), false, "a later read must never re-show it");
  });

  it("replaces a seat's own hook rather than accumulating dead endpoints", async () => {
    const store = new FakeStore();
    await registerWebhook(store, ROOM, { side: "a", url: "https://one.example/h" }, T0);
    const { replaced } = await registerWebhook(store, ROOM, { side: "a", url: "https://two.example/h" }, T0);
    assert.equal(replaced, true);
    const hooks = await listWebhooks(store, ROOM);
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].url, "https://two.example/h");
  });

  it("[!!] one seat cannot remove the other seat's hook", async () => {
    // Otherwise either party could silently deafen the other.
    const store = new FakeStore();
    await registerWebhook(store, ROOM, { side: "a", url: "https://a.example/h" }, T0);
    assert.equal(await unregisterWebhook(store, ROOM, { side: "b" }), false);
    assert.equal((await listWebhooks(store, ROOM)).length, 1);
    assert.equal(await unregisterWebhook(store, ROOM, { side: "a" }), true);
    assert.equal((await listWebhooks(store, ROOM)).length, 0);
  });

  it("removing the last hook deletes the key rather than storing []", async () => {
    const store = new FakeStore();
    await registerWebhook(store, ROOM, { side: "a", url: "https://a.example/h" }, T0);
    await unregisterWebhook(store, ROOM, { side: "a" });
    assert.equal(await store.get(WEBHOOKS_KEY(ROOM)), null);
  });
});

// ── delivery ────────────────────────────────────────────────────────────────

const hookFor = (side: "a" | "b", over: Partial<RoomWebhook> = {}): RoomWebhook => ({
  id: "wh_test",
  side,
  url: "https://93.184.216.34/hook", // literal public IP: no DNS in tests
  secret: "k",
  createdAt: T0.toISOString(),
  failCount: 0,
  ...over,
});

const captureFetch = () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, impl };
};

describe("[!!] delivery carries metadata and never content", () => {
  it("sends seq, type and side — and no title or body", async () => {
    // The far side consented to us READING their text, not to it being POSTed
    // to a URL they have never seen. A leaked hook URL must disclose that
    // something happened, never what.
    const store = new FakeStore();
    await registerWebhook(store, ROOM, { side: "b", url: "https://93.184.216.34/hook" }, T0);
    const { calls, impl } = captureFetch();

    await dispatchWake(store, ROOM, { seq: 12, type: "question", side: "a", ts: T0.toISOString() }, T0, impl);

    assert.equal(calls.length, 1);
    const body = JSON.parse(String(calls[0].init.body));
    assert.deepEqual(Object.keys(body).sort(), ["at", "event", "next", "room", "seq", "side", "type"].sort());
    assert.equal(body.seq, 12);
    const raw = String(calls[0].init.body);
    assert.equal(/title|body|checkedAgainst/i.test(raw), false, "no content field may appear");
  });

  it("signs the exact bytes it sends", async () => {
    const store = new FakeStore();
    const { secret } = await registerWebhook(store, ROOM, { side: "b", url: "https://93.184.216.34/hook" }, T0);
    const { calls, impl } = captureFetch();
    await dispatchWake(store, ROOM, { seq: 1, type: "note", side: "a", ts: T0.toISOString() }, T0, impl);
    const h = calls[0].init.headers as Record<string, string>;
    assert.equal(verifySignature(secret, String(calls[0].init.body), h["X-Bridger-Signature"]), true);
  });

  it("[!!] does not follow redirects — a 302 to a private address defeats every check", async () => {
    const impl = (async () => new Response(null, { status: 302 })) as unknown as typeof fetch;
    const out = await deliverOnce(hookFor("b"), { event: "entry", room: ROOM, seq: 1, type: "note", side: "a", at: T0.toISOString(), next: "" }, impl);
    assert.equal(out.ok, false);
    assert.equal(out.status, "redirect-302");
  });

  it("a thrown fetch is a failed delivery, never a thrown write", async () => {
    const impl = (async () => { throw new Error("boom"); }) as unknown as typeof fetch;
    const out = await deliverOnce(hookFor("b"), { event: "entry", room: ROOM, seq: 1, type: "note", side: "a", at: T0.toISOString(), next: "" }, impl);
    assert.equal(out.ok, false);
  });
});

describe("[!!] your own write never wakes you", () => {
  it("skips hooks belonging to the writing seat", async () => {
    // Without this an agent that replies wakes itself, and the room feeds on
    // its own tail until something else stops it.
    const store = new FakeStore();
    await registerWebhook(store, ROOM, { side: "a", url: "https://93.184.216.34/hook" }, T0);
    const { calls, impl } = captureFetch();
    await dispatchWake(store, ROOM, { seq: 5, type: "note", side: "a", ts: T0.toISOString() }, T0, impl);
    assert.equal(calls.length, 0);
  });

  it("NEGATIVE CONTROL: the other seat's write does wake it", async () => {
    const store = new FakeStore();
    await registerWebhook(store, ROOM, { side: "a", url: "https://93.184.216.34/hook" }, T0);
    const { calls, impl } = captureFetch();
    await dispatchWake(store, ROOM, { seq: 5, type: "note", side: "b", ts: T0.toISOString() }, T0, impl);
    assert.equal(calls.length, 1);
  });
});

describe("a dead endpoint is dropped rather than retried forever", () => {
  const failing = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;

  it("counts consecutive failures", async () => {
    const store = new FakeStore();
    await registerWebhook(store, ROOM, { side: "b", url: "https://93.184.216.34/hook" }, T0);
    for (let i = 0; i < 3; i++) {
      clearWebhookCache();
      await dispatchWake(store, ROOM, { seq: i, type: "note", side: "a", ts: T0.toISOString() }, T0, failing);
    }
    assert.equal((await listWebhooks(store, ROOM))[0].failCount, 3);
  });

  it("drops the hook at the cap", async () => {
    const store = new FakeStore();
    await registerWebhook(store, ROOM, { side: "b", url: "https://93.184.216.34/hook" }, T0);
    for (let i = 0; i < MAX_WEBHOOK_FAILURES; i++) {
      clearWebhookCache();
      await dispatchWake(store, ROOM, { seq: i, type: "note", side: "a", ts: T0.toISOString() }, T0, failing);
    }
    assert.equal((await listWebhooks(store, ROOM)).length, 0);
  });

  it("a success resets the count — a blip is not a death sentence", async () => {
    const store = new FakeStore();
    await registerWebhook(store, ROOM, { side: "b", url: "https://93.184.216.34/hook" }, T0);
    clearWebhookCache();
    await dispatchWake(store, ROOM, { seq: 1, type: "note", side: "a", ts: T0.toISOString() }, T0, failing);
    assert.equal((await listWebhooks(store, ROOM))[0].failCount, 1);
    clearWebhookCache();
    await dispatchWake(store, ROOM, { seq: 2, type: "note", side: "a", ts: T0.toISOString() }, T0, captureFetch().impl);
    assert.equal((await listWebhooks(store, ROOM))[0].failCount, 0);
  });
});

// ── what it costs the database ──────────────────────────────────────────────

describe("[!!] what this costs a room that has no webhooks at all", () => {
  it("one command on the first write, then nothing for the cache window", async () => {
    // U1's standing rule: a change that helps the caller must state what it
    // costs the database. The write path went 10 -> 6 commands at S#283 and a
    // per-write `get` here would hand a chunk of that straight back.
    const store = new FakeStore();
    let gets = 0;
    const counting = new Proxy(store, {
      get(t, p, r) {
        const v = Reflect.get(t, p, r);
        if (p === "get") return (...a: unknown[]) => { gets++; return (v as Function).apply(t, a); };
        return typeof v === "function" ? (v as Function).bind(t) : v;
      },
    }) as typeof store;

    clearWebhookCache();
    const entry = { seq: 1, type: "note", side: "a" as const, ts: T0.toISOString() };
    await dispatchWake(counting, ROOM, entry, T0);
    assert.ok(gets > 0, "the counter never fired — this test measured nothing");
    assert.equal(gets, 1, "a cold instance reads the hook list once");

    const cold = gets;
    for (let i = 0; i < 5; i++) await dispatchWake(counting, ROOM, entry, T0);
    assert.equal(gets, cold, "five more writes inside the cache window must cost zero reads");
  });
});
