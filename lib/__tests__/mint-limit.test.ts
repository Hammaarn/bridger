import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ROOMS_PER_DAY_PER_IP,
  chargeMint,
  clientIp,
  fingerprint,
  ipBucket,
  isAdminRequest,
} from "../mint-limit";
import { FakeStore, T0 } from "./fake-store";

const req = (headers: Record<string, string> = {}) =>
  new Request("https://bridger-nu.vercel.app/api/rooms", { method: "POST", headers });

/**
 * Restore the environment around anything that mutates it.
 *
 * `await fn()` rather than `return fn()` is the whole point and it is easy to
 * get wrong: with a synchronous `finally`, an async body has the environment
 * ripped out from under it the instant it yields, so every assertion inside
 * runs against the RESTORED env. The tests still pass — against the wrong
 * values — which is the worst available outcome. This helper is async for that
 * reason, and every caller awaits it.
 */
async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** Every env-sensitive test runs with a known salt and no admin credentials. */
const CLEAN = {
  BRIDGER_ADMIN_TOKEN: undefined,
  BRIDGER_ADMIN_IPS: undefined,
  BRIDGER_IP_SALT: "pepper",
} as const;

describe("ipBucket — IPv6 is the trap, and counting it exactly is the same as no limit", () => {
  it("counts an IPv4 address exactly", () => {
    assert.equal(ipBucket("203.0.113.5"), "v4:203.0.113.5");
    assert.notEqual(ipBucket("203.0.113.5"), ipBucket("203.0.113.6"));
  });

  it("[!!] collapses IPv6 to its /64 — every address in one customer's prefix is ONE bucket", () => {
    const a = ipBucket("2001:db8:abcd:1234::1");
    const b = ipBucket("2001:db8:abcd:1234:ffff:ffff:ffff:ffff");
    const c = ipBucket("2001:0db8:abcd:1234:0000:0000:0000:0099");
    assert.equal(a, b, "same /64 must be the same bucket");
    assert.equal(a, c, "leading zeros and expansion must not change the bucket");
  });

  it("a DIFFERENT /64 is a different bucket — the limit still bites across customers", () => {
    assert.notEqual(ipBucket("2001:db8:abcd:1234::1"), ipBucket("2001:db8:abcd:9999::1"));
  });

  it("treats an IPv4-mapped IPv6 address as the IPv4 client it is", () => {
    assert.equal(ipBucket("::ffff:203.0.113.5"), "v4:203.0.113.5");
  });

  it("tolerates the forms a proxy actually emits — brackets, case, zone id", () => {
    const plain = ipBucket("2001:db8:abcd:1234::1");
    assert.equal(ipBucket("[2001:DB8:ABCD:1234::1]"), plain);
    assert.equal(ipBucket("2001:db8:abcd:1234::1%eth0"), plain);
  });

  it("a compressed prefix shorter than four hextets still yields four", () => {
    assert.equal(ipBucket("fe80::1"), "v6:fe80:0:0:0::/64");
  });
});

describe("fingerprint — the counter must not become a log of who visited", () => {
  it("is stable for one bucket and different across buckets", async () =>
    await withEnv(CLEAN, () => {
      assert.equal(fingerprint("v4:203.0.113.5"), fingerprint("v4:203.0.113.5"));
      assert.notEqual(fingerprint("v4:203.0.113.5"), fingerprint("v4:203.0.113.6"));
    }));

  it("never contains the address it was derived from", async () =>
    await withEnv(CLEAN, () => {
      assert.ok(!fingerprint("v4:203.0.113.5").includes("203"));
      assert.match(fingerprint("v4:203.0.113.5"), /^[0-9a-f]{32}$/);
    }));

  it("changing the salt changes every hash — an unsalted v4 hash is brute-forceable", async () => {
    const one = await withEnv({ BRIDGER_IP_SALT: "salt-one" }, () => fingerprint("v4:203.0.113.5"));
    const two = await withEnv({ BRIDGER_IP_SALT: "salt-two" }, () => fingerprint("v4:203.0.113.5"));
    assert.notEqual(one, two);
  });

  it("[!!] length-prefixing stops one salt impersonating another", async () => {
    // Without domain separation, salt "ab" + bucket "cd" and salt "a" + bucket
    // "bcd" are the same byte string and hash identically.
    const ab = await withEnv({ BRIDGER_IP_SALT: "ab" }, () => fingerprint("cd"));
    const a = await withEnv({ BRIDGER_IP_SALT: "a" }, () => fingerprint("bcd"));
    assert.notEqual(ab, a);
  });
});

describe("clientIp — the platform's header wins over the caller's", () => {
  it("prefers x-real-ip, which Vercel sets and the caller cannot", () => {
    assert.equal(
      clientIp(req({ "x-real-ip": "203.0.113.5", "x-forwarded-for": "1.2.3.4" })),
      "203.0.113.5",
    );
  });

  it("falls back to the LEFTMOST x-forwarded-for entry — the original client", () => {
    assert.equal(clientIp(req({ "x-forwarded-for": "203.0.113.5, 70.0.0.1, 10.0.0.1" })), "203.0.113.5");
  });

  it("returns null when nothing identifies the caller, rather than guessing", () => {
    assert.equal(clientIp(req()), null);
  });
});

describe("isAdminRequest — identity survives a DHCP lease; location does not", () => {
  it("accepts the admin header and rejects a wrong one", async () =>
    await withEnv({ BRIDGER_ADMIN_TOKEN: "s3cret", BRIDGER_ADMIN_IPS: undefined }, () => {
      assert.equal(isAdminRequest(req({ "x-bridger-admin": "s3cret" })), true);
      assert.equal(isAdminRequest(req({ "x-bridger-admin": "wrong" })), false);
    }));

  it("[!!] a room token in the Authorization header is NOT an admin credential", async () =>
    await withEnv({ BRIDGER_ADMIN_TOKEN: "s3cret", BRIDGER_ADMIN_IPS: undefined }, () => {
      assert.equal(isAdminRequest(req({ authorization: "Bearer s3cret" })), false);
    }));

  it("refuses everyone when no admin token is configured — absent must not mean open", async () =>
    await withEnv({ BRIDGER_ADMIN_TOKEN: undefined, BRIDGER_ADMIN_IPS: undefined }, () => {
      assert.equal(isAdminRequest(req({ "x-bridger-admin": "" })), false);
      assert.equal(isAdminRequest(req()), false);
    }));

  it("honours the IP allowlist by BUCKET, so a /64 neighbour still matches", async () =>
    await withEnv({ BRIDGER_ADMIN_TOKEN: undefined, BRIDGER_ADMIN_IPS: "2001:db8:abcd:1234::1" }, () => {
      assert.equal(isAdminRequest(req({ "x-real-ip": "2001:db8:abcd:1234::999" })), true);
      assert.equal(isAdminRequest(req({ "x-real-ip": "2001:db8:abcd:9999::1" })), false);
    }));
});

describe("chargeMint — the quota", () => {
  const ip = { "x-real-ip": "203.0.113.5" };

  it(`allows exactly ${ROOMS_PER_DAY_PER_IP} and refuses the next`, async () =>
    await withEnv(CLEAN, async () => {
      const store = new FakeStore();
      for (let i = 1; i <= ROOMS_PER_DAY_PER_IP; i++) {
        const v = await chargeMint(store, req(ip), T0);
        assert.equal(v.ok, true, `call ${i} should be allowed`);
      }
      const refused = await chargeMint(store, req(ip), T0);
      assert.equal(refused.ok, false);
      assert.equal(refused.ok === false && refused.reason, "mint-quota");
    }));

  it("[!!] charges BEFORE deciding — a read-then-write limiter lets two concurrent calls both win", async () =>
    await withEnv(CLEAN, async () => {
      const store = new FakeStore();
      // Fire every request for the day at once. An atomic incr means the
      // verdicts are 3 allowed / N refused no matter how they interleave.
      const verdicts = await Promise.all(
        Array.from({ length: 8 }, () => chargeMint(store, req(ip), T0)),
      );
      assert.equal(verdicts.filter((v) => v.ok).length, ROOMS_PER_DAY_PER_IP);
    }));

  it("counts a different address separately", async () =>
    await withEnv(CLEAN, async () => {
      const store = new FakeStore();
      for (let i = 0; i < ROOMS_PER_DAY_PER_IP; i++) await chargeMint(store, req(ip), T0);
      const other = await chargeMint(store, req({ "x-real-ip": "198.51.100.9" }), T0);
      assert.equal(other.ok, true);
    }));

  it("[!!] one IPv6 customer cannot buy a fresh quota by changing address", async () =>
    await withEnv(CLEAN, async () => {
      const store = new FakeStore();
      const addrs = ["2001:db8:a:b::1", "2001:db8:a:b::2", "2001:db8:a:b::3", "2001:db8:a:b::4"];
      const verdicts = [];
      for (const a of addrs) verdicts.push(await chargeMint(store, req({ "x-real-ip": a }), T0));
      assert.equal(verdicts.filter((v) => v.ok).length, ROOMS_PER_DAY_PER_IP);
      assert.equal(verdicts[3].ok, false, "the fourth address in one /64 must be refused");
    }));

  it("resets on a new UTC day, and says when", async () =>
    await withEnv(CLEAN, async () => {
      const store = new FakeStore();
      for (let i = 0; i < ROOMS_PER_DAY_PER_IP; i++) await chargeMint(store, req(ip), T0);
      const refused = await chargeMint(store, req(ip), T0);
      assert.equal(refused.ok, false);
      if (refused.ok === false) assert.match(refused.resetsAt, /T00:00:00\.000Z$/);

      const tomorrow = new Date(T0.getTime() + 24 * 60 * 60 * 1000);
      const fresh = await chargeMint(store, req(ip), tomorrow);
      assert.equal(fresh.ok, true);
    }));

  it("the admin is never counted and never refused", async () =>
    await withEnv({ BRIDGER_ADMIN_TOKEN: "s3cret", BRIDGER_ADMIN_IPS: undefined, BRIDGER_IP_SALT: "p" }, async () => {
      const store = new FakeStore();
      for (let i = 0; i < 20; i++) {
        const v = await chargeMint(store, req({ ...ip, "x-bridger-admin": "s3cret" }), T0);
        assert.equal(v.ok, true);
        assert.equal(v.ok === true && v.reason, "admin");
      }
      // ...and having done so, an ordinary caller from that same address still
      // has their full quota: the admin's traffic was never counted at all.
      assert.equal((await chargeMint(store, req(ip), T0)).ok, true);
    }));

  it("an unidentifiable caller shares one bucket rather than being unlimited", async () =>
    await withEnv(CLEAN, async () => {
      const store = new FakeStore();
      const verdicts = [];
      for (let i = 0; i < 5; i++) verdicts.push(await chargeMint(store, req(), T0));
      assert.equal(verdicts.filter((v) => v.ok).length, ROOMS_PER_DAY_PER_IP);
    }));
});
