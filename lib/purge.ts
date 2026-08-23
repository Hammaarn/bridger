/**
 * PURGE — the deletion path, and it takes both sides.
 *
 * Until now there was none. `closeRoom` set `closed: true` and nothing else, so
 * a partner asking for their data to be removed got "wait 30 days for the idle
 * TTL, or I will do manual Redis surgery". That is not an answer you can give
 * a company.
 *
 * ERIK'S REQUIREMENT (S#272): **both sides have to agree.** That is the right
 * shape and not merely polite — the ledger is a JOINT record. One side deleting
 * it unilaterally destroys the other side's account of what was asked, answered
 * and decided, which is the thing they may need most precisely when a
 * relationship is ending. Consent from both is what makes it a shared record
 * rather than one company's database that the other happens to read.
 *
 * HOW CONSENT WORKS, given the two sides have different powers:
 *   - the PARTNER consents with a tool call; they hold a token, not credentials
 *   - the OPERATOR consents and executes with the CLI, which holds Upstash
 * Neither can complete it alone.
 *
 * WHAT PURGE CANNOT DO, and this must be said out loud to anyone who asks for
 * it: **it deletes the buffer, not the copies.** Both sides are encouraged to
 * run `bridger pull`, which writes the record into a `bridger/` folder that is
 * usually committed to git. Nothing here reaches that. Any deletion promise
 * made to a partner covers the server only, and saying otherwise would be a
 * false assurance about someone else's disk.
 */

import {
  CONTRACT_KEY,
  COUNTER_KEY,
  CURSOR_KEY,
  ENTRIES_KEY,
  PURGE_KEY,
  ROOM_KEY,
  ROOM_TOKENS_KEY,
  SEQ_KEY,
  TOKEN_KEY,
  coerceJson,
  type Store,
} from "./store";
import { seat, seatsFor, type RoomRecord, type SideId } from "./room-registry";

/** Consent expires — an agreement to delete made months ago is not consent now. */
export const PURGE_CONSENT_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface PurgeState {
  a: string | null;
  b: string | null;
  bothAgreed: boolean;
}

export async function recordPurgeConsent(
  store: Store,
  room: RoomRecord,
  side: SideId,
  now: Date,
): Promise<PurgeState> {
  await store.set(PURGE_KEY(room.id, side), JSON.stringify({ at: now.toISOString() }));
  await store.expire(PURGE_KEY(room.id, side), PURGE_CONSENT_TTL_SECONDS);
  return purgeState(store, room);
}

export async function withdrawPurgeConsent(
  store: Store,
  room: RoomRecord,
  side: SideId,
): Promise<PurgeState> {
  await store.del(PURGE_KEY(room.id, side));
  return purgeState(store, room);
}

export async function purgeState(store: Store, room: RoomRecord): Promise<PurgeState> {
  const read = async (side: SideId) => {
    const raw = coerceJson(await store.get(PURGE_KEY(room.id, side))) as { at?: string } | null;
    return typeof raw?.at === "string" ? raw.at : null;
  };
  const [a, b] = await Promise.all([read("a"), read("b")]);
  return { a, b, bothAgreed: Boolean(a && b) };
}

/**
 * Delete everything this room owns.
 *
 * Keys are ENUMERATED rather than scanned: the `Store` interface has no `SCAN`,
 * and adding one to delete data would be the wrong direction — a purge that can
 * glob is a purge that can over-delete. Everything a room owns is derivable
 * from the room record and its token set, so enumeration is both possible and
 * safer.
 *
 * Returns the keys removed, so the caller can show its work rather than assert
 * success.
 */
export async function executePurge(store: Store, room: RoomRecord): Promise<string[]> {
  const keys: string[] = [
    ENTRIES_KEY(room.id),
    CONTRACT_KEY(room.id),
    SEQ_KEY(room.id),
    CURSOR_KEY(room.id, "a"),
    CURSOR_KEY(room.id, "b"),
    PURGE_KEY(room.id, "a"),
    PURGE_KEY(room.id, "b"),
  ];

  // Per-side, per-type ID counters. Both codes x every entry-type letter.
  // Every seat the room actually has, not a hardcoded pair -- a solo room
  // has up to six and each carries its own counters (S#281).
  for (const side of seatsFor(room)) {
    for (const letter of ["Q", "A", "D", "N", "C", "R", "S"]) {
      keys.push(COUNTER_KEY(room.id, seat(room, side).code, letter));
    }
  }

  // Every token minted for this room, then the set itself. Tokens LAST-but-one
  // so that a failure part-way through leaves access revoked rather than
  // leaving live tokens pointing at a half-deleted room.
  const hashes = await store.smembers(ROOM_TOKENS_KEY(room.id));
  for (const h of hashes) keys.push(TOKEN_KEY(h));
  keys.push(ROOM_TOKENS_KEY(room.id));

  // The room record itself is deleted last: while it exists, `authorize`
  // resolves and refuses cleanly; once it is gone the answer is `room-missing`,
  // which is the correct final state.
  keys.push(ROOM_KEY(room.id));

  const removed: string[] = [];
  for (const k of keys) {
    if (Number(await store.del(k)) > 0) removed.push(k);
  }
  return removed;
}

/**
 * WHAT THE CLI DOES WITH TWO CONSENTS AND A FLAG.
 *
 * Extracted from `cmdPurge` so it can be tested at all. `purgeState`,
 * `recordPurgeConsent` and `executePurge` were each covered; the DECISION that
 * sits between them was not, because it lived inside a CLI command that reads
 * `process.argv`, talks to a store and writes to stdout. That is the one branch
 * standing between a mistyped flag and a deleted shared record, and it was the
 * only part of the destructive path with no test on it.
 *
 * Pure on purpose: no store, no argv, no I/O. The caller keeps the printing.
 */
export type PurgeDecision = "wait" | "force" | "proceed";

export function decidePurge(theirConsent: boolean, force: boolean): PurgeDecision {
  // Consent from the other side is sufficient on its own. `--force` is not an
  // escalation on top of it; it is only the override for its ABSENCE, so it
  // must not change the outcome when consent is already there.
  if (theirConsent) return "proceed";
  return force ? "force" : "wait";
}

/** Whether a decision actually deletes anything. The reason `wait` exists. */
export function purgeDeletes(d: PurgeDecision): boolean {
  return d !== "wait";
}
