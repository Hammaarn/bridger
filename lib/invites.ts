/**
 * ONE-TIME JOIN CODES — the paste-and-go path.
 *
 * THE REQUIREMENT (Erik, S#272): *"token paste into session enables the
 * communication between different AI's on different machines, like peer2peer."*
 * The bridge is useless if joining it costs twenty minutes of client-config
 * archaeology, and today it can: three MCP clients spell remote config three
 * different ways and one rejects the other two's keys.
 *
 * THE BASELINE THIS HAS TO BEAT. Done by hand with zero infrastructure, joining
 * is: paste one `curl` command with a bearer token. That already works. So the
 * only things worth building are the two that plain curl cannot give you —
 * the WHOLE operation set (an agent needs to know what it can do, not just how
 * to do one thing), and keeping a live credential out of a durable chat message.
 * Everything else here would be decoration.
 *
 * WHY A CODE AND NOT THE TOKEN ITSELF
 * -----------------------------------
 * A chat message is durable. It sits in Discord, in an inbox, in a transcript,
 * in a screenshot on a shared screen — and a token pasted there stays valid as
 * long as the bridge does. A code that burns on first use makes that message
 * worthless to anyone who reads it second.
 *
 * WHAT THIS DOES NOT PROTECT AGAINST, stated plainly rather than discovered
 * later: once redeemed, the token is in the far side's model context. Anything
 * that can read that context can read the token — a prompt injection arriving
 * over this very bridge included (see `lib/untrusted.ts`). That is INHERENT to
 * paste-and-go, not an oversight: an agent that calls an HTTP API needs the
 * credential in reach. The mitigations are therefore blast-radius ones, not
 * prevention:
 *
 *   - the code is single-use and short-lived, so the durable artefact is inert
 *   - the minted token EXPIRES (default 7 days), unlike an MCP-path token
 *   - it is scoped to one room and one side, and cannot speak as the other
 *   - `bridger stop` and `bridger revoke` both kill it immediately
 *
 * A partner who needs a long-lived credential should use the MCP path, where
 * the token lives in a config file the model never reads. That is the honest
 * division: **MCP for durability, paste for reach.**
 */

import { randomBytes } from "node:crypto";

import { issueToken, type RoomRecord, type SideId } from "./room-registry";
import { INVITE_KEY, coerceJson, type Store } from "./store";

/** Default life of a join code. Long enough to send, short enough to matter. */
export const INVITE_TTL_SECONDS = 30 * 60;

/** Default life of the token a code redeems into. */
export const PASTE_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Crockford-style alphabet: no I, L, O, U. A join code gets read aloud, typed
 * from a phone screen and pasted out of a chat window, so the characters that
 * are confusable in those settings are simply not in it.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface InviteRecord {
  roomId: string;
  side: SideId;
  createdAt: string;
  expiresAt: string;
  /** Life of the token this redeems into, in seconds. */
  tokenTtlSeconds: number;
}

/**
 * 12 characters from a 32-symbol alphabet = 60 bits, grouped for legibility.
 * Rejection-sampled from `randomBytes` so the distribution is uniform — a
 * modulo of 256 over 32 happens to be exact, but relying on that silently
 * breaks the day someone edits the alphabet.
 */
export function newInviteCode(): string {
  const out: string[] = [];
  while (out.length < 12) {
    for (const byte of randomBytes(16)) {
      if (byte >= 256 - (256 % ALPHABET.length)) continue; // bias guard
      out.push(ALPHABET[byte % ALPHABET.length]);
      if (out.length === 12) break;
    }
  }
  return `${out.slice(0, 4).join("")}-${out.slice(4, 8).join("")}-${out.slice(8).join("")}`;
}

export function parseInvite(raw: unknown): InviteRecord | null {
  const obj = coerceJson(raw);
  if (!obj || typeof obj !== "object") return null;
  const r = obj as Partial<InviteRecord>;
  if (typeof r.roomId !== "string") return null;
  if (r.side !== "a" && r.side !== "b") return null;
  return {
    roomId: r.roomId,
    side: r.side,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
    expiresAt: typeof r.expiresAt === "string" ? r.expiresAt : "",
    tokenTtlSeconds: Number.isFinite(r.tokenTtlSeconds)
      ? Number(r.tokenTtlSeconds)
      : PASTE_TOKEN_TTL_SECONDS,
  };
}

export async function mintInvite(
  store: Store,
  room: RoomRecord,
  side: SideId,
  now: Date,
  opts: { ttlSeconds?: number; tokenTtlSeconds?: number } = {},
): Promise<{ code: string; expiresAt: string }> {
  const ttl = opts.ttlSeconds ?? INVITE_TTL_SECONDS;
  const code = newInviteCode();
  const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
  const record: InviteRecord = {
    roomId: room.id,
    side,
    createdAt: now.toISOString(),
    expiresAt,
    tokenTtlSeconds: opts.tokenTtlSeconds ?? PASTE_TOKEN_TTL_SECONDS,
  };
  await store.set(INVITE_KEY(code), JSON.stringify(record));
  // Belt and braces: the record carries its own expiry AND the key has a TTL,
  // so a store that loses one still forgets the code.
  await store.expire(INVITE_KEY(code), ttl);
  return { code, expiresAt };
}

export type RedeemResult =
  | { ok: true; token: string; invite: InviteRecord }
  | { ok: false; reason: "unknown" | "expired" | "already-used" | "room-missing" };

/**
 * Redeem a code for a fresh token, burning the code.
 *
 * THE BURN IS THE DELETE, AND ITS RETURN VALUE IS THE LOCK. Two requests can
 * arrive with the same code; both may read the record, but `del` reports how
 * many keys it actually removed, so exactly one sees `1` and wins. Checking
 * "does the key still exist" before deleting would be the classic
 * time-of-check/time-of-use race — both would see it, both would proceed.
 *
 * The token is minted AFTER the burn is won. A failure between the two costs
 * the partner a code and no access, which is the safe direction: the other
 * ordering can hand out two tokens for one invite.
 */
export async function redeemInvite(
  store: Store,
  code: string,
  now: Date,
  loadRoom: (roomId: string) => Promise<RoomRecord | null>,
): Promise<RedeemResult> {
  const key = INVITE_KEY(code.trim());
  const invite = parseInvite(await store.get(key));
  if (!invite) return { ok: false, reason: "unknown" };

  if (invite.expiresAt && new Date(invite.expiresAt).getTime() <= now.getTime()) {
    await store.del(key);
    return { ok: false, reason: "expired" };
  }

  const removed = Number(await store.del(key));
  if (removed < 1) return { ok: false, reason: "already-used" };

  const room = await loadRoom(invite.roomId);
  if (!room) return { ok: false, reason: "room-missing" };

  const expiresAt = new Date(now.getTime() + invite.tokenTtlSeconds * 1000).toISOString();
  const token = await issueToken(store, room, invite.side, now, expiresAt);
  return { ok: true, token, invite };
}
