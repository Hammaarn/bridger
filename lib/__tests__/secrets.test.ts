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
    peerLabel: "Trigvanta",
    now: T0,
  });
  const a = await authorize(store, { presentedToken: ownerToken, now: T0 });
  assert.ok(a.ok);
  return { store, room, jms: a.token };
}

describe("credential scanning — known shapes only", () => {
  const caught: Array<[string, string]> = [
    ["Bridger room token", "the token is REDACTED-FIXTURE-BRIDGER"],
    ["Anthropic API key", "REDACTED-FIXTURE-ANTHROPIC"],
    ["GitHub token", "use REDACTED-FIXTURE-GITHUB"],
    ["AWS access key id", "REDACTED-FIXTURE-AWS"],
    ["Slack token", "REDACTED-FIXTURE-SLACK"],
    ["Stripe secret key", "REDACTED-FIXTURE-STRIPE"],
    ["JSON Web Token", "REDACTED-FIXTURE-JWT"],
    ["private key block", "-----BEGIN RSA PRIVATE KEY-----\nMIIE..."],
    ["URL with embedded credentials", "redis://default:REDACTED-FIXTURE-PASSWORD@eu2-x.upstash.io:6379"],
    ["credential-shaped assignment", 'UPSTASH_REDIS_REST_TOKEN="AbCdEfGhIjKlMnOpQrStUvWxYz012345"'],
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
      title: "REDACTED-FIXTURE-AWS",
      body: "REDACTED-FIXTURE-BRIDGER",
    });
    assert.equal(hits.length, 2);
    assert.deepEqual(hits.map((h) => h.field).sort(), ["body", "title"]);
  });

  it("the refusal says retrying WORKS — it must not read like the STOP messages", () => {
    const msg = secretRefusal(scanForSecrets({ body: "REDACTED-FIXTURE-BRIDGER" }));
    assert.match(msg, /^REFUSED:/);
    assert.match(msg, /retrying WILL work/i);
    assert.doesNotMatch(msg, /^STOP/);
    assert.doesNotMatch(msg, /cannot succeed/i);
    assert.doesNotMatch(msg, /REDACTED-FIXTURE-BRIDGER/, "must not echo the secret back");
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
          { type: "note", title: "here is the key", body: "REDACTED-FIXTURE-GITHUB" },
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
            checkedAgainst: "REDACTED-FIXTURE-AWS",
          },
          T0,
        ),
      /REFUSED/,
    );
  });

  it("ORDERING: setContract refuses BEFORE storing the contract", async () => {
    const { store, room, jms } = await bridge();
    await assert.rejects(
      () => setContract(store, room, jms, "protocol 1\ntoken: REDACTED-FIXTURE-BRIDGER", "v1", T0),
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
