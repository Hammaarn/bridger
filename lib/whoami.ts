/**
 * The two payloads `/api/whoami` can return, as pure functions.
 *
 * They live here rather than inline in the route for one reason: the security
 * property of this endpoint is that EVERY failure looks the same, and a
 * property nothing asserts is a property that drifts. A route handler calls
 * `createStore()` and cannot be exercised without live credentials, so the
 * shaping is pulled out where a test can hold two different refusals side by
 * side and prove they are indistinguishable.
 */

import type { RoomRecord, TokenRecord } from "./room-registry";

/** Reasons `authorize` can refuse. Kept structural so the union stays honest. */
export type RefusalReason = string;

export interface Refusal {
  status: number;
  body: { ok: false; error: string };
}

/**
 * ONE message, ONE status, for every reason except a stopped bridge.
 *
 * Branching on the real reason would turn this endpoint into an oracle: 404 vs
 * 401 tells a prober whether a room exists, and "expired" vs "revoked" tells
 * them a token was once real. None of that helps an honest partner, who is
 * going to ask their operator for a fresh token either way.
 *
 * `bridge-disabled` is the deliberate exception, and it is not a leak: it says
 * nothing about the token. Collapsing it into the generic refusal would send a
 * partner whose token is perfectly good off to get a replacement, and the
 * replacement would fail identically — the worst possible advice.
 */
export const OPAQUE_REFUSAL =
  "This token is not usable on this bridge. It may be revoked, expired, or for a different server. " +
  "Ask whoever opened the bridge for a fresh one — retrying will not change the answer.";

export const STOPPED_REFUSAL =
  "The bridge is stopped. Your token is not the problem and a new one will not help. " +
  "The operator has paused it; retrying cannot succeed until they start it again.";

export function whoamiRefusal(reason: RefusalReason, stoppedStatus: number): Refusal {
  if (reason === "bridge-disabled") {
    return { status: stoppedStatus, body: { ok: false, error: STOPPED_REFUSAL } };
  }
  return { status: 401, body: { ok: false, error: OPAQUE_REFUSAL } };
}

export interface WhoamiBody {
  ok: true;
  room: { id: string; topic: string };
  you: {
    side: string;
    label: string;
    code: string;
    agent: string | null;
    role: string;
    canWrite: boolean;
    expiresAt: string | null;
  };
  peer: { side: string; label: string; code: string; agent: string | null; joined: boolean };
  next: string;
}

/**
 * What a VALID token is told.
 *
 * Everything here is already reachable from that caller's first real call, so
 * withholding any of it would cost an honest partner a round trip and cost an
 * attacker nothing. `next` exists because a working token that leaves the
 * caller guessing is only half an answer.
 */
export function whoamiBody(room: RoomRecord, token: TokenRecord): WhoamiBody {
  const peerSide = token.side === "a" ? "b" : "a";
  return {
    ok: true,
    room: { id: room.id, topic: room.topic },
    you: {
      side: token.side,
      label: room.sides[token.side].label,
      code: room.sides[token.side].code,
      agent: room.sides[token.side].agent ?? null,
      role: token.role,
      canWrite: token.role !== "viewer",
      expiresAt: token.expiresAt,
    },
    peer: {
      side: peerSide,
      label: room.sides[peerSide].label,
      code: room.sides[peerSide].code,
      // Self-declared by THEM, unverified by us. Carried so a reader can tell
      // two identically-named parties apart, never as a claim about who they
      // actually are.
      agent: room.sides[peerSide].agent ?? null,
      joined: room.sides[peerSide].joinedAt !== null,
    },
    next:
      token.role === "answerer"
        ? "Your token works. Call bridger_ping to see what is waiting on you."
        : "Your token works. Call bridger_status to see the record.",
  };
}
