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
 * long as the bridge does. A code that stops working shortly after it is sent
 * makes that message worthless to anyone who finds it later.
 *
 * SINGLE-MINT, NOT BURN-ON-READ — and the distinction is the whole of S#276.
 * -------------------------------------------------------------------------
 * The original design deleted the code on first read. Exactly one token could
 * ever exist, which was right, but it was bought by making the SECOND read a
 * 404 — and that is what killed the first live customer demo. the partner's agent
 * fetched the join document, got its token, fetched again (agents retry, and
 * they make confirming calls), got `not recognised`, concluded the service was
 * broken, and never used the credential it was already holding.
 *
 * Burn-on-read assumed one careful human clicking once. The real readers are
 * wider: an agent that retries, a human previewing a link before forwarding it,
 * and anything that fetches a URL merely because it appeared in a message.
 *
 * So the code now mints ONCE and stays READABLE for `INVITE_REREAD_SECONDS`.
 * Every reader in that window gets the same document and the same token. The
 * mint lock is unchanged and still the `del` return count.
 *
 * WHAT THAT COSTS, stated rather than discovered later. For the length of the
 * window the invite record holds the token in PLAINTEXT — the only live
 * credential at rest anywhere in this store, which otherwise keeps SHA hashes
 * (`hashToken`). It is a real weakening and it is bounded on purpose:
 *
 *   - the window is MINUTES, not the code's full TTL, and Redis enforces it by
 *     key expiry rather than by anything remembering to clean up
 *   - the token it exposes is scoped to one room and one side, capped at
 *     PASTE_PATH_DAILY_CAP, expiring, and revocable
 *   - an attacker who can read this store can already read every entry of every
 *     room in plaintext, so the marginal gain to them is small
 *
 * The alternative considered and rejected was deriving the token from the code
 * by HMAC, which stores no secret but adds one that breaks every join if lost
 * and forges every token if leaked. Erik's call, S#276.
 *
 * WHAT NONE OF THIS PROTECTS AGAINST: once redeemed, the token is in the far
 * side's model context. Anything that can read that context can read the token
 * — a prompt injection arriving over this very bridge included (see
 * `lib/untrusted.ts`). That is INHERENT to paste-and-go, not an oversight: an
 * agent that calls an HTTP API needs the credential in reach. The mitigations
 * are therefore blast-radius ones, not prevention:
 *
 *   - the code is short-lived, so the durable artefact goes inert quickly
 *   - the minted token EXPIRES (default 7 days), unlike an MCP-path token
 *   - it is scoped to one room and one side, and cannot speak as the other
 *   - `bridger stop` and `bridger revoke` both kill it immediately
 *
 * A partner who needs a long-lived credential should use the MCP path, where
 * the token lives in a config file the model never reads. That is the honest
 * division: **MCP for durability, paste for reach.**
 */

import { randomBytes } from "node:crypto";

import { issueToken, revokeSide, type RoomRecord, type SideId } from "./room-registry";
import {
  INVITE_KEY,
  INVITE_SPENT_KEY,
  PASTE_PATH_DAILY_CAP,
  ROOM_INVITE_KEY,
  coerceJson,
  type Store,
} from "./store";

/**
 * Default life of an UNREDEEMED join code.
 *
 * Hours, not minutes (I1 / S#283). Thirty minutes killed three invites across
 * three sessions: it was tuned for "paste it and they click now", and the real
 * flow is "message a human, wait for a human". The TOKEN this redeems into is
 * a different clock (`PASTE_TOKEN_TTL_SECONDS`) and is not lengthened here.
 */
export const INVITE_TTL_SECONDS = 4 * 60 * 60;

/** Default unredeemed-link life in minutes — the unit `opInvite` speaks. */
export const INVITE_TTL_MINUTES = INVITE_TTL_SECONDS / 60;

/** English for the join document and the HTML decision page. */
export function inviteTtlPhrase(): string {
  const hours = INVITE_TTL_SECONDS / 3600;
  if (hours === 1) return "1 hour";
  if (Number.isInteger(hours) && hours >= 1) return `${hours} hours`;
  return `${INVITE_TTL_MINUTES} minutes`;
}

/**
 * How long a code keeps returning the SAME token after its first read.
 *
 * Deliberately much shorter than `INVITE_TTL_SECONDS`, because this is the
 * window in which a plaintext credential sits in the store. It only has to
 * cover the readers that arrive in a burst: an unfurler fetches in
 * milliseconds, an agent retries in seconds, a human previews a link and pastes
 * it to their AI in a minute or two. Ten minutes covers all of them with room
 * to spare, and nothing needs the full unredeemed-link TTL.
 */
export const INVITE_REREAD_SECONDS = 10 * 60;

/**
 * How long the no-token tombstone outlives the record, so that a spent code
 * still says `already-used` instead of collapsing back into `unknown`.
 */
export const INVITE_SPENT_TTL_SECONDS = 24 * 60 * 60;

/** Default life of the token a code redeems into. */
export const PASTE_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * THE AUDIENCE SPLIT ON GET /j/[code].
 *
 * A browser sends `Accept: text/html`. Curl, fetch, and every agent client do
 * not. HTML is a decision page and must not mint; anything else is the protocol
 * document and does. The route checks this BEFORE `redeemInvite`.
 */
export function joinAcceptIsHtml(accept: string | null): boolean {
  return (accept ?? "").includes("text/html");
}

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
  /**
   * The minted token, in PLAINTEXT, present only between the first read and the
   * end of the re-read window. Absent means "not yet redeemed" — the two states
   * are distinguished by this field and nothing else.
   */
  token?: string;
  redeemedAt?: string;
  /**
   * When re-reading stops. Belt and braces with the key's own TTL: a store that
   * loses the expiry must still refuse, so the record carries its own deadline
   * and `redeemInvite` checks it. Same pattern as `mintInvite`.
   */
  reReadableUntil?: string;
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
    // A record written before S#276 has none of these, and reads as
    // not-yet-redeemed — which is exactly what it is.
    ...(typeof r.token === "string" && r.token ? { token: r.token } : {}),
    ...(typeof r.redeemedAt === "string" ? { redeemedAt: r.redeemedAt } : {}),
    ...(typeof r.reReadableUntil === "string"
      ? { reReadableUntil: r.reReadableUntil }
      : {}),
  };
}

/**
 * Mint an invite that REPLACES whatever unredeemed one that side already had.
 *
 * The CLI never needed this: an operator running `bridger invite` twice knows
 * they did it and knows which line they pasted. A button does not have that
 * property -- it gets pressed twice because nothing visible happened the first
 * time, and then two codes are live for one seat and the operator cannot tell
 * which of them they sent. Each of those codes is a separate credential waiting
 * to be minted, so this is a blast-radius question as much as a UX one.
 *
 * ORDER MATTERS. The old code is deleted BEFORE the new one is written, so a
 * failure between the two leaves zero live invites rather than two. Losing an
 * invite costs one button press; a second live credential for a seat you
 * thought you had re-issued is the failure you cannot see.
 *
 * A code that has already been REDEEMED is deliberately not touched. It is
 * inside its re-read window and the far side may still be fetching it -- the
 * exact retry that killed the first partner demo. Superseding only replaces an
 * invitation nobody has taken up.
 */
export async function mintInviteReplacing(
  store: Store,
  room: RoomRecord,
  side: SideId,
  now: Date,
  opts: { ttlSeconds?: number; tokenTtlSeconds?: number } = {},
): Promise<{ code: string; expiresAt: string; replaced: boolean }> {
  const pointer = ROOM_INVITE_KEY(room.id, side);
  const previous = await store.get(pointer);
  let replaced = false;

  if (typeof previous === "string" && previous) {
    const old = parseInvite(await store.get(INVITE_KEY(previous)));
    // Untouched if it has been redeemed: someone may be re-reading it right now.
    if (old && !old.token) {
      await store.del(INVITE_KEY(previous));
      replaced = true;
    }
  }

  const ttl = opts.ttlSeconds ?? INVITE_TTL_SECONDS;
  const minted = await mintInvite(store, room, side, now, opts);
  await store.set(pointer, minted.code);
  // The pointer must never outlive what it points at.
  await store.expire(pointer, ttl);
  return { ...minted, replaced };
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
  | {
      ok: true;
      token: string;
      invite: InviteRecord;
      /**
       * True when this read did NOT mint — the token already existed and is
       * being handed back inside the re-read window. The join document says
       * something different in that case, because telling a reader "here is
       * your new token" twice would be a lie about which credential is live.
       */
      reused: boolean;
    }
  | {
      ok: false;
      reason:
        | "unknown"
        | "expired"
        | "already-used"
        | "room-missing"
        | "mint-in-progress";
    };

/** Record the code as spent, WITHOUT the token. Outlives the re-read window. */
async function markSpent(store: Store, code: string, now: Date): Promise<void> {
  const key = INVITE_SPENT_KEY(code);
  await store.set(key, JSON.stringify({ redeemedAt: now.toISOString() }));
  await store.expire(key, INVITE_SPENT_TTL_SECONDS);
}

/**
 * Redeem a code for a token — minting at most once, and returning the SAME
 * token to every reader inside the re-read window.
 *
 * THE MINT LOCK IS THE DELETE, AND ITS RETURN VALUE IS THE LOCK. Unchanged from
 * S#272 and deliberately so: two requests can arrive with the same code, both
 * may read the record, but `del` reports how many keys it actually removed, so
 * exactly one sees `1` and wins the right to mint. Checking "does the key still
 * exist" before deleting would be the classic time-of-check/time-of-use race —
 * both would see it, both would proceed, two tokens for one invite.
 *
 * WHAT CHANGED IN S#276 is only what happens AFTER the win: the winner puts the
 * record back with the token on it and a short TTL, instead of leaving a hole.
 * The loser of the race re-reads and finds that record — so a concurrent second
 * caller now gets the token rather than a refusal, which is the behaviour an
 * agent's retry actually needs.
 *
 * The token is still minted AFTER the lock is won. A failure between the two
 * costs the partner a code and no access, which is the safe direction: the
 * other ordering can hand out two tokens for one invite.
 */
export async function redeemInvite(
  store: Store,
  code: string,
  now: Date,
  loadRoom: (roomId: string) => Promise<RoomRecord | null>,
): Promise<RedeemResult> {
  const trimmed = code.trim();
  const key = INVITE_KEY(trimmed);
  const invite = parseInvite(await store.get(key));

  if (!invite) {
    // Nothing live. The tombstone is the only thing that can separate "you
    // already used this" from "that is not a code", and separating them is the
    // difference between asking for a fresh link and hunting a typo that does
    // not exist.
    const spent = await store.get(INVITE_SPENT_KEY(trimmed));
    return { ok: false, reason: spent ? "already-used" : "unknown" };
  }

  // ── Already redeemed, inside the window: hand back the same token ──────────
  if (invite.token) {
    const until = invite.reReadableUntil
      ? new Date(invite.reReadableUntil).getTime()
      : 0;
    if (until <= now.getTime()) {
      // The key's TTL should have removed this already; if we can still read
      // it, the store lost the expiry. Refuse on the record's own deadline and
      // clear the plaintext now rather than trusting the next reader to.
      await store.del(key);
      await markSpent(store, trimmed, now);
      return { ok: false, reason: "already-used" };
    }
    const room = await loadRoom(invite.roomId);
    if (!room) return { ok: false, reason: "room-missing" };
    return { ok: true, token: invite.token, invite, reused: true };
  }

  // ── Not yet redeemed ──────────────────────────────────────────────────────
  if (invite.expiresAt && new Date(invite.expiresAt).getTime() <= now.getTime()) {
    await store.del(key);
    return { ok: false, reason: "expired" };
  }

  const removed = Number(await store.del(key));
  if (removed < 1) {
    // Someone else won the mint and is writing the record back with the token
    // on it. That is a millisecond of flight time, not a failure — re-read
    // before deciding anything.
    const again = parseInvite(await store.get(key));
    if (again?.token) {
      const room = await loadRoom(again.roomId);
      if (!room) return { ok: false, reason: "room-missing" };
      return { ok: true, token: again.token, invite: again, reused: true };
    }
    // Genuinely mid-flight. This is the one place a retry is the right advice,
    // so it gets its own reason rather than borrowing a terminal one.
    return { ok: false, reason: "mint-in-progress" };
  }

  const room = await loadRoom(invite.roomId);
  if (!room) {
    await markSpent(store, trimmed, now);
    return { ok: false, reason: "room-missing" };
  }

  const expiresAt = new Date(now.getTime() + invite.tokenTtlSeconds * 1000).toISOString();
  // ONE LIVE CREDENTIAL PER SEAT. createRoom already minted a participant
  // token for this side (the mint-screen `slots[1]` / CLI peer token). A second
  // issueToken here left both live, so two agents on the same join URL — and
  // the operator holding the create-time paste block — all wrote as one seat
  // while wait looked for the other. Rotate first: the link is the door, the
  // create-time token is what it replaces. Re-reads do not reach this branch.
  await revokeSide(store, room, invite.side, "participant");
  // Half the MCP daily cap: this token reaches a model's context, so it is the
  // one that can leak. See PASTE_PATH_DAILY_CAP.
  const token = await issueToken(
    store,
    room,
    invite.side,
    now,
    expiresAt,
    "participant",
    PASTE_PATH_DAILY_CAP,
  );

  const redeemed: InviteRecord = {
    ...invite,
    token,
    redeemedAt: now.toISOString(),
    reReadableUntil: new Date(now.getTime() + INVITE_REREAD_SECONDS * 1000).toISOString(),
  };
  await store.set(key, JSON.stringify(redeemed));
  await store.expire(key, INVITE_REREAD_SECONDS);
  await markSpent(store, trimmed, now);

  return { ok: true, token, invite: redeemed, reused: false };
}
