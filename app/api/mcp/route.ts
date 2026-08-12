/**
 * The Bridger MCP endpoint.
 *
 * Both sides' Claude Code sessions connect here with one line:
 *
 *   claude mcp add --transport http bridger \
 *     https://<host>/api/mcp --header "Authorization: Bearer br_live_..."
 *
 * NOTE ON THE PACKAGE API. Vercel's published example is out of date against
 * mcp-handler 2.1.0 (verified by reading `node_modules/mcp-handler/dist/index.d.ts`
 * and `@modelcontextprotocol/server@2.0.0`, not by trusting the docs page):
 *   - the server types come from `@modelcontextprotocol/server`, not `/sdk`
 *   - `createMcpHandler(init, options?)` takes TWO args — there is no `basePath`;
 *     routing belongs to the host framework
 *   - `registerTool(name, {title, description, inputSchema}, cb)` wants a FULL
 *     zod object as `inputSchema`, not the raw `{ field: z.string() }` shape
 *   - a tool reads its authenticated caller from `ctx.http?.authInfo`
 *
 * NO MODEL IS CALLED ANYWHERE IN THIS FILE. Bridger has no ANTHROPIC_API_KEY
 * and no LLM dependency: it is a tool server that each side's existing
 * subscription session calls. That is the whole cost story.
 */

import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  appendEntry,
  getContract,
  getStatus,
  readEntries,
  setContract,
  setCursor,
  waitForNew,
  type Entry,
  ENTRY_TYPES,
} from "@/lib/entries";
import {
  authorize,
  canWrite,
  markJoined,
  VIEWER_REFUSAL,
  writeAudit,
  type RoomRecord,
  type TokenRecord,
} from "@/lib/room-registry";
import { createStore, type Store } from "@/lib/store";

// node:crypto and the Upstash client both need the Node runtime.
export const runtime = "nodejs";
/**
 * Ceiling for `bridger_wait`. The tool's own default is well under this so a
 * wait always returns before the platform can cut it — but the platform limit
 * varies by Vercel plan, so `WAIT_MAX_SECONDS` below is the value that actually
 * bounds it, and it is deliberately conservative.
 */
export const maxDuration = 60;

const WAIT_DEFAULT_SECONDS = 25;
const WAIT_MAX_SECONDS = 45;

// ── auth ─────────────────────────────────────────────────────────

interface BridgeAuth {
  room: RoomRecord;
  token: TokenRecord;
}

/**
 * Resolve the bearer token to a room and a side.
 *
 * Returning `undefined` makes `withMcpAuth` refuse the request. The specific
 * deny reason is written to the audit log rather than the response: telling an
 * unauthenticated caller *why* their token failed is free reconnaissance.
 */
async function verifyToken(_req: Request, bearerToken?: string): Promise<AuthInfo | undefined> {
  const store = createStore();
  const now = new Date();
  const outcome = await authorize(store, { presentedToken: bearerToken ?? null, now });

  if (!outcome.ok) {
    await writeAudit(store, {
      ts: now.toISOString(),
      tokenId: null,
      roomId: null,
      side: null,
      tool: "auth",
      status: "deny",
      reason: outcome.reason,
    });
    return undefined;
  }

  // First authenticated call from a side is what "joined" means — there is no
  // separate join step to forget to call.
  const room = store ? await markJoined(store, outcome.room, outcome.token.side, now) : outcome.room;

  return {
    token: bearerToken as string,
    scopes: ["bridge"],
    clientId: `${outcome.token.roomId}:${outcome.token.side}`,
    extra: { room, token: outcome.token } satisfies BridgeAuth as unknown as Record<string, unknown>,
  };
}

/** Pull the authenticated bridge out of a tool's context, or fail loudly. */
function bridgeFrom(ctx: unknown): BridgeAuth {
  const extra = (ctx as { http?: { authInfo?: AuthInfo } })?.http?.authInfo?.extra as
    | BridgeAuth
    | undefined;
  if (!extra?.room || !extra?.token) {
    throw new Error("bridger: no authenticated room on this request");
  }
  return extra;
}

/**
 * Same as `bridgeFrom`, for the tools that WRITE.
 *
 * A viewer token authenticates fine — it can read the room, and should — so
 * this is a per-tool gate rather than an auth-layer one. Every write path goes
 * through here, which is why there is one function and not a check copied into
 * five handlers: the copies are what drift.
 */
function writableBridgeFrom(ctx: unknown): BridgeAuth {
  const bridge = bridgeFrom(ctx);
  if (!canWrite(bridge.token)) throw new Error(VIEWER_REFUSAL);
  return bridge;
}

/** Every tool answers in one shape: JSON text an agent can parse without guessing. */
function reply(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function requireStore(): Store {
  const store = createStore();
  if (!store) throw new Error("bridger: registry unavailable");
  return store;
}

/** Compact wire shape — the agent gets the fields it acts on, not our internals. */
function wire(e: Entry) {
  return {
    id: e.id,
    seq: e.seq,
    type: e.type,
    from: e.author,
    at: e.ts,
    title: e.title,
    body: e.body,
    ...(e.answers ? { answers: e.answers } : {}),
    ...(e.why ? { why: e.why } : {}),
    checked: e.checkedAgainst ? `checked-against: ${e.checkedAgainst}` : "unchecked",
  };
}

// ── the server ───────────────────────────────────────────────────

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "bridger_status",
      {
        title: "Bridge status",
        description:
          "What has happened on the bridge since you last read it: unread count from the other side, open questions and whose turn each one is, and whether your partner has connected yet. Call this at the start of a session and whenever you resume work on this integration.",
        inputSchema: z.object({}),
      },
      async (_args, ctx) => {
        const { room, token } = bridgeFrom(ctx);
        const status = await getStatus(requireStore(), room, token);
        return reply(status);
      },
    );

    server.registerTool(
      "bridger_read",
      {
        title: "Read the bridge ledger",
        description:
          "Read entries from the shared record. Use `since` with the cursor from bridger_status to get only what is new, or `ids` to pull a specific question or decision. Set `markRead` to advance your cursor once you have actually taken the entries in.",
        inputSchema: z.object({
          since: z.number().int().min(0).optional().describe("Only entries with a higher seq."),
          types: z.array(z.enum(ENTRY_TYPES)).optional(),
          ids: z.array(z.string()).optional().describe("Specific entry ids, e.g. ['JMS-Q-014']."),
          limit: z.number().int().min(1).max(500).optional(),
          markRead: z.boolean().optional().describe("Advance your cursor to the newest entry read."),
        }),
      },
      async (args, ctx) => {
        const { room, token } = bridgeFrom(ctx);
        const store = requireStore();
        const entries = await readEntries(store, room.id, {
          sinceSeq: args.since,
          types: args.types,
          ids: args.ids,
          limit: args.limit,
        });
        let cursor: number | undefined;
        if (args.markRead && entries.length) {
          cursor = await setCursor(store, room.id, token.side, entries[entries.length - 1].seq);
        }
        return reply({ count: entries.length, entries: entries.map(wire), ...(cursor ? { cursor } : {}) });
      },
    );

    server.registerTool(
      "bridger_ask",
      {
        title: "Ask the other side a question",
        description:
          "Open a question for your partner's side of the integration. Use this instead of asking your own user to relay it — that relay is exactly what Bridger removes. Ask when the answer lives in THEIR codebase or is THEIR decision to make.",
        inputSchema: z.object({
          title: z.string().min(1).max(200).describe("The question, in one line."),
          body: z.string().max(20000).optional().describe("Context: what you tried, why it matters."),
        }),
      },
      async (args, ctx) => {
        const { room, token } = writableBridgeFrom(ctx);
        const entry = await appendEntry(
          requireStore(),
          room,
          token,
          { type: "question", title: args.title, body: args.body ?? "" },
          new Date(),
        );
        return reply({ posted: wire(entry), note: "The other side sees this at their next bridger_status." });
      },
    );

    server.registerTool(
      "bridger_answer",
      {
        title: "Answer an open question",
        description:
          "Answer a question from the other side. `checkedAgainst` is the point of this tool: name the file, line, commit, endpoint or command you actually read to know this is true. Omit it and the answer is recorded as UNCHECKED, which is honest and fine — what is not fine is an unchecked claim that reads like a verified one.",
        inputSchema: z.object({
          questionId: z.string().min(1).describe("The id being answered, e.g. 'TRI-Q-003'."),
          answer: z.string().min(1).max(20000),
          checkedAgainst: z
            .string()
            .max(500)
            .optional()
            .describe("What you actually read, e.g. 'lib/external/usage-report.ts:41' or 'GET /api/health'."),
        }),
      },
      async (args, ctx) => {
        const { room, token } = writableBridgeFrom(ctx);
        const entry = await appendEntry(
          requireStore(),
          room,
          token,
          {
            type: "answer",
            title: args.answer.slice(0, 200),
            body: args.answer,
            answers: args.questionId,
            checkedAgainst: args.checkedAgainst ?? null,
          },
          new Date(),
        );
        return reply({ posted: wire(entry) });
      },
    );

    server.registerTool(
      "bridger_decide",
      {
        title: "Record a decision",
        description:
          "Write a decision into the shared record so neither side re-litigates it later. Use it the moment a direction is settled — a wire format, a field name, a scope cut. `why` is not optional in spirit: a decision without its reasoning gets reopened.",
        inputSchema: z.object({
          title: z.string().min(1).max(200),
          decision: z.string().min(1).max(20000),
          why: z.string().min(1).max(20000),
        }),
      },
      async (args, ctx) => {
        const { room, token } = writableBridgeFrom(ctx);
        const entry = await appendEntry(
          requireStore(),
          room,
          token,
          { type: "decision", title: args.title, body: args.decision, why: args.why },
          new Date(),
        );
        return reply({ posted: wire(entry) });
      },
    );

    server.registerTool(
      "bridger_post",
      {
        title: "Post a note",
        description:
          "Leave a note on the bridge that is not a question, answer or decision — a status update, a heads-up that something shipped, a pointer to a branch.",
        inputSchema: z.object({
          title: z.string().min(1).max(200),
          body: z.string().max(20000).optional(),
          checkedAgainst: z.string().max(500).optional(),
        }),
      },
      async (args, ctx) => {
        const { room, token } = writableBridgeFrom(ctx);
        const entry = await appendEntry(
          requireStore(),
          room,
          token,
          {
            type: "note",
            title: args.title,
            body: args.body ?? "",
            checkedAgainst: args.checkedAgainst ?? null,
          },
          new Date(),
        );
        return reply({ posted: wire(entry) });
      },
    );

    server.registerTool(
      "bridger_contract",
      {
        title: "Read or update the shared contract",
        description:
          "The one document both sides build against — the wire format, the endpoints, the event shapes. Call with no arguments to read it. Pass `body` to replace it; the replacement is logged to the ledger with your name on it, because a silent contract change is the most expensive edit either side can make.",
        inputSchema: z.object({
          body: z.string().max(100000).optional().describe("Omit to read. Provide to replace."),
          note: z.string().max(200).optional().describe("What changed and why."),
        }),
      },
      async (args, ctx) => {
        // Split by intent, not by tool: reading the contract is a viewer's
        // right, replacing it is not. Checked here rather than at the top
        // because this one tool is both a read and a write.
        const { room, token } = args.body === undefined ? bridgeFrom(ctx) : writableBridgeFrom(ctx);
        const store = requireStore();
        if (args.body === undefined) {
          const contract = await getContract(store, room.id);
          return reply(contract ?? { body: "", updatedBy: null, updatedAt: null, note: "No contract agreed yet." });
        }
        const entry = await setContract(store, room, token, args.body, args.note ?? "", new Date());
        return reply({ updated: true, logged: wire(entry) });
      },
    );

    server.registerTool(
      "bridger_wait",
      {
        title: "Wait for the other side",
        description:
          `Block until your partner's side writes something, or the timeout expires (default ${WAIT_DEFAULT_SECONDS}s, max ${WAIT_MAX_SECONDS}s). Use it right after asking a question when their session is live and you expect a quick reply. A timeout is a normal result, not an error — it means nothing has arrived yet.`,
        inputSchema: z.object({
          since: z.number().int().min(0).optional().describe("Defaults to the room's current newest seq."),
          timeoutSeconds: z.number().int().min(1).max(WAIT_MAX_SECONDS).optional(),
        }),
      },
      async (args, ctx) => {
        const { room, token } = bridgeFrom(ctx);
        const store = requireStore();
        const since =
          args.since ?? (await getStatus(store, room, token)).latestSeq;
        const result = await waitForNew(store, room, token, {
          sinceSeq: since,
          timeoutMs: (args.timeoutSeconds ?? WAIT_DEFAULT_SECONDS) * 1000,
          pollMs: 1000,
        });
        return reply({
          timedOut: result.timedOut,
          waitedMs: result.waitedMs,
          count: result.entries.length,
          entries: result.entries.map(wire),
        });
      },
    );
  },
  {
    serverInfo: { name: "bridger", version: "0.1.0" },
    instructions:
      "Bridger is a shared, append-only record between two teams building an integration together. " +
      "Call bridger_status when you start work or resume it. When something is the other side's to answer or decide, " +
      "use bridger_ask rather than asking your own user to relay the question. When you answer, name what you actually " +
      "read in checkedAgainst — an unchecked answer is acceptable, an unchecked answer dressed as a verified one is not.",
  },
);

const authed = withMcpAuth(handler, verifyToken, { required: true });

export { authed as GET, authed as POST, authed as DELETE };
