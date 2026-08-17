/**
 * A file-backed Store — local bridges with no database at all.
 *
 * WHY THIS EXISTS
 * ---------------
 * The hosted case (two companies, two machines) needs a shared server and
 * therefore Redis. The *local* case does not: two sessions open on one machine
 * — Claude in one repo and Claude or Gemini in another — share a filesystem
 * already. Requiring Upstash to bridge two windows on the same laptop is
 * infrastructure for its own sake.
 *
 * It also removes the one thing blocking end-to-end verification: with this,
 * a real ask/answer round trip can be run today, on a laptop, with no account
 * anywhere.
 *
 * OPT-IN ONLY — NEVER A FALLBACK
 * ------------------------------
 * `createStore()` returns this ONLY when `BRIDGER_STORE=file` is set
 * explicitly. It is deliberately not a fallback for missing Upstash
 * credentials, because a hosted deploy that silently degraded to per-instance
 * local files would look healthy while every serverless instance kept its own
 * private, disappearing copy of the ledger. Missing credentials must keep
 * failing closed.
 *
 * For that same reason, asking for it on Vercel is a hard error rather than a
 * warning: serverless filesystems are ephemeral and per-instance, so a file
 * store there is not a degraded bridge, it is a broken one.
 *
 * CONCURRENCY, AND THE BUG THAT TAUGHT IT
 * ---------------------------------------
 * State lives in memory and is flushed to one JSON file. Node runs JS on a
 * single thread, so a read-modify-write between awaits cannot interleave;
 * flushes are chained through one promise so two concurrent requests cannot
 * interleave their writes to disk either.
 *
 * The first version stopped there, with a comment saying it was "not safe
 * across processes". That comment was true and badly under-sold the
 * consequence. The operator CLI is a *separate process*: `bridger revoke` wrote
 * `active: false` to the file, reported success — and the running server, whose
 * in-memory copy was loaded at startup and never re-read, kept serving the
 * revoked token. **A revocation that reports success and does nothing is worse
 * than one that fails loudly.** Found by running the control (revoked token
 * must 401 where a live one 200s), not by reading the code.
 *
 * So every read checks the file before trusting its own snapshot. The FIRST
 * version of that check was `mtime !== seenMtimeMs`, and it was pointed
 * slightly wrong: filesystem timestamps are coarse, so another process's write
 * can land on the value we already hold, and then the reload never happens —
 * permanently, because nothing moves the mtime again. The optimisation added to
 * make revocation work reintroduced the exact failure it was fixing. See
 * `refresh()` for the three-signal replacement.
 *
 * This does not make the file store safe for concurrent *writers* — two
 * processes writing still race, and that is still why the hosted path uses
 * Redis.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Store } from "./store";

interface Snapshot {
  kv: Record<string, unknown>;
  lists: Record<string, unknown[]>;
  sets: Record<string, string[]>;
}

/**
 * How long after a write the file's mtime is treated as UNTRUSTWORTHY.
 *
 * Filesystem timestamp resolution is coarse — coarse enough that two operations
 * milliseconds apart routinely share one value. Inside this window we reload
 * unconditionally instead of believing an equality check. Outside it, any new
 * write necessarily moves the mtime to a different value, so the cheap
 * comparison is sound again.
 */
const MTIME_TRUST_DELAY_MS = 2000;

export class FileStore implements Store {
  private kv = new Map<string, unknown>();
  private lists = new Map<string, unknown[]>();
  private sets = new Map<string, Set<string>>();
  private flushing: Promise<void> = Promise.resolve();
  /** mtime (ms) of the last snapshot this process read or wrote. */
  private seenMtimeMs = 0;
  /** Size of that snapshot. A second signal, because mtime alone lies. */
  private seenSize = -1;
  /** Mutations not yet on disk. While >0 our memory is ahead of the file. */
  private pendingWrites = 0;

  constructor(private readonly path: string) {
    this.load();
  }

  /**
   * Reload if another process may have written since we last looked.
   *
   * Called before every read. This is what makes `bridger revoke` — run from a
   * separate CLI process — actually take effect on a running server.
   *
   * THE BUG THIS REPLACED, because the first fix was pointed slightly wrong.
   * The original test was `mtime !== this.seenMtimeMs`, and mtime equality is
   * not a reliable "unchanged" signal: if another process's write lands in the
   * same filesystem timestamp tick as our last read, the two values match and
   * the reload is skipped. Worse than a narrow race — **the miss is permanent**,
   * because nothing moves the mtime again afterwards, so the revoked token
   * keeps working indefinitely. That is precisely the failure this mechanism
   * exists to prevent ("a revocation that reports success and does nothing"),
   * reintroduced by the optimisation added to prevent it.
   *
   * Found because `file-store.test.ts`'s cross-process revocation case failed
   * roughly four runs in six. A flaky test on a security property is not noise.
   *
   * Three signals now, cheapest first: mtime differs, size differs, or the file
   * is young enough that its timestamp cannot be trusted at all.
   */
  private refresh() {
    // Our own unflushed mutations outrank the file. Without this, reloading
    // inside the trust window could roll back a write that has not landed yet.
    if (this.pendingWrites > 0) return;
    try {
      const st = statSync(this.path);
      const changed = st.mtimeMs !== this.seenMtimeMs || st.size !== this.seenSize;
      const timestampUntrustworthy = Date.now() - st.mtimeMs < MTIME_TRUST_DELAY_MS;
      if (changed || timestampUntrustworthy) this.load();
    } catch {
      // No file yet, or it vanished. Keep serving what we have; the next write
      // recreates it.
    }
  }

  private load() {
    if (!existsSync(this.path)) return;
    try {
      const snap = JSON.parse(readFileSync(this.path, "utf8")) as Snapshot;
      this.kv = new Map(Object.entries(snap.kv ?? {}));
      this.lists = new Map(Object.entries(snap.lists ?? {}));
      this.sets = new Map(Object.entries(snap.sets ?? {}).map(([k, v]) => [k, new Set(v)]));
      const st = statSync(this.path);
      this.seenMtimeMs = st.mtimeMs;
      this.seenSize = st.size;
    } catch {
      // A corrupt file must not take the bridge down silently on the next
      // write — start empty, and let the atomic flush below replace it.
      this.kv.clear();
      this.lists.clear();
      this.sets.clear();
    }
  }

  /**
   * Write via temp-file + rename so a crash mid-write cannot leave a truncated
   * ledger behind. Same discipline as the librarian index: build to temp, swap
   * atomically, never write in place.
   */
  private flush(): Promise<void> {
    // Marked synchronously, before the chained body runs: `refresh()` must know
    // our memory is ahead of the file from the moment the mutation happened,
    // not from whenever the flush gets its turn.
    this.pendingWrites++;
    this.flushing = this.flushing.then(async () => {
      const snap: Snapshot = {
        kv: Object.fromEntries(this.kv),
        lists: Object.fromEntries(this.lists),
        sets: Object.fromEntries([...this.sets].map(([k, v]) => [k, [...v]])),
      };
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(snap, null, 2), "utf8");
      renameSync(tmp, this.path);
      // Record our own write so the next read does not treat it as someone
      // else's and reload state we already hold.
      try {
        const st = statSync(this.path);
        this.seenMtimeMs = st.mtimeMs;
        this.seenSize = st.size;
      } catch {
        /* the next refresh will simply reload */
      }
    }).finally(() => {
      this.pendingWrites--;
    });
    return this.flushing;
  }

  async get(key: string) {
    this.refresh();
    return this.kv.get(key) ?? null;
  }

  async set(key: string, value: unknown) {
    this.kv.set(key, value);
    await this.flush();
    return "OK";
  }

  async del(...keys: string[]) {
    // Count what was REMOVED, not what was requested. See the `Store` contract:
    // `redeemInvite` treats this number as a lock, so returning `keys.length`
    // would let two callers both "win" the mint lock on a join code.
    this.refresh();
    let removed = 0;
    for (const k of keys) {
      if (this.kv.delete(k) || this.lists.delete(k) || this.sets.delete(k)) removed++;
    }
    await this.flush();
    return removed;
  }

  async incr(key: string) {
    const next = Number(this.kv.get(key) ?? 0) + 1;
    this.kv.set(key, next);
    await this.flush();
    return next;
  }

  /**
   * No-op, and deliberately so.
   *
   * TTL exists to bound what a shared server retains. A local file belongs to
   * the person whose disk it is on — expiring their own record out from under
   * them would be a surprise, not a feature. Deleting the data directory is
   * the local equivalent, and it is theirs to run.
   */
  async expire(_key: string, _seconds: number) {
    return 1;
  }

  async rpush(key: string, ...values: unknown[]) {
    const list = this.lists.get(key) ?? [];
    list.push(...values);
    this.lists.set(key, list);
    await this.flush();
    return list.length;
  }

  async lpush(key: string, ...values: unknown[]) {
    const list = this.lists.get(key) ?? [];
    list.unshift(...values);
    this.lists.set(key, list);
    await this.flush();
    return list.length;
  }

  async ltrim(key: string, start: number, stop: number) {
    const list = this.lists.get(key) ?? [];
    const end = stop < 0 ? list.length + stop + 1 : stop + 1;
    const from = start < 0 ? Math.max(0, list.length + start) : start;
    this.lists.set(key, list.slice(from, end));
    await this.flush();
    return "OK";
  }

  async lrange(key: string, start: number, stop: number) {
    this.refresh();
    const list = this.lists.get(key) ?? [];
    const end = stop < 0 ? list.length + stop + 1 : stop + 1;
    const from = start < 0 ? Math.max(0, list.length + start) : start;
    return list.slice(from, end);
  }

  async llen(key: string) {
    this.refresh();
    return (this.lists.get(key) ?? []).length;
  }

  async sadd(key: string, ...members: string[]) {
    const set = this.sets.get(key) ?? new Set<string>();
    for (const m of members) set.add(m);
    this.sets.set(key, set);
    await this.flush();
    return members.length;
  }

  async srem(key: string, ...members: string[]) {
    const set = this.sets.get(key);
    for (const m of members) set?.delete(m);
    await this.flush();
    return members.length;
  }

  async smembers(key: string) {
    this.refresh();
    return [...(this.sets.get(key) ?? [])];
  }
}

/** One instance per process, so the in-memory state is genuinely shared. */
let singleton: FileStore | null = null;

export function createFileStore(): FileStore {
  if (process.env.VERCEL) {
    throw new Error(
      "BRIDGER_STORE=file cannot be used on Vercel: serverless filesystems are " +
        "ephemeral and per-instance, so each instance would keep its own " +
        "disappearing copy of the ledger. Configure Upstash for hosted bridges.",
    );
  }
  if (!singleton) {
    singleton = new FileStore(resolve(process.env.BRIDGER_DATA_DIR ?? ".bridger-data", "bridge.json"));
  }
  return singleton;
}
