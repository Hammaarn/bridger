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
 * So every read now checks the file's mtime and reloads if another process has
 * written since. One `statSync` per read is nothing on a local disk, and it
 * makes cross-process revocation actually take effect. This does not make the
 * file store safe for concurrent *writers* — two processes writing still race,
 * and that is still why the hosted path uses Redis.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Store } from "./store";

interface Snapshot {
  kv: Record<string, unknown>;
  lists: Record<string, unknown[]>;
  sets: Record<string, string[]>;
}

export class FileStore implements Store {
  private kv = new Map<string, unknown>();
  private lists = new Map<string, unknown[]>();
  private sets = new Map<string, Set<string>>();
  private flushing: Promise<void> = Promise.resolve();
  /** mtime (ms) of the last snapshot this process read or wrote. */
  private seenMtimeMs = 0;

  constructor(private readonly path: string) {
    this.load();
  }

  /**
   * Reload if another process has written since we last looked.
   *
   * Called before every read. This is what makes `bridger revoke` — run from a
   * separate CLI process — actually take effect on a running server.
   */
  private refresh() {
    try {
      const mtime = statSync(this.path).mtimeMs;
      if (mtime !== this.seenMtimeMs) this.load();
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
      this.seenMtimeMs = statSync(this.path).mtimeMs;
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
        this.seenMtimeMs = statSync(this.path).mtimeMs;
      } catch {
        /* the next refresh will simply reload */
      }
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
    for (const k of keys) {
      this.kv.delete(k);
      this.lists.delete(k);
      this.sets.delete(k);
    }
    await this.flush();
    return keys.length;
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
