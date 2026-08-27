#!/usr/bin/env -S npx tsx
/**
 * The Bridger CLI — the human half.
 *
 * TWO CLASSES OF COMMAND, AND THE SPLIT IS DELIBERATE
 * ---------------------------------------------------
 * **Operator commands** (`open`, `rotate`, `revoke`, `close`) mint and kill
 * tokens, so they talk straight to the registry and need `UPSTASH_REDIS_REST_*`
 * in the environment. Only whoever runs the bridge has those.
 *
 * **Partner commands** (`join`, `pull`, `log`, `status`) need nothing but a
 * room token and the server URL. Your partner runs these with no account, no
 * database credentials and no access to your repo — which is the entire
 * premise. This mirrors JudgeMySite's `scripts/extkeys.mjs`, where the same
 * split (admin-with-registry vs caller-with-key) already proved out.
 *
 * TOKENS ARE PRINTED ONCE, HERE, AND NEVER WRITTEN TO DISK.
 * `room.json` deliberately holds no secret: the token lives in Claude Code's
 * own MCP config, so the `bridger/` folder stays safe to commit.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  closeRoom,
  createRoom,
  issueToken,
  parseRoom,
  revokeSide,
  rotateSide,
  type SideId,
  readRoomActivity,
  seat,
  otherSide,} from "../lib/room-registry";
import {
  AUDIT_LOG,
  DEFAULT_DAILY_CAP,
  KILL_SWITCH,
  RATE_LIMIT_PER_MINUTE,
  ROOM_KEY,
  createStore,
} from "../lib/store";
import type { Entry } from "../lib/entries";
import { classifyCitation, describeCitation, isUnlocated, isWideRange } from "../lib/citation";
import { verifyChain, type ChainedEntry } from "../lib/chain";
import { INVITE_REREAD_SECONDS, INVITE_TTL_MINUTES, mintInvite } from "../lib/invites";
import { decidePurge, executePurge, purgeState, recordPurgeConsent } from "../lib/purge";
import type { AuditEntry } from "../lib/room-registry";

const FOLDER = "bridger";
const ROOM_FILE = join(FOLDER, "room.json");

/**
 * Load `.env.local` — Next does this for the server, nothing does it for us.
 *
 * Without this, `bridger open` fails with "Upstash is not set" on a machine
 * where the server works perfectly, because the credentials live in a file only
 * the framework reads. That is a confusing failure: the operator can see the
 * bridge running and cannot mint a token for it.
 *
 * Deliberately minimal and non-overriding — a variable already exported in the
 * shell wins, so `BRIDGER_STORE=file npm run bridger -- open` still selects the
 * local backend regardless of what the file says.
 */
function loadDotEnvLocal() {
  for (const file of [".env.local", ".env"]) {
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      if (process.env[key] !== undefined) continue;
      process.env[key] = line
        .slice(eq + 1)
        .trim()
        // `[\s\S]` rather than the `s` flag: the tsconfig target Next ships
        // predates dotAll, and tsc rejects the flag even though tsx runs it.
        .replace(/^(['"])([\s\S]*)\1$/, "$2");
    }
  }
}
loadDotEnvLocal();

// ── helpers ──────────────────────────────────────────────────────

const die = (msg: string): never => {
  console.error(`\n  ✖ ${msg}\n`);
  process.exit(1);
};

function operatorStore() {
  const store = createStore();
  if (!store) {
    die(
      "UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set.\n" +
        "    These are operator-only commands — your partner never needs them.",
    );
  }
  return store!;
}

interface LocalRoom {
  roomId: string;
  side: SideId;
  label: string;
  code: string;
  peerLabel: string;
  server: string;
  topic: string;
}

/**
 * Read a JSON file, tolerating a UTF-8 BOM.
 *
 * We never write one, but `room.json` is a plain file a human may open and
 * re-save — and on Windows that routinely adds a BOM (PowerShell's
 * `Set-Content -Encoding utf8` does it by default), which makes `JSON.parse`
 * fail with a message that points nowhere near the cause. Cost of tolerating
 * it: one `replace`.
 */
function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) as T;
}

function readLocalRoom(): LocalRoom {
  if (!existsSync(ROOM_FILE)) {
    die(`No ${ROOM_FILE} here. Run \`bridger join <token> --server <url>\` first.`);
  }
  return readJsonFile<LocalRoom>(ROOM_FILE);
}

function writeFile(path: string, contents: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

/** The token is read from the environment, never from a file we wrote. */
function requireToken(): string {
  const t = process.env.BRIDGER_TOKEN;
  if (!t) {
    die(
      "Set BRIDGER_TOKEN to your room token first.\n" +
        "    PowerShell:  $env:BRIDGER_TOKEN = 'br_live_...'\n" +
        "    bash:        export BRIDGER_TOKEN=br_live_...",
    );
  }
  return t!;
}

const arg = (flag: string, fallback?: string): string => {
  const i = process.argv.indexOf(flag);
  if (i === -1 || !process.argv[i + 1]) {
    if (fallback !== undefined) return fallback;
    die(`Missing required ${flag}`);
  }
  return process.argv[i + 1];
};

/**
 * Where the bridge actually lives.
 *
 * This was `https://bridger.vercel.app` in six hard-coded places until S#275,
 * and that host is SOMEBODY ELSE'S Vercel project — it answers, 308s to a
 * trailing slash and 404s. So every token minted without an explicit
 * `--server` printed a join line that would have sent `Authorization: Bearer
 * br_live_…` to a third party. The name was aspirational; Vercel assigned
 * `bridger-nu` because `bridger` was taken, and the literal never caught up.
 *
 * One constant, one env override. A default that appears six times is a
 * default that will be wrong in five of them.
 */
const DEFAULT_SERVER = (process.env.BRIDGER_SERVER ?? "https://bridger.nexus").replace(
  /\/$/,
  "",
);

const joinCommand = (server: string, token: string) =>
  `claude mcp add --transport http bridger ${server.replace(/\/$/, "")}/api/mcp --header "Authorization: Bearer ${token}"`;

/**
 * The client-agnostic form of the same two facts.
 *
 * `joinCommand` is Claude Code's shape. Every other MCP client wants the same
 * endpoint and the same header, and differs only in what it calls the endpoint
 * key — which is exactly the detail that costs a far side twenty minutes.
 * Antigravity rejects both `url` and `httpUrl`; it wants `serverUrl`.
 */
const joinFacts = (server: string, token: string) => {
  const endpoint = `${server.replace(/\/$/, "")}/api/mcp`;
  return `Not Claude Code? Any MCP client needs exactly two facts:
    endpoint   ${endpoint}
    header     Authorization: Bearer ${token}
  The endpoint's JSON key differs by client — Antigravity: "serverUrl"
  (it rejects "url" and "httpUrl") · Gemini CLI: "httpUrl". README has the matrix.`;
};

// ── operator commands ────────────────────────────────────────────

async function cmdOpen() {
  const store = operatorStore();
  const topic = arg("--topic");
  const mine = arg("--me");
  const theirs = arg("--them");
  const server = arg("--server", DEFAULT_SERVER);

  const { room, ownerToken, peerToken } = await createRoom(store, {
    topic,
    ownerLabel: mine,
    peerLabel: theirs,
    now: new Date(),
  });

  writeFile(
    ROOM_FILE,
    JSON.stringify(
      {
        roomId: room.id,
        side: "a",
        label: seat(room, "a").label,
        code: seat(room, "a").code,
        peerLabel: seat(room, "b").label,
        server,
        topic: room.topic,
      } satisfies LocalRoom,
      null,
      2,
    ) + "\n",
  );

  /**
   * ONE COMMAND IS THE WHOLE SETUP (S#283, Erik's flow).
   *
   * Erik wrote the flow he wanted, and the shape of it is what this now emits:
   *
   *     create room -> pick names -> GET AN INVITE LINK AND A WATCH TOKEN
   *     -> send the link -> their AI joins -> done
   *
   * Two outputs, not five. Note what is NOT in his flow: your own connector.
   * Creating the room FROM your AI session means your side is already
   * connected, so there is nothing to paste anywhere -- which is the difference
   * between five steps and eleven. The browser path cannot do that (your AI is
   * in another application, so you become the transport for your own
   * credential), and that is the friction he hit.
   *
   * THIS ALSO ENDS A STRAIGHT CONTRADICTION BETWEEN TWO SURFACES. `open` used
   * to print the PARTNER'S RAW TOKEN with an instruction to send it, while the
   * browser's minted screen argued the opposite in as many words: "This is
   * theirs, not yours. Send the invite link instead -- a link expires, a pasted
   * token does not." Both cannot be right. The link wins, for the reason the
   * browser already gave: a chat message is durable, and a token pasted into
   * one stays valid for as long as the bridge does.
   *
   * The peer token is still minted -- it is what the invite redeems into -- it
   * is simply not printed. `--show-token` prints it for the case the link
   * cannot serve: an air-gapped partner, or a client that cannot fetch a URL.
   */
  const linkMinutes = Math.max(1, Number(arg("--ttl-minutes", String(INVITE_TTL_MINUTES))) || INVITE_TTL_MINUTES);
  const tokenDays = Math.max(1, Number(arg("--token-days", "7")) || 7);
  const invite = await mintInvite(store, room, "b", new Date(), {
    ttlSeconds: linkMinutes * 60,
    tokenTtlSeconds: tokenDays * 24 * 60 * 60,
  });
  const watchToken = await issueToken(store, room, "a", new Date(), undefined, "viewer");
  const showToken = process.argv.includes("--show-token");

  console.log(`
  Bridge open — ${room.topic}
  room ${room.id}   you: ${seat(room, "a").label} (${seat(room, "a").code})   partner: ${seat(room, "b").label} (${seat(room, "b").code})

  ── YOUR CONNECTOR — this is the only time it is shown ────────────

  ${ownerToken}

  If an AI ran this command, it already has it and there is nothing to do.
  If YOU ran it, paste it into your AI. Nothing stores it: \`room.json\`
  carries no secret, and a lost one is replaced with \`bridger rotate\`,
  never recovered.

  ── 1. SEND THIS TO ${theirs.toUpperCase()} ${"─".repeat(Math.max(0, 41 - theirs.length))}

  ${server}/j/${invite.code}

  One link. Their AI opens it and gets the whole protocol plus a credential
  minted for them alone. Live for ${Math.round(linkMinutes / 60)}h; the token it mints lasts ${arg("--token-days", "7")} days.
  Send the LINK, not a token: a link expires, a message does not.

  ── 2. WATCH IT IN A BROWSER ─────────────────────────────────────

  ${server}   ->  paste:  ${watchToken}

  Read-only. It cannot write, and it draws on its own budget rather than
  the room's, so leaving the tab open cannot starve the actual work.
${
  showToken
    ? `
  ── partner's raw token (--show-token) ────────────────────────────
  ${joinCommand(server, peerToken)}

  ${joinFacts(server, peerToken)}
`
    : ""
}
  Shown ONCE — only hashes are stored. Lost one? \`bridger rotate --side a|b\`.
  Wrote ${ROOM_FILE} (contains no secret; safe to commit).
`);
}

async function cmdRotate() {
  const store = operatorStore();
  const roomId = arg("--room", readLocalRoomSafe()?.roomId ?? "");
  const side = arg("--side") as SideId;
  const room = parseRoom(await store.get(ROOM_KEY(roomId)));
  if (!room) die(`No such room: ${roomId}`);

  const fresh = await rotateSide(store, room!, side, new Date());
  const server = readLocalRoomSafe()?.server ?? DEFAULT_SERVER;
  console.log(`
  Rotated side ${side} (${seat(room!, side).label}). The previous token now answers "revoked".

  ${joinCommand(server, fresh)}
`);
}

/**
 * Mint a read-only token.
 *
 * This is what belongs in a browser tab, on a shared screen, or in the hands of
 * someone who needs to see the record without being able to speak into it. It
 * exists because the web view originally had no token of its own, so watching a
 * bridge meant pasting a participant token somewhere visible.
 */
/**
 * Mint a join code — the paste-and-go onboarding.
 *
 * Prints ONE line to send. The code, not a token: a chat message is durable and
 * a token pasted into one stays valid as long as the bridge does, whereas a
 * code goes dead on a short clock.
 *
 * SINGLE-MINT, NOT SINGLE-READ. The link issues exactly one token and then
 * returns that same token to every fetch for 10 minutes. Tell the recipient
 * that: the previous behaviour died on the first read, which meant an agent's
 * retry — or a chat client's link preview — could destroy the invitation before
 * the intended reader ever saw it.
 */
async function cmdInvite() {
  const store = operatorStore();
  const local = readLocalRoomSafe();
  const roomId = arg("--room", local?.roomId ?? "");
  const side = arg("--side", "b") as SideId;
  const room = parseRoom(await store.get(ROOM_KEY(roomId)));
  if (!room) die(`No such room: ${roomId}`);

  const minutes = Math.max(1, Number(arg("--ttl-minutes", String(INVITE_TTL_MINUTES))) || INVITE_TTL_MINUTES);
  const days = Number(arg("--token-days", "7"));
  const server = (local?.server ?? DEFAULT_SERVER).replace(/\/$/, "");

  const { code, expiresAt } = await mintInvite(store, room!, side, new Date(), {
    ttlSeconds: Math.max(1, minutes) * 60,
    tokenTtlSeconds: Math.max(1, days) * 24 * 60 * 60,
  });

  console.log(`
  Join code for ${seat(room!, side).label} on "${room!.topic}".
  Unredeemed it lasts ${minutes} minutes. It mints EXACTLY ONE token, and then
  keeps handing that same token to anyone who fetches the link for
  ${Math.round(INVITE_REREAD_SECONDS / 60)} minutes before going dead for good.

  Send them this line:

      Join our integration bridge: ${server}/j/${code}

  Their AI fetches that URL and gets a working token plus the whole protocol
  in one document. No install, no config file, no restart.

  Why it is not one-read-only: the first version died on the first fetch, so an
  agent's retry -- or a chat client previewing the link -- destroyed the
  invitation before the intended reader saw it. That is not hypothetical; it is
  how the first live partner demo failed.

  The token it mints expires in ${days} days. Requires BRIDGER_PASTE_PATH=1
  on the server. Code expires ${expiresAt}.
`);
}

/**
 * WHO CAME BACK — the one number the funnel argument runs on.
 *
 * `audit` answers "who called what, how often" from a rolling window that one
 * busy session overflows, so it structurally cannot answer "has anybody used a
 * room on more than one day". That question needs a tally nothing evicts, which
 * is what `ROOM_ACTIVITY_KEY` is (S#280, D6).
 *
 * The two halves do different jobs and the split is deliberate: the audit log
 * provides DISCOVERY (which rooms exist, lossily) and the activity record
 * provides TRUTH (what that room actually did, completely). So a room quiet
 * enough to have fallen out of the window is not listed here — and its tally is
 * still intact, which is why `--room` takes an id directly.
 */
async function cmdUsage() {
  const store = operatorStore();
  const only = arg("--room", "");

  let ids: string[];
  if (only) {
    ids = [only];
  } else {
    const raw = await store.lrange(AUDIT_LOG, 0, 20000);
    const seen = new Set<string>();
    for (const r of raw) {
      try {
        const row = (typeof r === "string" ? JSON.parse(r) : r) as AuditEntry;
        if (row?.roomId) seen.add(row.roomId);
      } catch {
        /* a malformed row is not a reason to fail the report */
      }
    }
    ids = [...seen];
  }

  const rows = [];
  for (const id of ids) {
    const a = await readRoomActivity(store, id);
    if (a) rows.push({ id, ...a });
  }
  rows.sort((x, y) => y.days.length - x.days.length || y.calls - x.calls);

  if (!rows.length) {
    console.log(`
  No activity records found.${only ? "" : " (Rooms are discovered from the audit window.)"}
`);
    return;
  }

  const returning = rows.filter((r) => r.days.length > 1);
  console.log(`
  ${rows.length} room(s) with a tally - ${returning.length} used on more than one day
`);
  console.log("  room          days  calls  first       last");
  for (const r of rows) {
    const mark = r.days.length > 1 ? "*" : " ";
    console.log(
      `${mark} ${r.id.padEnd(14)}${String(r.days.length).padStart(4)}${String(r.calls).padStart(7)}  ` +
        `${r.firstAt.slice(0, 10)}  ${r.lastAt.slice(0, 16).replace("T", " ")}`,
    );
  }
  console.log(`
  * = came back on a later day. That is the only claim this table makes:
    it counts CALLS, not people, and a room both sides left open counts once
    per day it saw traffic.
`);
}

/**
 * Read the audit log back.
 *
 * It has been written since the beginning and read by nothing: `AUDIT_LOG`
 * appears in exactly two places, both writes. So "who called what, how often"
 * — the first question an incident asks — was answerable only by someone with
 * a Redis client and the key layout in their head. During an incident, at 2am,
 * that is the same as unanswerable.
 *
 * A CLI subcommand, not a dashboard: the operator already holds the credentials
 * and is already in a terminal. The smallest thing that answers the question.
 */
async function cmdAudit() {
  const store = operatorStore();
  const limit = Number(arg("--limit", "50"));
  const only = arg("--status", "");
  const token = arg("--token", "");

  const raw = await store.lrange(AUDIT_LOG, 0, Math.max(1, limit) * 4);
  const rows = raw
    .map((r) => {
      try {
        return typeof r === "string" ? JSON.parse(r) : r;
      } catch {
        return null;
      }
    })
    .filter(Boolean) as AuditEntry[];

  const matching = rows
    .filter((r) => (only ? r.status === only : true))
    .filter((r) => (token ? r.tokenId === token : true))
    .slice(0, Math.max(1, limit));

  if (!matching.length) {
    console.log(`
  No audit rows match. (The log is capped and rooms expire.)
`);
    return;
  }

  // The tallies first: during an incident the shape of the traffic is the
  // question, and the individual rows are the follow-up.
  const byTool = new Map<string, number>();
  const byStatus = new Map<string, number>();
  for (const r of matching) {
    byTool.set(r.tool, (byTool.get(r.tool) ?? 0) + 1);
    byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  }

  console.log(`
  ${matching.length} rows (newest first)
`);
  console.log(
    `  by status: ${[...byStatus].map(([k, v]) => `${k}=${v}`).join("  ")}\n` +
      `  by call:   ${[...byTool]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`)
        .join("  ")}\n`,
  );

  for (const r of matching) {
    const who = r.tokenId ? `${r.tokenId.slice(0, 8)}/${r.side ?? "?"}` : "anon";
    const mark = r.status === "ok" ? " " : r.status === "deny" ? "!" : "x";
    const ms = r.durationMs !== undefined ? `${r.durationMs}ms` : "";
    console.log(
      `  ${mark} ${r.ts}  ${who.padEnd(11)} ${r.tool.padEnd(18)} ${r.status.padEnd(5)} ${ms}${r.reason ? "  " + r.reason : ""}`,
    );
  }
  console.log(`
  Filters: --status ok|deny|error  --token <id>  --limit N
`);
}

/**
 * Delete a bridge and everything on it — WITH THE OTHER SIDE'S AGREEMENT.
 *
 * Erik's requirement, and it is the right shape: the ledger is a JOINT record,
 * so one side erasing it destroys the other's account of what was asked,
 * answered and decided — which is exactly what they may need most when a
 * relationship is ending. The partner consents with `bridger_purge`; the
 * operator consents and executes here. Neither can finish it alone.
 */
async function cmdPurge() {
  const store = operatorStore();
  const local = readLocalRoomSafe();
  // Never inferred from room.json for this one command. Every other command
  // defaulting to "the room you are in" is a convenience; here it would mean a
  // mistyped flag deletes a live bridge.
  const roomId = arg("--room", "");
  if (!roomId) die("bridger purge --room <id>   (required -- this command is not allowed to guess)");
  const room = parseRoom(await store.get(ROOM_KEY(roomId)));
  if (!room) die(`No such room: ${roomId}`);

  const side = (arg("--side", local?.side ?? "a")) as SideId;
  const force = process.argv.includes("--force");

  let state = await purgeState(store, room!);
  // `PurgeState` is deliberately two-seat (see lib/purge.ts) because the
  // two-consent ritual is a TRUST-room property. Narrow explicitly rather than
  // widening the state shape into something a solo room would never use.
  const consentSeat = side === "b" ? "b" : "a";
  if (!state[consentSeat]) state = await recordPurgeConsent(store, room!, side, new Date());

  // The CLI purge flow is a TRUST-room ritual (two consents). A solo room has
  // one operator and does not need a second signature, so this stays two-seat
  // deliberately rather than being generalised into something meaningless.
  const theirs = side === "a" ? state.b : state.a;
  // The branch itself lives in lib/purge.ts so it can be tested. A gate whose
  // logic is only reachable through argv and stdout is a gate nobody has
  // checked -- which is what TODO B6 said about this one for several sessions.
  const decision = decidePurge(Boolean(theirs), force);
  if (decision === "wait") {
    console.log(`
  Your consent is recorded for "${room!.topic}".

  WAITING ON ${seat(room!, otherSide(side)).label.toUpperCase()}.
  Nothing has been deleted. Ask them to call bridger_purge with consent: true,
  then run this again. Consent expires after 7 days on both sides.

  If they are gone for good and will never consent, --force overrides this.
`);
    return;
  }

  if (decision === "force") {
    console.log(`
  [!!] FORCING. ${seat(room!, otherSide(side)).label} has NOT agreed.

  You are deleting a shared record without the other side's consent. This is
  here for the case where a partner has genuinely vanished -- not as a way
  around the agreement.
`);
  }

  const removed = await executePurge(store, room!);
  console.log(`
  Purged "${room!.topic}" (${roomId}). ${removed.length} keys removed:

${removed.map((k) => `      ${k}`).join("\n")}

  [!!] THIS DELETED THE SERVER'S COPY ONLY.
  Anything either side already pulled into a local bridger/ folder -- and it is
  probably committed to a repo -- is untouched and cannot be reached from here.
  If you promised a partner deletion, that promise covers this buffer.
`);
}

async function cmdViewer() {
  const store = operatorStore();
  const local = readLocalRoomSafe();
  const roomId = arg("--room", local?.roomId ?? "");
  const side = arg("--side", local?.side ?? "a") as SideId;
  const room = parseRoom(await store.get(ROOM_KEY(roomId)));
  if (!room) die(`No such room: ${roomId}`);

  const token = await issueToken(store, room!, side, new Date(), undefined, "viewer");
  const server = local?.server ?? DEFAULT_SERVER;
  console.log(`
  Read-only token for ${seat(room!, side).label}'s view of "${room!.topic}".
  It can read the record and nothing else — every write tool refuses it.

  Watch in a browser:   ${server.replace(/\/$/, "")}
  Paste this token:     ${token}

  Shown once. Revoke with:  bridger revoke --side ${side}
`);
}

/**
 * Mint an answerer token — the cheap seat, for a partner who pays per turn.
 *
 * Bridger calls no LLM, so every tool schema we publish is billed to the CALLER
 * on every one of their turns whether they use it or not. An answerer is shown
 * two tools (`bridger_ping`, `bridger_answer`) and given nothing to probe with.
 *
 * It WRITES. This is a smaller surface, not a weaker one — and the narrowed
 * tool list is a cost optimisation, never a permission boundary: every refusal
 * still lives in `operations.ts`. Do not hand this out as a way to restrict
 * someone; hand out `viewer` for that.
 */
async function cmdAnswerer() {
  const store = operatorStore();
  const local = readLocalRoomSafe();
  const roomId = arg("--room", local?.roomId ?? "");
  const side = arg("--side", local?.side ?? "b") as SideId;
  const room = parseRoom(await store.get(ROOM_KEY(roomId)));
  if (!room) die(`No such room: ${roomId}`);

  const token = await issueToken(store, room!, side, new Date(), undefined, "answerer");
  const server = local?.server ?? DEFAULT_SERVER;
  console.log(`
  Answerer token for ${seat(room!, side).label} on "${room!.topic}".
  Two tools only: bridger_ping (one call, everything) and bridger_answer.

  ── IF THEY RUN CLAUDE CODE ───────────────────────────────────────
  ${joinCommand(server, token)}

  ── ANY OTHER MCP CLIENT (Antigravity, Gemini CLI, Cursor) ────────
  endpoint:  ${server.replace(/\/$/, "")}/api/mcp
  header:    Authorization: Bearer ${token}

  Antigravity names the endpoint \`serverUrl\` and REJECTS \`url\`/\`httpUrl\`,
  and it has three mcp_config.json files on disk of which two are empty.
  The client matrix in README.md has the exact shape per client.

  Then tell their agent: "call bridger_ping, answer what is waiting, then stop."

  Shown once. Revoke with:  bridger revoke --side ${side}
`);
}

/**
 * The panic button, and the reason it is a first-class command.
 *
 * When an agent loop on the other side of a bridge started burning a model
 * quota, there was no stop — the switch existed in code and could only be
 * thrown with a hand-written Redis call. A safety mechanism that requires
 * improvisation during an incident is not a safety mechanism.
 *
 * This is the REDIS switch, not the env one: it is checked before anything else
 * on every request with no cache in front of it, so it takes effect on the next
 * call and needs no redeploy. `BRIDGER_DISABLED=true` remains as the break-glass
 * for the case where Redis itself is the problem.
 */
async function cmdStop() {
  const store = operatorStore();
  await store.set(KILL_SWITCH, "1");
  console.log(`
  BRIDGE STOPPED. Every request is now refused, on every deployment sharing this
  registry, starting with the next call. Callers receive a terminal refusal that
  opens with STOP and tells them not to retry.

  Nothing is lost — the ledger is intact and both tokens still exist.
  Turn it back on with:  bridger start
`);
}

async function cmdStart() {
  const store = operatorStore();
  await store.del(KILL_SWITCH);
  console.log(`
  Bridge live again. Budgets in force: ${RATE_LIMIT_PER_MINUTE}/minute and
  ${DEFAULT_DAILY_CAP}/day per token. Check with:  bridger status
`);
}

async function cmdRevoke() {
  const store = operatorStore();
  const roomId = arg("--room", readLocalRoomSafe()?.roomId ?? "");
  const side = arg("--side") as SideId;
  const room = parseRoom(await store.get(ROOM_KEY(roomId)));
  if (!room) die(`No such room: ${roomId}`);
  const n = await revokeSide(store, room!, side);
  console.log(`\n  Revoked ${n} token(s) on side ${side} (${seat(room!, side).label}).\n`);
}

async function cmdClose() {
  const store = operatorStore();
  const roomId = arg("--room", readLocalRoomSafe()?.roomId ?? "");
  const room = parseRoom(await store.get(ROOM_KEY(roomId)));
  if (!room) die(`No such room: ${roomId}`);
  await closeRoom(store, room!);
  console.log(`\n  Room ${roomId} closed. Both sides now get "room-closed" rather than a silent failure.\n`);
}

function readLocalRoomSafe(): LocalRoom | null {
  try {
    return existsSync(ROOM_FILE) ? (JSON.parse(readFileSync(ROOM_FILE, "utf8")) as LocalRoom) : null;
  } catch {
    return null;
  }
}

// ── partner commands ─────────────────────────────────────────────

async function fetchExport(server: string, token: string) {
  const res = await fetch(`${server.replace(/\/$/, "")}/api/export`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    die(`Server said ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as {
    room: { id: string; topic: string; you: any; peer: any };
    contract: { body: string; updatedBy: string; updatedAt: string } | null;
    entries: Entry[];
    exportedAt: string;
  };
}


/**
 * THE LEDGER COMMANDS -- the CLI as a thin client of the FLAT transport.
 *
 * WHY THESE EXIST. `lib/operations.ts` has held the behaviour since the
 * beginning and `/api/rpc` has exposed it since S#272, but the CLI could only
 * ever READ the record (`pull`, `log`, `status`) or administer it. Writing to
 * the bridge required MCP -- which means it required a client config file, a
 * restart, and one of three per-vendor dialects. The one transport with no
 * setup at all had no first-class client.
 *
 * WHY NOT TALK TO THE STORE DIRECTLY. It would be shorter and it would be a
 * fork. Going over HTTP means the CLI exercises the same gate, the same rate
 * limits, the same containment and the same refusal contract a partner hits,
 * so a bug here is a bug there. A CLI that bypassed the transport would pass
 * tests the partner path fails.
 *
 * THE STANDING COST IS ZERO, which is the entire argument. A resident MCP
 * schema is billed on every turn of the caller's session whether they use it
 * or not -- measured at ~1,800 tokens for the full surface, ~318 for the
 * narrowed answerer. A shell command is billed when it is run.
 *
 * EXIT CODES CARRY THE REFUSAL CONTRACT, and this is the part that is not
 * cosmetic. `terminal` means retrying cannot succeed; the server has said so
 * since S#276 and the flat transport returns 403 for it. But a model reading
 * prose decides for itself whether to try again, and the open question in
 * TODO B2 is precisely whether a real client STOPS. A process exit code is not
 * a matter of judgement: 0 succeeded, 1 is terminal and must not be retried,
 * 75 (EX_TEMPFAIL, the sysexits convention) may be. A shell loop, a Makefile
 * or an agent all obey it identically, which converts an open behavioural
 * question into a mechanical guarantee.
 */
const EXIT_TERMINAL = 1;
const EXIT_RETRYABLE = 75;

const wantsJson = () => process.argv.includes("--json");

/** Positional argument, with a usage line rather than an index error. */
function positional(i: number, usage: string): string {
  const v = process.argv[i];
  if (!v || v.startsWith("--")) die(`Usage: bridger ${usage}`);
  return v!;
}

/** Optional flag: absent becomes undefined rather than an empty string. */
function opt(flag: string): string | undefined {
  const v = arg(flag, "");
  return v === "" ? undefined : v;
}

async function rpc(op: string, payload: Record<string, unknown> = {}): Promise<any> {
  const server = arg("--server", readLocalRoomSafe()?.server ?? DEFAULT_SERVER).replace(/\/$/, "");
  const token = requireToken();

  let res: Response;
  try {
    res = await fetch(`${server}/api/rpc`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ op, ...payload }),
    });
  } catch (e) {
    // A network failure is NOT a refusal, and conflating the two is how a
    // caller concludes the service is broken while holding a good credential.
    console.error(`\n  Could not reach ${server}: ${(e as Error).message}`);
    console.error("  That is a network failure, not a refusal. Retrying may help.\n");
    return process.exit(EXIT_RETRYABLE);
  }

  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text.slice(0, 400) };
  }

  if (!res.ok) {
    // 401 is terminal by nature: a bad or revoked token does not become good.
    const terminal = data?.terminal === true || res.status === 403 || res.status === 401;
    console.error(`\n  Refused (${res.status}): ${data?.error ?? text.slice(0, 400)}`);
    console.error(
      terminal
        ? "  TERMINAL. Retrying cannot change this answer -- stop, and tell your operator.\n"
        : "  Retryable. The same call may succeed later.\n",
    );
    return process.exit(terminal ? EXIT_TERMINAL : EXIT_RETRYABLE);
  }

  if (wantsJson()) {
    console.log(JSON.stringify(data, null, 2));
    return null;
  }
  return data;
}

/**
 * Entries, rendered so a human and a model read the same thing.
 *
 * NOTHING HERE IS TRUNCATED, and that is a containment requirement rather than
 * a preference. Far-side prose arrives wrapped in [[UNTRUSTED-PARTNER-TEXT]]
 * markers, and a `.slice()` long enough to look tidy is long enough to cut the
 * CLOSING marker off a long question -- which would hand the reader an opened
 * quarantine that never closes. My first version did exactly that. The same
 * reason forbids collapsing whitespace: the markers are line-structured.
 *
 * `checked` is the server's field. It is the literal string "unchecked" when
 * there is no provenance, so it is compared rather than tested for truthiness
 * -- `if (e.checked)` is true for the word "unchecked" and would have reported
 * every unchecked answer as verified.
 */
function renderEntries(entries: any[] | undefined): string {
  if (!entries?.length) return "  (nothing new)";
  return entries
    .map((e) => {
      // `checked` arrives PRE-LABELLED ("checked-against: ...") and the citation
      // inside it is partner prose, so it carries containment markers of its
      // own and is multi-line. Prefixing it with "checked against" doubled the
      // label, and putting it on the header line buried the entry id behind a
      // wall of quarantine banner. It gets its own line, printed verbatim.
      const checked = e.checked && e.checked !== "unchecked";
      // For an answer the server uses the answer text as the title, so title
      // and body are the same string and printing both showed it twice.
      const body = e.body && e.body !== e.title ? e.body : "";
      return [
        `  [${e.seq}] ${String(e.type).toUpperCase()} ${e.id}  from ${e.from}${
          checked ? "" : "  -- UNCHECKED"
        }`,
        `  ${e.title}`,
        body ? `\n${body}` : "",
        checked ? `\n  ${e.checked}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n  ----------------------------------------------------------\n\n");
}

/**
 * The server's guidance names MCP tools, because that is where these
 * operations lived first. A caller on this transport has no `bridger_answer`
 * -- being told to call one is being pointed at a channel they do not have.
 * Rewritten at the presentation layer rather than in `lib/operations.ts`,
 * because MCP callers genuinely do have those tools and the shared behaviour
 * is right for them.
 */
function forCli(text: string | undefined): string {
  return (text ?? "").replace(/bridger_([a-z]+)/g, "bridger $1");
}

async function cmdPing() {
  const d = await rpc("ping");
  if (!d) return;
  const waiting: any[] = d.awaitingYou ?? [];
  console.log(`
  ${d.topic ?? "Bridge"}
  You are ${d.you?.label ?? "?"} (${d.you?.code ?? "?"}). Partner: ${d.peer?.label ?? "?"}${
    d.peer?.joined === false ? " -- has NOT connected yet" : ""
  }.
  Waiting on you: ${waiting.length}. New entries: ${d.newEntries?.length ?? 0}.
${
  waiting.length
    ? "\n  QUESTIONS FOR YOU\n\n" +
      waiting.map((q: any) => `  ${q.id}  (asked by ${q.askedBy})\n  ${q.title}`).join("\n\n")
    : ""
}

  NEW ENTRIES

${renderEntries(d.newEntries)}
`);
  if (d._note) console.log(`  ${forCli(d._note)}\n`);
  if (d.guidance) console.log(`  ${forCli(d.guidance)}\n`);
}

async function cmdRead() {
  const since = opt("--since");
  const d = await rpc("read", {
    since: since ? Number(since) : undefined,
    markRead: !process.argv.includes("--keep-unread"),
  });
  if (!d) return;
  console.log(`\n${renderEntries(d.entries)}\n`);
  if (d.cursor !== undefined) console.log(`  cursor: ${d.cursor}\n`);
  if (d.guidance) console.log(`  ${forCli(d.guidance)}\n`);
}

async function cmdAsk() {
  const title = positional(3, 'ask "<one-line question>" [--body "context"]');
  const d = await rpc("ask", { title, body: opt("--body") });
  if (d) console.log(`\n  Asked ${d.posted?.id ?? ""} -- it is now their turn.\n`);
}

async function cmdAnswer() {
  const questionId = positional(3, 'answer <QUESTION-ID> "<answer>" [--checked "file.ts:41"]');
  const answer = positional(4, 'answer <QUESTION-ID> "<answer>" [--checked "file.ts:41"]');
  const checkedAgainst = opt("--checked");
  if (!checkedAgainst) {
    // Not a refusal. An unchecked answer is legitimate; an unchecked answer
    // that READS like a verified one is the thing the whole record exists to
    // prevent, so the absence is stated out loud rather than left implicit.
    console.error("  [!] No --checked given. This answer will be recorded UNCHECKED.");
  }
  const d = await rpc("answer", { questionId, answer, checkedAgainst });
  if (d) {
    const note = checkedAgainst ? "" : " Recorded UNCHECKED.";
    console.log(`\n  Answered ${questionId} as ${d.posted?.id ?? ""}.${note}\n`);
  }
}

async function cmdDecide() {
  const title = positional(3, 'decide "<title>" --decision "..." --why "..." [--checked "..."]');
  const d = await rpc("decide", {
    title,
    decision: arg("--decision"),
    why: arg("--why"),
    checkedAgainst: opt("--checked"),
  });
  if (d) console.log(`\n  Decision recorded. ${d.posted?.id ?? ""}\n`);
}

async function cmdPost() {
  const title = positional(3, 'post "<title>" [--body "..."]');
  const d = await rpc("post", { title, body: opt("--body"), checkedAgainst: opt("--checked") });
  if (d) console.log(`\n  Posted ${d.posted?.id ?? ""}\n`);
}

async function cmdContract() {
  const body = opt("--body");
  const d = await rpc("contract", { body, note: opt("--note") });
  if (!d) return;
  if (body) console.log("\n  Contract replaced.\n");
  else console.log(`\n${d.body ?? "  (no contract yet)"}\n`);
}

async function cmdReopen() {
  const questionId = positional(3, 'reopen <QUESTION-ID> --why "..."');
  const d = await rpc("reopen", { questionId, why: arg("--why") });
  if (d) console.log(`\n  Reopened ${questionId}.\n`);
}

async function cmdSignoff() {
  const d = await rpc("signoff", { note: opt("--note") });
  if (d) console.log("\n  Signed off.\n");
}

/**
 * Block until they write, in a SHELL rather than in a session.
 *
 * An agent has no event loop, so the only way it can learn of a reply is to
 * ask -- and every ask from inside the session lands in its context whether or
 * not it carries anything. Waiting HERE costs the session nothing at all: the
 * shell holds the connection, and only the reply that actually has content is
 * ever read back in.
 *
 * `--follow` re-issues the wait after a timeout, so a single command can hold
 * an entire afternoon. A timeout is a normal result, not an error, and it is
 * reported as one -- an ambiguous refusal is what a machine reads as broken.
 */
async function cmdWait() {
  const follow = process.argv.includes("--follow");
  const timeoutSeconds = Number(arg("--timeout", "45"));
  for (;;) {
    const d = await rpc("wait", { timeoutSeconds });
    if (!d) return;
    if (d.entries?.length) {
      console.log(`\n${renderEntries(d.entries)}\n`);
      return;
    }
    if (!follow) {
      console.log("\n  Nothing arrived within the window. That is a normal result.");
      if (d.guidance) console.log(`  ${forCli(d.guidance)}`);
      console.log("");
      return;
    }
  }
}


/**
 * C3b — THE LISTENER. The whole point is that it costs the model NOTHING.
 *
 * A session waiting for the far side has only bad options today. `wait` blocks
 * for 45 seconds and returns "nothing yet", which is a turn: bytes enter the
 * model's context, and doing it all night is a thousand turns spent learning
 * nothing. `status` is worse per call.
 *
 * This is a PROCESS, not a turn. It sleeps on the operator's own machine, where
 * sleeping is free, and speaks exactly once — when something has actually
 * arrived. A thousand empty polls become one line that says "they replied".
 *
 * ── THE HONEST LIMIT, STATED RATHER THAN GLOSSED ─────────────────────────
 *
 * There is no interrupt into a language model. Nothing here can make a session
 * NOTICE anything; bytes reach a model only when a turn happens. What this
 * removes is the thousand wasted turns, not the last one. `--exec` is the hook
 * for whatever wakes your session — a notification, a file write, a webhook.
 *
 * ── AND IT IS THE CHEAP PATH FOR THE DATABASE TOO ────────────────────────
 *
 * It polls `/api/since`, which answers "has anything happened" for TWO Redis
 * commands where `wait` spends about sixteen. Eight hours of listening:
 *
 *     bridger wait --follow (45s server long-poll) .... ~10,240 commands
 *     bridger listen (60s local sleep, /api/since) ....     ~960
 *
 * Against a 500,000/month free tier that is 20% of the month against 2%.
 */
async function cmdListen() {
  const server = arg("--server", readLocalRoomSafe()?.server ?? DEFAULT_SERVER).replace(/\/$/, "");
  const token = requireToken();
  const exec = arg("--exec", "");
  const once = process.argv.includes("--once");

  /**
   * Sleep between polls. Clamped to the server's own floor rather than trusted:
   * a `--interval 1` would be refused by the rate limiter and the operator
   * would see a broken listener instead of a corrected one.
   */
  const MIN_INTERVAL = 15;
  const wanted = Number(arg("--interval", "60"));
  const interval = Math.max(MIN_INTERVAL, Number.isFinite(wanted) ? wanted : 60);
  if (wanted < MIN_INTERVAL) {
    console.error(
      `  --interval ${wanted}s is below the ${MIN_INTERVAL}s floor this endpoint allows; using ${interval}s.`,
    );
  }

  // Start from where the record is NOW, not from zero: a listener started
  // mid-conversation should report what happens NEXT, not replay the history
  // its operator has already read.
  let seq = 0;
  try {
    const res = await fetch(`${server}/api/since?seq=0`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    seq = Number(res.headers.get("X-Bridger-Seq") ?? 0) || 0;
  } catch (e) {
    console.error(`
  Could not reach ${server}: ${(e as Error).message}
`);
    return process.exit(EXIT_RETRYABLE);
  }

  console.error(
    `  Listening on ${server} from seq ${seq}, one poll every ${interval}s ` +
      `(~${Math.round((2 * 3600) / interval)} Redis commands/hour). Ctrl-C to stop.`,
  );

  let consecutiveFailures = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, interval * 1000));

    let res: Response;
    try {
      res = await fetch(`${server}/api/since?seq=${seq}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (e) {
      // A network blip must not kill an overnight listener. Back off, say so
      // ONCE rather than every cycle, and keep going.
      consecutiveFailures++;
      if (consecutiveFailures === 1) {
        console.error(`  Lost contact with ${server} (${(e as Error).message}). Retrying.`);
      }
      if (consecutiveFailures > 20) {
        console.error("  Twenty consecutive failures. Stopping rather than hammering.");
        return process.exit(EXIT_RETRYABLE);
      }
      continue;
    }

    if (consecutiveFailures) {
      console.error("  Contact restored.");
      consecutiveFailures = 0;
    }

    // 204: nothing new. The common answer, and it must stay silent — a listener
    // that prints on every quiet poll is a listener nobody leaves running.
    if (res.status === 204) continue;

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`
  ${server} refused the poll (${res.status}). ${body.slice(0, 300)}
`);
      return process.exit(res.status === 429 ? EXIT_RETRYABLE : 1);
    }

    const body = (await res.json()) as { latestSeq?: number };
    const latest = Number(body.latestSeq ?? 0);
    if (!latest || latest <= seq) continue;

    // Only NOW does anything cost a normal call: fetch what actually arrived.
    const data = await rpc("read", { since: seq });
    seq = latest;

    if (data?.entries?.length) {
      console.log(`
${renderEntries(data.entries)}
`);
      if (exec) {
        const { spawn } = await import("node:child_process");
        // Detached and inherited: whatever wakes the operator's session is
        // their business, and a listener must not die because it failed.
        try {
          spawn(exec, { shell: true, stdio: "inherit" });
        } catch (e) {
          console.error(`  --exec failed: ${(e as Error).message}`);
        }
      }
    }

    if (once) return;
  }
}

async function cmdJoin() {
  const token = process.argv[3];
  if (!token?.startsWith("br_live_")) die("Usage: bridger join br_live_... --server <url>");
  const server = arg("--server", DEFAULT_SERVER);

  const data = await fetchExport(server, token);
  writeFile(
    ROOM_FILE,
    JSON.stringify(
      {
        roomId: data.room.id,
        side: data.room.you.side,
        label: data.room.you.label,
        code: data.room.you.code,
        peerLabel: data.room.peer.label,
        server,
        topic: data.room.topic,
      } satisfies LocalRoom,
      null,
      2,
    ) + "\n",
  );

  const add = spawnSync("claude", ["mcp", "add", "--transport", "http", "bridger",
    `${server.replace(/\/$/, "")}/api/mcp`, "--header", `Authorization: Bearer ${token}`],
    { stdio: "inherit", shell: true });

  console.log(`
  Joined "${data.room.topic}" as ${data.room.you.label} (${data.room.you.code}).
  Partner: ${data.room.peer.label}.
  ${add.status === 0 ? "Registered the MCP server with Claude Code." : `Could not run \`claude\` automatically — run this yourself:\n\n  ${joinCommand(server, token)}`}

  Next: \`bridger pull\` to write the record into ./${FOLDER}/
`);
}

/**
 * Materialise the ledger as files.
 *
 * One file per entry, named by its id, so the folder diffs cleanly and a
 * reviewer can read the record without any tooling at all. `log.jsonl` keeps
 * the machine-readable trace alongside it.
 */
async function cmdPull() {
  const local = readLocalRoom();
  const token = requireToken();
  const data = await fetchExport(local.server, token);

  const dirFor: Record<string, string> = {
    question: "questions",
    answer: "answers",
    decision: "decisions",
    note: "notes",
    contract: "contracts",
  };

  for (const e of data.entries) {
    const provenance = e.checkedAgainst ? `checked-against: ${e.checkedAgainst}` : "UNCHECKED";
    const md = [
      `# ${e.id} — ${e.title}`,
      "",
      `- from: ${e.author} (${e.code})`,
      `- at: ${e.ts}`,
      `- seq: ${e.seq}`,
      ...(e.answers ? [`- answers: ${e.answers}`] : []),
      `- provenance: ${provenance}`,
      "",
      e.body,
      ...(e.why ? ["", "## Why", "", e.why] : []),
      "",
    ].join("\n");
    writeFile(join(FOLDER, dirFor[e.type] ?? "notes", `${e.id}.md`), md);
  }

  if (data.contract) {
    writeFile(
      join(FOLDER, "contracts", "CONTRACT.md"),
      `# Contract\n\n_Last updated by ${data.contract.updatedBy} at ${data.contract.updatedAt}_\n\n${data.contract.body}\n`,
    );
  }

  writeFile(join(FOLDER, "log.jsonl"), data.entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

  const unchecked = data.entries.filter((e) => e.type === "answer" && !e.checkedAgainst).length;
  console.log(`
  Pulled ${data.entries.length} entries into ./${FOLDER}/
  ${unchecked > 0 ? `[!] ${unchecked} answer(s) are recorded UNCHECKED — worth a look before anyone builds on them.` : "All answers carry provenance."}
`);
}

async function cmdLog() {
  const local = readLocalRoom();
  const data = await fetchExport(local.server, requireToken());
  console.log(`\n  ${data.room.topic}  (room ${data.room.id})\n`);
  for (const e of data.entries) {
    // `✓` used to mean "cited something", which flattened a pinpoint and a
    // gesture into one glyph. `◐` splits off the citations that name no place
    // you could go and look — or that span so many lines they barely narrow
    // anything. It grades the CITATION, never the answer.
    const c = classifyCitation(e.checkedAgainst);
    const mark = !e.checkedAgainst
      ? e.type === "answer"
        ? "?"
        : " "
      : isUnlocated(c) || isWideRange(c)
        ? "◐"
        : "✓";
    const span = e.checkedAgainst ? `  (${describeCitation(c)})` : "";
    console.log(
      `  ${mark} ${String(e.seq).padStart(3)} ${e.id.padEnd(12)} ${e.type.padEnd(9)} ${e.author.padEnd(14)} ${e.title.slice(0, 60)}${span}`,
    );
  }
  console.log("\n  ✓ cited to a place you can check   ◐ cited, but not narrowly   ? answered with no citation\n");
}

async function cmdStatus() {
  const local = readLocalRoom();
  const data = await fetchExport(local.server, requireToken());
  const answered = new Set(data.entries.filter((e) => e.answers).map((e) => e.answers));
  const open = data.entries.filter((e) => e.type === "question" && !answered.has(e.id));
  console.log(`
  ${data.room.topic}
  room ${data.room.id}   you: ${data.room.you.label}   partner: ${data.room.peer.label}${data.room.peer.joinedAt ? "" : "  (has NOT connected yet)"}
  entries: ${data.entries.length}   open questions: ${open.length}
${open.map((q) => `    · ${q.id}  ${q.author}: ${q.title}`).join("\n")}
`);
}

async function cmdVerify() {
  const local = readLocalRoom();
  const data = await fetchExport(local.server, requireToken());
  const verdict = verifyChain((data.entries ?? []) as ChainedEntry[]);

  const HEAD_FILE = join(FOLDER, "chain.json");
  const stored = existsSync(HEAD_FILE)
    ? readJsonFile<{ head: string; seq: number; at: string }>(HEAD_FILE)
    : null;

  if (!verdict.ok) {
    // `return die(...)` rather than a bare call: `die` is a const arrow with a
    // `never` return type, and TypeScript only narrows on never-returning
    // functions declared with `function` or an annotated variable. Without the
    // return, everything below still sees the failure branch of the union.
    return die(
      `THE RECORD DOES NOT VERIFY.

` +
        `    ${verdict.note}
` +
        `    First bad entry: ${verdict.at.id} (seq ${verdict.at.seq})
` +
        `    Reason: ${verdict.reason}

` +
        `    Entries checked before the break: ${verdict.verified}
` +
        `    Do not build on this record until it is explained.`,
    );
  }

  // THE COMPARISON IS THE POINT. A chain served by the party that could have
  // rewritten it verifies against itself no matter what -- the only thing that
  // makes it evidence is a head recorded independently, earlier, on this disk.
  let drift = "";
  if (stored && verdict.head) {
    if (stored.seq > (verdict.to ?? 0)) {
      drift =
        `
  [!!] THE RECORD SHRANK. You stored seq ${stored.seq}; the server now ends at ` +
        `${verdict.to}. Entries you already saw are gone.`;
    } else if (stored.seq === verdict.to && stored.head !== verdict.head) {
      drift =
        `
  [!!] THE HEAD CHANGED WITHOUT THE RECORD GROWING.
` +
        `       You stored ${stored.head.slice(0, 16)}... at seq ${stored.seq}
` +
        `       The server now reports ${verdict.head.slice(0, 16)}... at the same seq.
` +
        `       Something was rewritten. Keep bridger/chain.json as evidence.`;
    } else {
      drift = `
  Matches the head you stored on ${stored.at} and has grown since. No rewrite.`;
    }
  } else if (!stored) {
    drift = `
  No previously stored head, so this run establishes the baseline.`;
  }

  if (verdict.head) {
    writeFile(
      HEAD_FILE,
      JSON.stringify(
        { head: verdict.head, seq: verdict.to, at: new Date().toISOString() },
        null,
        2,
      ) + "\n",
    );
  }

  console.log(`
  Chain verified.

  entries hashed and checked : ${verdict.verified}
  written before chaining    : ${verdict.unchained}
  segment                    : seq ${verdict.from ?? "-"} to ${verdict.to ?? "-"}
  head                       : ${verdict.head ?? "(none)"}
${drift}

  What this proves: no entry was altered relative to the others in what the
  server just sent. What it does NOT prove on its own: that the server did not
  recompute the whole chain. That is why the head is written to
  ${HEAD_FILE} -- run this regularly, and a rewrite becomes provable by you
  rather than deniable by us.
`);
}

// ── dispatch ─────────────────────────────────────────────────────

const USAGE = `
  bridger — a shared, traced record between two teams' AI sessions

  OPERATOR (needs UPSTASH_REDIS_REST_URL / _TOKEN)
    open   --topic "<what this is>" --me "<You>" --them "<Partner>" [--server <url>]
           THE WHOLE SETUP IN ONE COMMAND: your side connected, an invite LINK
           to send, and a read-only watch token. Nothing to paste anywhere.
           [--ttl-minutes 240] [--token-days 7] [--show-token]
    rotate --side a|b [--room <id>]      mint a fresh token, revoke the old one
    viewer --side a|b [--room <id>]      mint a READ-ONLY token (for a browser tab)
    answerer --side a|b [--room <id>]    mint a TWO-TOOL token -- ping + answer only.
                                         For a far side that pays per turn: ~1,800
                                         tokens/turn of tool schema becomes ~320.
    invite [--side a|b] [--ttl-minutes N] [--token-days N]
                                         join code -- paste-and-go. Mints ONE token,
                                         re-readable for 10 min, then dead
    revoke --side a|b [--room <id>]      kill a side's access
    close  [--room <id>]                 end the bridge
    purge  --room <id> [--side a|b]      DELETE it -- needs BOTH sides' consent
    audit  [--status ok|deny|error] [--token <id>] [--limit N]
                                         who called what, how often
    usage  [--room <id>]                 which rooms came back -- a tally the
                                         rolling audit window cannot evict
    stop                                 PANIC: refuse every request, now
    start                                undo stop

  LEDGER -- needs only BRIDGER_TOKEN, no install, no config file
    ping                          everything waiting on you, in ONE call. Start here.
    read [--since N]              entries since a cursor
    ask "<title>" [--body ..]     ask the other side
    answer <QID> "<text>" [--checked "file.ts:41"]
    decide "<title>" --decision ".." --why ".." [--checked ".."]
    post "<title>" [--body ..]    a note that answers nothing
    contract [--body ".." --note ".."]   read, or replace
    reopen <QID> --why ".."
    signoff [--note ".."]
    wait [--timeout 45] [--follow]  block in the SHELL, not in your context
    listen [--interval 60] [--exec "cmd"] [--once]
                                    RUN THIS OVERNIGHT. A process, not a turn:
                                    sleeps locally and speaks only when something
                                    arrives. Costs your model zero tokens, and the
                                    bridge ~2 Redis commands per poll against
                                    wait's ~16. 8h listening: ~960 vs ~10,240.

    Add --json to any of them for machine-readable output.
    Exit codes: 0 ok - 1 TERMINAL, do not retry - 75 retryable.

  PARTNER (needs only BRIDGER_TOKEN)
    join <token> [--server <url>]        register the MCP server + write room.json
    pull                                 write the record into ./bridger/
    log                                  one line per entry (✓ = has provenance)
    status                               unread, open questions, whose turn
    verify                               recompute the tamper-evidence chain and
                                         compare it to the head YOU stored last time
`;

async function main() {
  switch (process.argv[2]) {
    case "open": return cmdOpen();
    case "rotate": return cmdRotate();
    case "viewer": return cmdViewer();
    case "answerer": return cmdAnswerer();
    case "invite": return cmdInvite();
    case "audit": return cmdAudit();
    case "usage": return cmdUsage();
    case "stop": return cmdStop();
    case "start": return cmdStart();
    case "revoke": return cmdRevoke();
    case "close": return cmdClose();
    case "purge": return cmdPurge();
    case "join": return cmdJoin();
    case "pull": return cmdPull();
    case "log": return cmdLog();
    case "status": return cmdStatus();
    case "verify": return cmdVerify();
    case "ping": return cmdPing();
    case "read": return cmdRead();
    case "ask": return cmdAsk();
    case "answer": return cmdAnswer();
    case "decide": return cmdDecide();
    case "post": return cmdPost();
    case "contract": return cmdContract();
    case "reopen": return cmdReopen();
    case "signoff": return cmdSignoff();
    case "wait": return cmdWait();
    case "listen": return cmdListen();
    default:
      console.log(USAGE);
      process.exit(process.argv[2] ? 1 : 0);
  }
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
