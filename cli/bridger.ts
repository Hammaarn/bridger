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
  parseRoom,
  revokeSide,
  rotateSide,
  type SideId,
} from "../lib/room-registry";
import { ROOM_KEY, createStore } from "../lib/store";
import type { Entry } from "../lib/entries";

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

const joinCommand = (server: string, token: string) =>
  `claude mcp add --transport http bridger ${server.replace(/\/$/, "")}/api/mcp --header "Authorization: Bearer ${token}"`;

// ── operator commands ────────────────────────────────────────────

async function cmdOpen() {
  const store = operatorStore();
  const topic = arg("--topic");
  const mine = arg("--me");
  const theirs = arg("--them");
  const server = arg("--server", "https://bridger.vercel.app");

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
  const server = readLocalRoomSafe()?.server ?? "https://bridger.vercel.app";
  console.log(`
  Rotated side ${side} (${room!.sides[side].label}). The previous token now answers "revoked".

  ${joinCommand(server, fresh)}
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
  const server = arg("--server", "https://bridger.vercel.app");

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
    const mark = e.checkedAgainst ? "✓" : e.type === "answer" ? "?" : " ";
    console.log(
      `  ${mark} ${String(e.seq).padStart(3)} ${e.id.padEnd(12)} ${e.type.padEnd(9)} ${e.author.padEnd(14)} ${e.title.slice(0, 60)}`,
    );
  }
  console.log("");
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

// ── dispatch ─────────────────────────────────────────────────────

const USAGE = `
  bridger — a shared, traced record between two teams' AI sessions

  OPERATOR (needs UPSTASH_REDIS_REST_URL / _TOKEN)
    open   --topic "<what this is>" --me "<You>" --them "<Partner>" [--server <url>]
    rotate --side a|b [--room <id>]      mint a fresh token, revoke the old one
    revoke --side a|b [--room <id>]      kill a side's access
    close  [--room <id>]                 end the bridge

  PARTNER (needs only BRIDGER_TOKEN)
    join <token> [--server <url>]        register the MCP server + write room.json
    pull                                 write the record into ./bridger/
    log                                  one line per entry (✓ = has provenance)
    status                               unread, open questions, whose turn
`;

async function main() {
  switch (process.argv[2]) {
    case "open": return cmdOpen();
    case "rotate": return cmdRotate();
    case "revoke": return cmdRevoke();
    case "close": return cmdClose();
    case "join": return cmdJoin();
    case "pull": return cmdPull();
    case "log": return cmdLog();
    case "status": return cmdStatus();
    default:
      console.log(USAGE);
      process.exit(process.argv[2] ? 1 : 0);
  }
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
