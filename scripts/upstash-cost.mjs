/**
 * THE UPSTASH BILL, MEASURED — all four metered values, not just commands.
 *
 * Upstash Redis FREE meters four things, and S#281 had only ever audited one:
 *
 *     commands   500,000 / month
 *     storage    256 MB
 *     bandwidth  10 GB / month
 *     databases  1
 *
 * Measuring commands and calling it an audit is the same shape as reading a
 * rule instead of what the rule produces: three of the four ceilings were never
 * looked at, and a product can be well under its command budget while sitting
 * on a bandwidth problem.
 *
 * This instruments the REAL store interface — every operation the real code
 * calls — and counts calls, bytes sent and bytes received per logical action.
 * Nothing here is estimated from a docstring.
 *
 *     node scripts/upstash-cost.mjs
 *
 * It is a reporting arm, not a test: it asserts nothing and gates nothing. The
 * assertions that must not regress live in `lib/__tests__/since-cost.test.ts`
 * and `redis-cost.test.ts`.
 */

import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** Run the measurement inside tsx so it can import the real TypeScript modules. */
const probe = `
import { FakeStore } from "./lib/__tests__/fake-store.ts";
import { createRoom, authorize, clearRegistryCache, writeAudit } from "./lib/room-registry.ts";
import { appendEntry, readEntries, getStatus } from "./lib/entries.ts";

const T0 = new Date("2026-08-24T02:00:00.000Z");
const OPS = new Set(["get","set","setex","del","incr","expire","rpush","lpush","ltrim","lrange","llen","sadd","srem","smembers"]);

function meter(store) {
  const m = { calls: 0, sent: 0, recv: 0, byOp: {} };
  const size = (v) => {
    if (v === null || v === undefined) return 0;
    if (typeof v === "string") return Buffer.byteLength(v);
    if (Array.isArray(v)) return v.reduce((n, x) => n + size(x), 0);
    return Buffer.byteLength(JSON.stringify(v));
  };
  const proxy = new Proxy(store, {
    get(t, prop, r) {
      const v = Reflect.get(t, prop, r);
      if (typeof v !== "function") return v;
      const name = String(prop);
      if (!OPS.has(name)) return v.bind(t);
      return async (...args) => {
        m.calls++;
        m.byOp[name] = (m.byOp[name] ?? 0) + 1;
        m.sent += size(args);
        const out = await v.apply(t, args);
        m.recv += size(out);
        return out;
      };
    },
  });
  return { proxy, m };
}

const results = [];
async function measure(label, fn, opts = {}) {
  clearRegistryCache();
  const store = new FakeStore();
  const setup = await opts.setup?.(store);
  const { proxy, m } = meter(store);
  await fn(proxy, setup, store);
  results.push({ label, ...m });
}

async function room(store, entries = 0, bodyLen = 400) {
  const made = await createRoom(store, { topic: "audit", ownerLabel: "A", peerLabel: "B", now: T0 });
  const a = await authorize(store, { presentedToken: made.ownerToken, now: T0 });
  const b = await authorize(store, { presentedToken: made.peerToken, now: T0 });
  let r = made.room;
  for (let i = 0; i < entries; i++) {
    await appendEntry(store, r, i % 2 ? b.token : a.token, {
      type: "note", title: "entry " + i, body: "x".repeat(bodyLen),
      checkedAgainst: "lib/store.ts:" + (i + 1),
    }, T0);
  }
  return { room: r, a: a.token, b: b.token };
}

// ── one poll on the cheap route (warm) ──
await measure("since poll (warm)", async (s, st) => {
  await authorize(s, { presentedToken: st.tok, now: T0, minimal: true, rateCeiling: 4 });
  await s.get("bridger:room:" + st.room.id + ":seq");
}, { setup: async (store) => {
  const made = await createRoom(store, { topic: "t", ownerLabel: "A", peerLabel: "B", now: T0 });
  await authorize(store, { presentedToken: made.ownerToken, now: T0, minimal: true, rateCeiling: 4 });
  return { room: made.room, tok: made.ownerToken };
}});

// ── reading a room, at three sizes ──
for (const n of [10, 100, 1000]) {
  await measure("read a room of " + n + " entries", async (s, st) => {
    await readEntries(s, st.room.id);
  }, { setup: async (store) => await room(store, n) });
}

// ── the SAME room, read INCREMENTALLY — the fix the audit produced ──
await measure("catch up on 1 new of 1000", async (s, st) => {
  await readEntries(s, st.room.id, { sinceSeq: 999, latestSeq: 1000 });
}, { setup: async (store) => await room(store, 1000) });

await measure("poll a quiet 1000-entry room", async (s, st) => {
  await readEntries(s, st.room.id, { sinceSeq: 1000, latestSeq: 1000 });
}, { setup: async (store) => await room(store, 1000) });

// ── status, which reads everything too ──
await measure("status on a 100-entry room", async (s, st) => {
  await getStatus(s, st.room, st.a);
}, { setup: async (store) => await room(store, 100) });

// ── one write ──
await measure("post one entry (400B body)", async (s, st) => {
  await appendEntry(s, st.room, st.a, { type: "note", title: "t", body: "x".repeat(400) }, T0);
}, { setup: async (store) => await room(store, 10) });

// ── audit write ──
await measure("writeAudit one row", async (s, st) => {
  await writeAudit(s, { ts: T0.toISOString(), tokenId: "abc", roomId: st.room.id, side: "a", tool: "read", status: "ok" });
}, { setup: async (store) => await room(store, 0) });

// ── storage: what a room of N entries occupies ──
const store = new FakeStore();
const big = await room(store, 1000);
let bytes = 0, keys = 0;
for (const [k, v] of store.kv) { bytes += Buffer.byteLength(k) + Buffer.byteLength(typeof v === "string" ? v : JSON.stringify(v)); keys++; }
for (const [k, list] of store.lists) { bytes += Buffer.byteLength(k) + list.reduce((n, x) => n + Buffer.byteLength(typeof x === "string" ? x : JSON.stringify(x)), 0); keys++; }
for (const [k, set] of store.sets) { bytes += Buffer.byteLength(k) + [...set].reduce((n, x) => n + Buffer.byteLength(x), 0); keys++; }

console.log(JSON.stringify({ results, storage: { keys, bytes, entries: 1000 } }));
`;

const file = join(process.cwd(), ".upstash-cost-probe.mts");
writeFileSync(file, probe);

let raw;
try {
  raw = execSync(`npx tsx "${file}"`, { encoding: "utf8", cwd: process.cwd() });
} finally {
  try { unlinkSync(file); } catch {}
}

const line = raw.trim().split("\n").filter((l) => l.startsWith("{")).pop();
if (!line) {
  console.error("The probe produced no result. Raw output:\n" + raw);
  process.exit(1);
}
const { results, storage } = JSON.parse(line);

const FREE = { commands: 500_000, storageBytes: 256 * 1024 * 1024, bandwidthBytes: 10 * 1024 * 1024 * 1024 };
const kb = (n) => (n / 1024).toFixed(1) + " KB";

console.log("\n  UPSTASH COST — measured against the real store interface\n");
console.log("  " + "operation".padEnd(32) + "cmds".padStart(6) + "sent".padStart(11) + "recv".padStart(11));
console.log("  " + "-".repeat(60));
for (const r of results) {
  console.log("  " + r.label.padEnd(32) + String(r.calls).padStart(6) + kb(r.sent).padStart(11) + kb(r.recv).padStart(11));
}

console.log("\n  STORAGE — one room, 1,000 entries with 400-byte bodies");
console.log("    keys: " + storage.keys + "   bytes: " + (storage.bytes / 1024 / 1024).toFixed(2) + " MB");
console.log("    rooms of that size that fit in 256 MB: " + Math.floor(FREE.storageBytes / storage.bytes));

const read1000 = results.find((r) => r.label.includes("1000"));
if (read1000) {
  const perRead = read1000.recv;
  console.log("\n  BANDWIDTH — the one to watch");
  console.log("    a single read of that room pulls " + (perRead / 1024 / 1024).toFixed(2) + " MB");
  console.log("    reads of that room per month before 10 GB: " + Math.floor(FREE.bandwidthBytes / perRead).toLocaleString());
  console.log("    ...and every one of them is ONE command.");
}
console.log("");
