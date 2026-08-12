/**
 * THE FLAT TRANSPORT — one POST, a bearer token, a JSON body.
 *
 * WHY IT EXISTS. MCP is a good protocol and a bad onboarding story: the token
 * goes into a client config file, three known clients spell that file three
 * different ways, and one of them rejects the other two's keys
 * (`ARCHITECTURE.md` #13). A partner hits that wall blind, before they have
 * ever seen the product work.
 *
 * This surface needs none of it. Any AI with a shell or a fetch tool can use
 * the bridge from a pasted instruction block, with no config, no restart and no
 * per-client dialect. That is the whole point.
 *
 * THE DIVISION, so neither transport is the "real" one by accident:
 *   - MCP:   better ergonomics (the tools are discoverable, the client manages
 *            them) and the token never enters the model's context. Use it when
 *            the partner can.
 *   - /rpc:  reach. Works anywhere, joins in one paste, and the token IS in the
 *            model's context — so its tokens expire and its codes burn.
 *
 * BEHIND A FLAG. `BRIDGER_PASTE_PATH=1` or this route 404s. It is a prototype
 * for Erik to run, not a supported transport; promoting it is his call and is
 * queued in `plans/DECISIONS-FOR-ERIK-s272.md`.
 *
 * NO RULES LIVE HERE. Auth, kill switch and budget come from `lib/http-gate.ts`;
 * the viewer gate, idle brake and containment come from `lib/operations.ts`.
 * This file parses and serialises. That is the only reason a second transport
 * is safe to add rather than a fork waiting to drift.
 */

import { z } from "zod";

import { ENTRY_TYPES } from "@/lib/entries";
import { auditRequest, gate, refusalResponse } from "@/lib/http-gate";
import {
  OperationRefused,
  WAIT_MAX_SECONDS,
  opAnswer,
  opAsk,
  opContract,
  opDecide,
  opPost,
  opRead,
  opStatus,
  opWait,
  type OpContext,
} from "@/lib/operations";

export const runtime = "nodejs";
export const maxDuration = 60;

export function pastePathEnabled(): boolean {
  return process.env.BRIDGER_PASTE_PATH === "1";
}

/**
 * One schema per op. Deliberately the SAME shapes as the MCP tools: a partner
 * who starts here and later moves to MCP should not have to relearn the API,
 * and a divergence between the two would be a bug nobody notices for months.
 */
const OPS = {
  status: {
    schema: z.object({}),
    run: (ctx: OpContext, a: Record<string, never>) => opStatus(ctx),
  },
  read: {
    schema: z.object({
      since: z.number().int().min(0).optional(),
      types: z.array(z.enum(ENTRY_TYPES)).optional(),
      ids: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(500).optional(),
      markRead: z.boolean().optional(),
    }),
    run: opRead,
  },
  ask: {
    schema: z.object({ title: z.string().min(1).max(200), body: z.string().max(20000).optional() }),
    run: opAsk,
  },
  answer: {
    schema: z.object({
      questionId: z.string().min(1),
      answer: z.string().min(1).max(20000),
      checkedAgainst: z.string().max(500).optional(),
    }),
    run: opAnswer,
  },
  decide: {
    schema: z.object({
      title: z.string().min(1).max(200),
      decision: z.string().min(1).max(20000),
      why: z.string().min(1).max(20000),
    }),
    run: opDecide,
  },
  post: {
    schema: z.object({
      title: z.string().min(1).max(200),
      body: z.string().max(20000).optional(),
      checkedAgainst: z.string().max(500).optional(),
    }),
    run: opPost,
  },
  contract: {
    schema: z.object({
      body: z.string().max(100000).optional(),
      note: z.string().max(200).optional(),
    }),
    run: opContract,
  },
  wait: {
    schema: z.object({
      since: z.number().int().min(0).optional(),
      timeoutSeconds: z.number().int().min(1).max(WAIT_MAX_SECONDS).optional(),
    }),
    run: opWait,
  },
} as const;

export const OP_NAMES = Object.keys(OPS);

export async function POST(req: Request): Promise<Response> {
  if (!pastePathEnabled()) return new Response("Not found", { status: 404 });

  const startedAt = Date.now();
  const g = await gate(req);
  if (!g.ok) {
    await auditRequest(g.store, { now: g.now, tool: "rpc", status: "deny", reason: g.reason });
    return refusalResponse(g.reason);
  }

  let op = "unparsed";
  try {
    const raw: unknown = await req.json();
    const body = (raw ?? {}) as Record<string, unknown>;
    op = typeof body.op === "string" ? body.op : "missing";

    const entry = (OPS as Record<string, { schema: z.ZodTypeAny; run: Function } | undefined>)[op];
    if (!entry) {
      await auditRequest(g.store, {
        now: g.now,
        token: g.token,
        room: g.room,
        tool: op,
        status: "error",
        reason: "unknown-op",
        durationMs: Date.now() - startedAt,
      });
      return Response.json(
        {
          error: `Unknown op "${op}".`,
          code: "unknown-op",
          terminal: false,
          knownOps: OP_NAMES,
        },
        { status: 400 },
      );
    }

    const parsed = entry.schema.safeParse(body);
    if (!parsed.success) {
      // Field-level detail on purpose: the caller is an agent that can fix its
      // own call, and a bare "400 Bad Request" is the thing that makes it guess.
      return Response.json(
        {
          error: `Invalid arguments for "${op}".`,
          code: "invalid-args",
          terminal: false,
          issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
        { status: 400 },
      );
    }

    const ctx: OpContext = { store: g.store, room: g.room, token: g.token, now: g.now };
    const result = await entry.run(ctx, parsed.data);

    await auditRequest(g.store, {
      now: g.now,
      token: g.token,
      room: g.room,
      tool: op,
      status: "ok",
      durationMs: Date.now() - startedAt,
    });
    return Response.json(result);
  } catch (e) {
    if (e instanceof OperationRefused) {
      await auditRequest(g.store, {
        now: g.now,
        token: g.token,
        room: g.room,
        tool: op,
        status: "deny",
        reason: "operation-refused",
        durationMs: Date.now() - startedAt,
      });
      // 429 for terminal refusals (the budget/brake family), 403 otherwise (the
      // viewer gate). `terminal` in the body is what an agent should read.
      return Response.json(
        { error: e.message, code: "refused", terminal: e.terminal },
        { status: e.terminal ? 429 : 403 },
      );
    }
    const message = e instanceof Error ? e.message : String(e);
    await auditRequest(g.store, {
      now: g.now,
      token: g.token,
      room: g.room,
      tool: op,
      status: "error",
      reason: message.slice(0, 120),
      durationMs: Date.now() - startedAt,
    });
    // A credential refusal from the write path arrives here. It is the caller's
    // to fix, so it must not read as a server fault.
    const isRefusal = message.startsWith("REFUSED:");
    return Response.json(
      { error: message, code: isRefusal ? "refused" : "internal", terminal: false },
      { status: isRefusal ? 400 : 500 },
    );
  }
}
