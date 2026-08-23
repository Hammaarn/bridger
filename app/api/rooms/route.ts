/**
 * OPEN A ROOM FROM A BROWSER — the public mint.
 *
 * Until now a room could only be opened by someone holding
 * `UPSTASH_REDIS_REST_*`, which answered "who may create" by accident rather
 * than by design. Erik's call (S#275): *"Anyone. The room is the platform and
 * the tokens generated from that room are the connectors you paste into the
 * session you are having with your AI of choice."* A create button behind a
 * login is not a platform, so there is no login.
 *
 * FOUR THINGS GUARD IT, and none of them is authentication:
 *
 *  1. `chargeMint` — 3 rooms/day per address bucket, charged atomically BEFORE
 *     anything is created. A cost-of-abuse measure, not a boundary; a VPN
 *     defeats it and `lib/mint-limit.ts` says so out loud.
 *  2. `sanitiseRoomMetadata`, inside `createRoom` — the topic and both labels
 *     are now strings a stranger picks and our model reads. See
 *     `lib/room-text.ts`.
 *  3. `UNCLAIMED_ROOM_TTL_SECONDS` — the cheap half, and the one that actually
 *     scales. A room nobody joins evaporates in two hours instead of squatting
 *     Upstash for thirty days. The quota bounds how fast junk arrives; this
 *     bounds how long it stays.
 *  4. The KILL SWITCH, checked explicitly here. Every other route inherits it
 *     from `authorize()`, which this route never calls because there is no
 *     token to authorise yet. Without this check `bridger stop` would refuse
 *     every existing room while cheerfully minting new ones — the panic button
 *     failing open on the one path that creates work.
 *
 * WHY THE RESPONSE HANDS BACK EVERY TOKEN AT ONCE. This is the "small box with
 * collectable tokens" from Erik's sketch: the operator is a human at a browser
 * who will paste one into a Claude Code session and another into Antigravity.
 * They are shown once and only their hashes are stored, exactly as the CLI
 * does it — `rotate` is the recovery path, not a lookup.
 */

import { gate, refusalResponse } from "@/lib/http-gate";
import { canWrite, clearRegistryCache, createRoom, issueToken, writeAudit,
  seat,
  createSoloRoom,
  MIN_SEATS,
  MAX_SOLO_SEATS,
} from "@/lib/room-registry";
import {
  MAX_LABEL,
  MAX_TOPIC,
  RoomTextRejected,
  sanitiseRoomMetadata,
  sanitiseRoomText,
} from "@/lib/room-text";
import {
  UNCLAIMED_ROOM_TTL_SECONDS,
  chargeMint,
  peekMint,
  nextUtcMidnight,
} from "@/lib/mint-limit";
import { KILL_SWITCH, ROOM_KEY, ROOM_TTL_SECONDS, createStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A `trust` room connects exactly two parties, and that is a PROPERTY OF THE
 * PRODUCT rather than a limitation of the code (S#281).
 *
 * It used to be both. Sides were `"a" | "b"` throughout the registry, so the
 * refusal here could honestly say "N parties is a rewrite of that core". Solo
 * mode did that rewrite: seats are now `a`..`f` and `otherSeats()` returns a
 * list. What did NOT change is what a trust room MEANS -- two companies who do
 * not share an employer, keeping a record neither can rewrite. A third company
 * in that room is a different product with unanswered semantics (does an answer
 * close a question for everyone? who does a contract bind?), so this refusal
 * stays and now points at the thing that DOES seat more.
 */
const SUPPORTED_SLOTS = 2;

const bad = (message: string, field?: string) =>
  Response.json({ error: message, code: "invalid-request", ...(field ? { field } : {}) }, { status: 400 });

/**
 * Reject a cross-origin browser POST.
 *
 * There is no cookie or session here, so this is not classic CSRF — an attacker
 * forcing a victim's browser to mint gains nothing except spending the VICTIM's
 * daily quota. That is still worth closing, and it costs one comparison.
 * A missing `Origin` (curl, a server-side caller, the CLI) is allowed: the
 * header is a browser artefact, and requiring it would break every non-browser
 * client to defend against a browser-only attack.
 */
function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}

/**
 * A8. WHERE YOU STAND, BEFORE YOU TRY.
 *
 * The create screen asked for a room and found out about the daily cap only by
 * being refused. The server has always known: `MintVerdict` carries `used`,
 * `limit` and `resetsAt`, and nothing ever read them except the refusal.
 *
 * Deliberately unauthenticated, and deliberately not a leak: it reports the
 * caller's OWN bucket back to the caller, which is a number they can already
 * discover by opening rooms until one is refused. What it changes is the cost
 * of discovering it.
 */
export async function GET(req: Request) {
  const now = new Date();
  const store = createStore();
  if (!store) {
    return Response.json({ error: "The registry is unreachable." }, { status: 503 });
  }
  const verdict = await peekMint(store, req, now);
  return Response.json(
    {
      rooms: {
        usedToday: verdict.used,
        limit: verdict.limit,
        remaining: verdict.limit === null ? null : Math.max(0, verdict.limit - verdict.used),
        resetsAt: verdict.ok ? nextUtcMidnight(now) : verdict.resetsAt,
        // `limit: null` is the admin case, and "unlimited" and "zero left" must
        // never render the same on the screen that consumes this.
        unlimited: verdict.limit === null,
      },
      note:
        verdict.limit === null
          ? "No cap applies to this connection."
          : `Rooms are counted per connection per UTC day. Opening one that nobody joins costs a slot, and an abandoned room releases nothing back.`,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const now = new Date();
  const store = createStore();
  if (!store) {
    return Response.json(
      { error: "This bridge cannot reach its registry right now.", code: "registry-unreachable" },
      { status: 503 },
    );
  }

  if (!originAllowed(req)) {
    return Response.json({ error: "Cross-origin request refused.", code: "bad-origin" }, { status: 403 });
  }

  // The panic button must stop NEW work first. See the header.
  if (await store.get(KILL_SWITCH)) {
    return Response.json(
      {
        error: "This bridge is stopped. No new rooms can be opened until its operator restarts it.",
        code: "bridge-disabled",
        terminal: true,
      },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad("Body must be JSON.");
  }
  if (typeof body !== "object" || body === null) return bad("Body must be a JSON object.");
  const { topic, you, them, slots, kind, seats } = body as Record<string, unknown>;

  if (kind !== undefined && kind !== "trust" && kind !== "solo") {
    return bad('`kind` must be "trust" (two companies) or "solo" (your own models).', "kind");
  }
  const isSolo = kind === "solo";

  if (!isSolo && slots !== undefined && slots !== SUPPORTED_SLOTS) {
    return bad(
      `A trust room connects exactly ${SUPPORTED_SLOTS} parties — it is a record between two companies, and a third one changes what the record MEANS, not just how many seats it has. For several of your OWN models in one room, send kind: "solo" with a seats array.`,
      "slots",
    );
  }

  if (isSolo) {
    if (!Array.isArray(seats)) {
      return bad('A solo room needs a `seats` array of labels, e.g. ["Claude", "Gemini", "GPT"].', "seats");
    }
    if (seats.length < MIN_SEATS || seats.length > MAX_SOLO_SEATS) {
      return bad(
        `A room needs between ${MIN_SEATS} and ${MAX_SOLO_SEATS} seats; got ${seats.length}. One seat is a notepad, not a bridge.`,
        "seats",
      );
    }
  }

  // VALIDATE BEFORE CHARGING, and this ordering was a measured fix rather than
  // a guess. The first build charged first, so a rejected form — an empty
  // label, a 300-character topic — still burned one of the day's three rooms.
  // Running the live route showed the counter at 3 after only two rooms
  // existed: two typos and an honest person is locked out until midnight UTC,
  // which is a rate limiter punishing the wrong behaviour.
  //
  // Nothing is spent here, so validating for free costs nothing: the sanitiser
  // is pure string work against an already-bounded body. `createRoom` sanitises
  // again from the ORIGINAL inputs — passing the cleaned values back in would
  // risk double-escaping the containment markers, and one canonical cleaning
  // pass is easier to reason about than an idempotence argument.
  try {
    if (isSolo) {
      // Same free validation for the same measured reason as below: a typo in
      // seat four must not burn one of the day's rooms.
      sanitiseRoomText(topic, "topic", MAX_TOPIC);
      (seats as unknown[]).forEach((l, i) => sanitiseRoomText(l, `seats[${i}]`, MAX_LABEL));
    } else {
      sanitiseRoomMetadata({ topic, ownerLabel: you, peerLabel: them });
    }
  } catch (e) {
    if (e instanceof RoomTextRejected) return bad(e.why, e.field);
    throw e;
  }

  // Charged BEFORE createRoom: a refused attempt must not leave a room behind.
  // A quota REFUSAL still burns a slot (`chargeMint` increments first), so the
  // boundary cannot be probed for free — that is a different case from the
  // validation above, where the caller never got a room to begin with.
  const verdict = await chargeMint(store, req, now);
  if (!verdict.ok) {
    await writeAudit(store, {
      ts: now.toISOString(),
      tokenId: null,
      roomId: null,
      side: null,
      tool: "mint",
      status: "deny",
      reason: "mint-quota",
    });
    // RULED S#281 (Erik: "the best possible solution that doesn't cause friction").
    //
    // This used to send 429 WITH `terminal: true`, which says two opposite
    // things at once: the status invites a retry and the body forbids one. The
    // status wins, because it is read by SDK retry middleware underneath the
    // model, before a single word of the refusal text reaches anything able to
    // understand it -- the exact bug S#276 fixed for `daily-cap` over in
    // `DENY_STATUS`. It survived here because this is the one route that never
    // calls `authorize()` (ARCHITECTURE #30), so the invariant in
    // `refusal-status.test.ts` could not see it.
    //
    // Resolved TOWARDS 429 rather than away from it, because 429 is TRUE here:
    // the window really does reopen, `Retry-After` says exactly when, and a
    // client that backs off and returns after midnight gets a room. What was
    // false was `terminal`. A caller who wants to know whether to give up now
    // reads the header instead of a flag that contradicted it.
    return Response.json(
      {
        error: `That is ${verdict.limit} rooms today from this connection, which is the limit. It resets at midnight UTC.`,
        code: "mint-quota",
        terminal: false,
        limit: verdict.limit,
        resetsAt: verdict.resetsAt,
      },
      { status: 429, headers: { "Retry-After": String(Math.max(1, Math.ceil((new Date(verdict.resetsAt).getTime() - now.getTime()) / 1000))) } },
    );
  }

  // ── SOLO: one operator, several of their own models. No owner/peer, no
  // invitation, every seat joined on arrival. `DECISIONS.md` 2026-08-23. ──
  if (isSolo) {
    let made;
    try {
      made = await createSoloRoom(store, {
        topic: topic as string,
        seatLabels: seats as string[],
        now,
      });
    } catch (e) {
      if (e instanceof RoomTextRejected) return bad(e.why, e.field);
      throw e;
    }
    const viewerToken = await issueToken(store, made.room, "a", now, undefined, "viewer");
    // No unclaimed-TTL shortening here: there is nobody to wait for, so the
    // room is claimed the moment it exists and gets the normal idle life.
    await writeAudit(store, {
      ts: now.toISOString(),
      tokenId: null,
      roomId: made.room.id,
      side: null,
      tool: "mint",
      status: "ok",
    });
    return Response.json(
      {
        room: {
          id: made.room.id,
          topic: made.room.topic,
          createdAt: made.room.createdAt,
          kind: "solo",
        },
        slots: made.tokens,
        viewerToken,
        endpoint: new URL("/api/mcp", req.url).toString(),
        // ZERO, not the unclaimed TTL. A solo room has nobody to wait for --
        // every seat joins on creation -- so the "this lapses if nobody turns
        // up" clock does not apply and the UI must be able to tell the
        // difference between "no deadline" and "a deadline of zero".
        unclaimedExpiresInSeconds: 0,
        note:
          "Every seat is yours. Give each token to one model. Nothing here is " +
          "wrapped in untrusted-partner markers, because there is no other " +
          "company in this room.",
      },
      { status: 201 },
    );
  }

  let created;
  try {
    created = await createRoom(store, {
      topic,
      ownerLabel: you,
      peerLabel: them,
      now,
    } as Parameters<typeof createRoom>[1]);
  } catch (e) {
    // The sanitiser names the field it rejected, so the form can highlight it
    // rather than making the operator guess which of three inputs was wrong.
    if (e instanceof RoomTextRejected) return bad(e.why, e.field);
    throw e;
  }

  const { room, ownerToken, peerToken } = created;

  // A read-only seat for the browser that just created the room. Erik's UI
  // watches the record; it must not need a token that can also write into it.
  const viewerToken = await issueToken(store, room, "a", now, undefined, "viewer");

  // Shorten the room's life until somebody actually joins. Any write refreshes
  // it to the normal 30-day idle TTL (`refreshRoomTtl`), so this only ever
  // reaps rooms that were never used. Token records keep their own 30-day TTL
  // and are simply orphaned if the room lapses; `authorize` refuses them with
  // `room-missing`, which is the correct answer.
  await store.expire(ROOM_KEY(room.id), UNCLAIMED_ROOM_TTL_SECONDS);

  await writeAudit(store, {
    ts: now.toISOString(),
    tokenId: null,
    roomId: room.id,
    side: null,
    tool: "mint",
    status: "ok",
  });

  return Response.json(
    {
      room: { id: room.id, topic: room.topic, createdAt: room.createdAt },
      slots: [
        { side: "a", label: seat(room, "a").label, code: seat(room, "a").code, token: ownerToken },
        { side: "b", label: seat(room, "b").label, code: seat(room, "b").code, token: peerToken },
      ],
      viewerToken,
      endpoint: new URL("/api/mcp", req.url).toString(),
      unclaimedExpiresInSeconds: UNCLAIMED_ROOM_TTL_SECONDS,
      note: "These tokens are shown once. Only their hashes are stored — nobody can look them up again, including us. Lost one? Mint a replacement with `bridger rotate --side a|b`.",
    },
    { status: 201 },
  );
}

/**
 * Rename a room.
 *
 * NO ROOM ID IN THE REQUEST, deliberately. The bearer token already resolves to
 * exactly one room, so cross-room isolation here is structural rather than
 * checked: there is no identifier for a caller to swap for someone else's. A
 * `PATCH /api/rooms/:id` would have needed an ownership comparison, and an
 * ownership comparison is a thing that can be written wrong.
 *
 * A VIEWER CANNOT RENAME. The browser that created the room holds a viewer
 * token so that watching cannot become writing — which means the rename has to
 * be authorised by a participant token, the same seat that can post entries.
 * Letting the read-only seat mutate the room's name would quietly make "viewer"
 * mean something other than what `operations.ts` enforces everywhere else.
 */
export async function PATCH(req: Request) {
  const now = new Date();

  if (!originAllowed(req)) {
    return Response.json({ error: "Cross-origin request refused.", code: "bad-origin" }, { status: 403 });
  }

  const outcome = await gate(req);
  if (!outcome.ok) {
    await writeAudit(outcome.store, {
      ts: now.toISOString(),
      tokenId: null,
      roomId: null,
      side: null,
      tool: "rename",
      status: "deny",
      reason: outcome.reason,
    });
    return refusalResponse(outcome.reason, outcome.now);
  }

  const { store, room, token } = outcome;

  if (!canWrite(token)) {
    await writeAudit(store, {
      ts: now.toISOString(),
      tokenId: token.id,
      roomId: room.id,
      side: token.side,
      tool: "rename",
      status: "deny",
      reason: "viewer-read-only",
    });
    return Response.json(
      {
        error: "This is a read-only token. Renaming the room needs a participant token.",
        code: "viewer-read-only",
        terminal: true,
      },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad("Body must be JSON.");
  }
  const { topic } = (body ?? {}) as Record<string, unknown>;

  let cleaned: string;
  try {
    cleaned = sanitiseRoomText(topic, "topic", MAX_TOPIC);
  } catch (e) {
    if (e instanceof RoomTextRejected) return bad(e.why, e.field);
    throw e;
  }

  const updated = { ...room, topic: cleaned };
  await store.set(ROOM_KEY(room.id), JSON.stringify(updated));
  await store.expire(ROOM_KEY(room.id), ROOM_TTL_SECONDS);
  clearRegistryCache();

  await writeAudit(store, {
    ts: now.toISOString(),
    tokenId: token.id,
    roomId: room.id,
    side: token.side,
    tool: "rename",
    status: "ok",
  });

  return Response.json({ room: { id: room.id, topic: cleaned } });
}
