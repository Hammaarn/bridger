import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { scanForSecrets, secretRefusal } from "../secrets";
import { appendEntry, getContract, readEntries, setContract } from "../entries";
import { authorize, clearRegistryCache, createRoom } from "../room-registry";
import { FakeStore, T0 } from "./fake-store";

beforeEach(() => clearRegistryCache());

async function bridge() {
  const store = new FakeStore();
  const { room, ownerToken } = await createRoom(store, {
    topic: "t",
    ownerLabel: "JudgeMySite",
    peerLabel: "Northwind",
    now: T0,
  });
  const a = await authorize(store, { presentedToken: ownerToken, now: T0 });
  assert.ok(a.ok);
  return { store, room, jms: a.token };
}

/**
 * Fixtures are ASSEMBLED AT RUNTIME, never written as literals.
 *
 * Every string below is fake and always was. But a fixture realistic enough to
 * prove our scanner catches a Stripe key is, by construction, realistic enough
 * to trip everyone else's scanner too — and it did: GitHub push protection
 * blocked the first publish of this repository, citing `Stripe API Key` at line
 * 31 of this file. That block was correct behaviour on a string that was never
 * a credential, which is the whole difficulty with testing a secret detector.
 *
 * Joining fragments means no credential-shaped literal exists in the source, so
 * no scanner sees one, while the value handed to `scanForSecrets` at runtime is
 * byte-identical to what it was before. The tests exercise exactly the same
 * regexes against exactly the same input; only the file on disk changed.
 *
 * If you add a case here, assemble it the same way. A repository whose purpose
 * is "read this and decide whether to trust us" should not carry strings that
 * make an auditor's tooling light up.
 */
const j = (...parts: string[]) => parts.join("");

/** The same three fakes the later cases reuse. Assembled, for the reason above. */
const FAKE_AWS = j("AKIA", "IOSFODNN7EXAMPLE");
const FAKE_BRIDGER = j("br_", "live_", "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9v");
const FAKE_GITHUB = j("ghp", "_aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5");

describe("credential scanning — known shapes only", () => {
  const caught: Array<[string, string]> = [
    ["Bridger room token", j("the token is br_", "live_", "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9v")],
    ["Anthropic API key", j("sk-", "ant-", "api03-AAAABBBBCCCCDDDDEEEEFFFFGGGG")],
    ["GitHub token", j("use ghp", "_aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5")],
    ["AWS access key id", j("AKIA", "IOSFODNN7EXAMPLE")],
    ["Slack token", j("xoxb", "-1234567890-abcdefghijkl")],
    ["Stripe secret key", j("sk", "_live_", "aB3dE5fG7hJ9kL1mN3pQ5rS7")],
    [
      "JSON Web Token",
      j("eyJhbGciOiJIUzI1NiJ9.", "eyJzdWIiOiIxMjM0NTY3ODkwIn0.", "dBjftJeZ4CVPmB92K27uhbUJU1p1r"),
    ],
    ["private key block", j("-----BEGIN ", "RSA PRIVATE KEY", "-----\nMIIE...")],
    [
      "URL with embedded credentials",
      j("redis://default:", "REDACTED-FIXTURE-PASSWORD", "@eu2-x.upstash.io:6379"),
    ],
    [
      "credential-shaped assignment",
      j("UPSTASH_REDIS_REST_TOKEN=", '"AbCdEfGhIjKlMnOpQrStUvWxYz012345"'),
    ],
  ];

  for (const [kind, text] of caught) {
    it(`catches ${kind}`, () => {
      const hits = scanForSecrets({ body: text });
      assert.equal(hits.length >= 1, true, `expected a hit for ${kind}`);
      assert.equal(hits[0].kind, kind);
      assert.equal(hits[0].field, "body");
      assert.ok(hits[0].hint.length <= 8, "the hint must never carry the whole secret");
    });
  }

  /**
   * The false positives that would matter most. `checkedAgainst` exists to hold
   * exactly these, so a scanner that refuses them refuses the product.
   */
  const allowed = [
    "commit a2b0f35",
    "lib/external/usage-report.ts:41",
    "GET /api/health",
    "migration 0031",
    "e1619d4 is production, f625352 is master",
    "the run id was 8f3a1c9d2b4e6f8a0c1e3d5b7a9f2e4c",
    "see https://bridger-nu.vercel.app/api/mcp",
    "set ADMIN_API_TOKEN on production (do not commit it)",
    "the header is Authorization: Bearer <your token>",
  ];

  for (const text of allowed) {
    it(`does NOT fire on provenance: "${text.slice(0, 40)}"`, () => {
      assert.deepEqual(scanForSecrets({ checkedAgainst: text }), []);
    });
  }

  it("reports every distinct problem at once, not one refusal at a time", () => {
    const hits = scanForSecrets({
      title: FAKE_AWS,
      body: FAKE_BRIDGER,
    });
    assert.equal(hits.length, 2);
    assert.deepEqual(hits.map((h) => h.field).sort(), ["body", "title"]);
  });

  it("the refusal says retrying WORKS — it must not read like the STOP messages", () => {
    const msg = secretRefusal(scanForSecrets({ body: FAKE_BRIDGER }));
    assert.match(msg, /^REFUSED:/);
    assert.match(msg, /retrying WILL work/i);
    assert.doesNotMatch(msg, /^STOP/);
    assert.doesNotMatch(msg, /cannot succeed/i);
    assert.doesNotMatch(msg, new RegExp(FAKE_BRIDGER), "must not echo the secret back");
  });
});

describe("the write path refuses, and writes NOTHING", () => {
  it("appendEntry throws and appends no entry", async () => {
    const { store, room, jms } = await bridge();
    await assert.rejects(
      () =>
        appendEntry(
          store,
          room,
          jms,
          { type: "note", title: "here is the key", body: FAKE_GITHUB },
          T0,
        ),
      /REFUSED/,
    );
    assert.deepEqual(await readEntries(store, room.id), [], "a refused write must leave no trace");
  });

  it("scans checkedAgainst too — the field an agent fills fastest", async () => {
    const { store, room, jms } = await bridge();
    await assert.rejects(
      () =>
        appendEntry(
          store,
          room,
          jms,
          {
            type: "answer",
            title: "yes",
            body: "confirmed",
            checkedAgainst: FAKE_AWS,
          },
          T0,
        ),
      /REFUSED/,
    );
  });

  it("ORDERING: setContract refuses BEFORE storing the contract", async () => {
    const { store, room, jms } = await bridge();
    await assert.rejects(
      () => setContract(store, room, jms, `protocol 1\ntoken: ${FAKE_BRIDGER}`, "v1", T0),
      /REFUSED/,
    );
    assert.equal(
      await getContract(store, room.id),
      null,
      "setContract writes to Redis BEFORE appendEntry runs — a scan only in appendEntry " +
        "would refuse the caller while the 100k body sat stored",
    );
  });

  it("a clean write still goes through", async () => {
    const { store, room, jms } = await bridge();
    await appendEntry(
      store,
      room,
      jms,
      { type: "question", title: "does verdict carry a grade?", body: "checked route.ts:876" },
      T0,
    );
    assert.equal((await readEntries(store, room.id)).length, 1);
  });
});
