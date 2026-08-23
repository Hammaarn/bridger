/**
 * In-memory Store for tests.
 *
 * Deliberately supports FAILING on demand (`failFrom`), because the properties
 * most worth testing in the registry are the failure ones: fail-closed on an
 * unreadable registry, and a bounded stale-read grace that a revocation still
 * outlives. A fake that can only succeed cannot test either.
 */

import type { Store } from "../store";

export class FakeStore implements Store {
  readonly kv = new Map<string, unknown>();
  readonly lists = new Map<string, unknown[]>();
  readonly sets = new Map<string, Set<string>>();
  readonly expires = new Map<string, number>();

  /** When set, every op whose key matches this predicate throws. */
  failWhen: ((key: string) => boolean) | null = null;

  private guard(key: string) {
    if (this.failWhen?.(key)) throw new Error(`fake-store: forced failure on ${key}`);
  }

  /** Make every operation throw — a total outage. */
  failAll() {
    this.failWhen = () => true;
  }

  healAll() {
    this.failWhen = null;
  }

  async get(key: string) {
    this.guard(key);
    return this.kv.get(key) ?? null;
  }

  async set(key: string, value: unknown) {
    this.guard(key);
    this.kv.set(key, value);
    // A plain SET clears any TTL in Redis. Mirrored here so a test can catch a
    // `set` that was supposed to be a `setex` -- otherwise the fake would be
    // more forgiving than production, which is the wrong direction for a fake.
    this.expires.delete(key);
    return "OK";
  }

  async setex(key: string, seconds: number, value: unknown) {
    this.guard(key);
    this.kv.set(key, value);
    this.expires.set(key, seconds);
    return "OK";
  }

  /** Test-only: the TTL currently recorded for a key, or undefined. */
  ttlOf(key: string) {
    return this.expires.get(key);
  }

  async del(...keys: string[]) {
    // Must match the `Store` contract and Redis: the count REMOVED.
    let removed = 0;
    for (const k of keys) {
      this.guard(k);
      if (this.kv.delete(k) || this.lists.delete(k) || this.sets.delete(k)) removed++;
    }
    return removed;
  }

  async incr(key: string) {
    this.guard(key);
    const next = Number(this.kv.get(key) ?? 0) + 1;
    this.kv.set(key, next);
    return next;
  }

  async expire(key: string, seconds: number) {
    this.guard(key);
    this.expires.set(key, seconds);
    return 1;
  }

  async rpush(key: string, ...values: unknown[]) {
    this.guard(key);
    const list = this.lists.get(key) ?? [];
    list.push(...values);
    this.lists.set(key, list);
    return list.length;
  }

  async lpush(key: string, ...values: unknown[]) {
    this.guard(key);
    const list = this.lists.get(key) ?? [];
    list.unshift(...values);
    this.lists.set(key, list);
    return list.length;
  }

  async ltrim(key: string, start: number, stop: number) {
    this.guard(key);
    const list = this.lists.get(key) ?? [];
    const end = stop < 0 ? list.length + stop + 1 : stop + 1;
    this.lists.set(key, list.slice(start, end));
    return "OK";
  }

  async lrange(key: string, start: number, stop: number) {
    this.guard(key);
    const list = this.lists.get(key) ?? [];
    const end = stop < 0 ? list.length + stop + 1 : stop + 1;
    return list.slice(start, end);
  }

  async llen(key: string) {
    this.guard(key);
    return (this.lists.get(key) ?? []).length;
  }

  async sadd(key: string, ...members: string[]) {
    this.guard(key);
    const set = this.sets.get(key) ?? new Set<string>();
    for (const m of members) set.add(m);
    this.sets.set(key, set);
    return members.length;
  }

  async srem(key: string, ...members: string[]) {
    this.guard(key);
    const set = this.sets.get(key);
    for (const m of members) set?.delete(m);
    return members.length;
  }

  async smembers(key: string) {
    this.guard(key);
    return [...(this.sets.get(key) ?? [])];
  }
}

/** Fixed clock helpers — never mix `Date.now()` with fixture dates in a test. */
export const T0 = new Date("2026-08-11T10:00:00.000Z");
export const plus = (base: Date, ms: number) => new Date(base.getTime() + ms);
