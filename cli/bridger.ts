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
} from "../lib/room-registry";
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
import { INVITE_REREAD_SECONDS, mintInvite } from "../lib/invites";
import { executePurge, purgeState, recordPurgeConsent } from "../lib/purge";
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
const DEFAULT_SERVER = (process.env.BRIDGER_SERVER ?? "https://bridger-nu.vercel.app").replace(
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
        label: room.sides.a.label,
        code: room.sides.a.code,
        peerLabel: room.sides.b.label,
        server,
        topic: room.topic,
      } satisfies LocalRoom,
      null,
      2,
    ) + "\n",
  );

  console.log(`
  Bridge open — ${room.topic}
  room ${room.id}   you: ${room.sides.a.label} (${room.sides.a.code})   partner: ${room.sides.b.label} (${room.sides.b.code})

  ── YOURS — connect this session ──────────────────────────────────
  ${joinCommand(server, ownerToken)}

  ── SEND THIS TO ${theirs.toUpperCase()} ${"─".repeat(Math.max(0, 44 - theirs.length))}
  ${joinCommand(server, peerToken)}

  ${joinFacts(server, peerToken)}

  Both tokens are shown ONCE. Only their hashes are stored — we cannot
  recover them. Lost one? \`bridger rotate --side a|b\`.
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
  Rotated side ${side} (${room!.sides[side].label}). The previous token now answers "revoked".

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

  const minutes = Number(arg("--ttl-minutes", "30"));
  const days = Number(arg("--token-days", "7"));
  const server = (local?.server ?? DEFAULT_SERVER).replace(/\/$/, "");

  const { code, expiresAt } = await mintInvite(store, room!, side, new Date(), {
    ttlSeconds: Math.max(1, minutes) * 60,
    tokenTtlSeconds: Math.max(1, days) * 24 * 60 * 60,
  });

  console.log(`
  Join code for ${room!.sides[side].label} on "${room!.topic}".
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
  if (!state[side]) state = await recordPurgeConsent(store, room!, side, new Date());

  const theirs = side === "a" ? state.b : state.a;
  if (!theirs && !force) {
    console.log(`
  Your consent is recorded for "${room!.topic}".

  WAITING ON ${room!.sides[side === "a" ? "b" : "a"].label.toUpperCase()}.
  Nothing has been deleted. Ask them to call bridger_purge with consent: true,
  then run this again. Consent expires after 7 days on both sides.

  If they are gone for good and will never consent, --force overrides this.
`);
    return;
  }

  if (!theirs && force) {
    console.log(`
  [!!] FORCING. ${room!.sides[side === "a" ? "b" : "a"].label} has NOT agreed.

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
  Read-only token for ${room!.sides[side].label}'s view of "${room!.topic}".
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
  Answerer token for ${room!.sides[side].label} on "${room!.topic}".
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
  console.log(`\n  Revoked ${n} token(s) on side ${side} (${room!.sides[side].label}).\n`);
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
    stop                                 PANIC: refuse every request, now
    start                                undo stop

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
    default:
      console.log(USAGE);
      process.exit(process.argv[2] ? 1 : 0);
  }
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
