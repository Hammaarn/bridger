/**
 * THE COST OF A POLL (S#281, C3b).
 *
 * The whole justification for `/api/since` is a number: two Redis commands
 * instead of six. If that number drifts the route has no reason to exist, so it
 * is asserted rather than described.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { FakeStore } from "./fake-store";
import { authorize, createRoom, clearRegistryCache } from "../room-registry";

const T0 = new Date("2026-08-24T02:00:00.000Z");
const REDIS_OPS = new Set([
  "get", "set", "setex", "del", "incr", "expire",
  "rpush", "lpush", "ltrim", "lrange", "llen", "sadd", "srem", "smembers",
]);

/** Wrap a store so every Redis call is counted. */
function counting(store: FakeStore) {
  const calls: string[] = [];
  const proxy = new Proxy(store, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      const name = String(prop);
      if (!REDIS_OPS.has(name)) return (v as (...a: unknown[]) => unknown).bind(target);
      return (...args: unknown[]) => {
        calls.push(name);
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { proxy, calls };
}

async function room() {
  clearRegistryCache();
  const store = new FakeStore();
  const made = await createRoom(store, {
    topic: "cost", ownerLabel: "A", peerLabel: "B", now: T0,
  });
  return { store, token: made.ownerToken };
}

describe("[!!] a minimal authorize costs a fraction of a full one", () => {
  it("minimal skips the daily counters, the trail and the streak", async () => {
    const { store, token } = await room();

    clearRegistryCache();
    const full = counting(store);
    const a = await authorize(full.proxy, { presentedToken: token, now: T0 });
    assert.ok(a.ok, "control: a full authorize must still succeed");

    clearRegistryCache();
    const min = counting(store);
    const b = await authorize(min.proxy, {
      presentedToken: token, now: T0, minimal: true, rateCeiling: 4,
    });
    assert.ok(b.ok, "control: a minimal authorize must still authorise");

    // LIVENESS: a proxy that stopped intercepting reports zero and passes any
    // ceiling. Absence and success must never render the same.
    assert.ok(full.calls.length > 0 && min.calls.length > 0, "the counter never fired");

    assert.ok(
      min.calls.length < full.calls.length,
      `minimal (${min.calls.length}) must cost less than full (${full.calls.length})`,
    );
    // The route's claim is "two commands" once the caches are warm. Cold, the
    // token and room reads are added; this bounds the cold case.
    assert.ok(
      min.calls.length <= 4,
      `a minimal authorize spent ${min.calls.length} commands: ${min.calls.join(", ")}`,
    );
  });

  it("[!!] warm — a steady-state poll is TWO commands END TO END", async () => {
    const { store, token } = await room();
    // First call warms the token and room caches, exactly as a running daemon's
    // second poll onward would find them.
    await authorize(store, { presentedToken: token, now: T0, minimal: true, rateCeiling: 4 });

    const warm = counting(store);
    const out = await authorize(warm.proxy, {
      presentedToken: token, now: T0, minimal: true, rateCeiling: 4,
    });
    assert.ok(out.ok);
    assert.ok(warm.calls.length > 0, "the counter never fired");

    // Authorise is ONE command warm: the kill switch is cached (S#281), and so
    // are the token and room records. All that remains is the rate-limit
    // increment, which is the one bound this route still leans on.
    assert.equal(
      warm.calls.length,
      1,
      `warm authorize spent ${warm.calls.length} (${warm.calls.join(", ")})`,
    );

    // The route then reads the seq counter itself. That is the whole poll.
    const { SEQ_KEY } = await import("../store");
    await warm.proxy.get(SEQ_KEY(out.ok ? out.room.id : ""));
    assert.equal(
      warm.calls.length,
      2,
      `a full poll spent ${warm.calls.length} commands (${warm.calls.join(", ")}) — ` +
        `the entire argument for this route is that it spends two. ` +
        `\`wait\` spends ~16 for the same question.`,
    );
  });

  it("minimal still enforces the per-minute ceiling — it is the only bound left", async () => {
    const { store, token } = await room();
    let refused = false;
    for (let i = 0; i < 8; i++) {
      const out = await authorize(store, {
        presentedToken: token, now: T0, minimal: true, rateCeiling: 4,
      });
      if (!out.ok) {
        assert.equal(out.reason, "rate-limited");
        refused = true;
        break;
      }
    }
    assert.ok(refused, "skipping the daily cap is only safe because THIS still bites");
  });

  it("a minimal call does NOT consume the caller's daily budget", async () => {
    // The daily cap protects a caller's model quota. A daemon has none — it
    // burns no tokens — so charging it there would spend a budget it does not
    // use, on behalf of an agent that is not running.
    const { store, token } = await room();
    for (let i = 0; i < 3; i++) {
      await authorize(store, { presentedToken: token, now: T0, minimal: true, rateCeiling: 100 });
    }
    const keys = [...store.kv.keys()].filter((k) => k.includes(":used:"));
    assert.deepEqual(keys, [], `minimal polls charged the daily counter: ${keys.join(", ")}`);
  });
});
