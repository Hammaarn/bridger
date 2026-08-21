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

import { CLAIM_BASES, ENTRY_TYPES } from "@/lib/entries";
import { CITATION_MAX } from "@/lib/store";
import { auditRequest, gate, operationRefusalStatus, refusalResponse } from "@/lib/http-gate";
import {
  OperationRefused,
  opInvite,
  WAIT_MAX_SECONDS,
  opAnswer,
  opAsk,
  opContract,
  opDecide,
  opPing,
  opPost,
  opPurge,
  opRead,
  opReopen,
  opSignoff,
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
  /**
   * THE CHEAPEST VERB IN THE SYSTEM, and it was unreachable from here.
   *
   * `ping` collapses status + read + wait into one round trip, and it existed
   * only on MCP -- so the transport we want to RECOMMEND could not reach the
   * operation that costs a partner least. A far side on the flat path had to
   * spend three calls to learn what one returns, which is the exact cost this
   * op was built to remove.
   *
   * Same handler, same containment, same idle brake. The divergence was an
   * omission, not a decision.
   */
  ping: {
    schema: z.object({}),
    run: (ctx: OpContext, a: Record<string, never>) => opPing(ctx),
  },
  /**
   * A join link for the other seat, so the browser flow stops handing partners
   * a live bearer token to paste into a chat. See `opInvite`.
   */
  invite: {
    schema: z.object({
      side: z.enum(["a", "b"]).optional(),
      ttlMinutes: z.number().int().min(5).max(1440).optional(),
      tokenDays: z.number().int().min(1).max(90).optional(),
    }),
    run: opInvite,
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
      checkedAgainst: z.string().max(CITATION_MAX).optional(),
      // Declaring `opinion` and a citation together is refused in
      // lib/operations.ts rather than here, so the rule holds on BOTH
      // transports instead of being re-implemented once per parser.
      basis: z.enum(CLAIM_BASES as [string, ...string[]]).optional(),
    }),
    run: opAnswer,
  },
  decide: {
    schema: z.object({
      title: z.string().min(1).max(200),
      decision: z.string().min(1).max(20000),
      why: z.string().min(1).max(20000),
      // A DECISION IS THE MOST CONSEQUENTIAL ENTRY TYPE and was the only one
      // that structurally could not say what it was checked against (S#276).
      // `why` is reasoning; this is evidence. A decision grounded in a
      // measurement should be able to name the measurement.
      checkedAgainst: z.string().max(CITATION_MAX).optional(),
      basis: z.enum(CLAIM_BASES as [string, ...string[]]).optional(),
    }),
    run: opDecide,
  },
  post: {
    schema: z.object({
      title: z.string().min(1).max(200),
      body: z.string().max(20000).optional(),
      checkedAgainst: z.string().max(CITATION_MAX).optional(),
      basis: z.enum(CLAIM_BASES as [string, ...string[]]).optional(),
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
  reopen: {
    schema: z.object({ questionId: z.string().min(1), why: z.string().min(1).max(20000) }),
    run: opReopen,
  },
  signoff: {
    schema: z.object({ note: z.string().max(200).optional() }),
    run: opSignoff,
  },
  purge: {
    schema: z.object({ consent: z.boolean() }),
    run: opPurge,
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
    // The gate's clock, so `Retry-After` is measured against the same instant
    // the rate-limit bucket was evaluated on.
    return refusalResponse(g.reason, g.now);
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

    // The operation returns a PATH because it has no request in scope and no
    // honest way to know which host answered. This adapter does, so it composes
    // the absolute link here rather than letting a guessed hostname reach an
    // instruction someone follows (invariant 15).
    const withUrl =
      result && typeof result === "object" && typeof (result as { joinPath?: unknown }).joinPath === "string"
        ? { ...result, joinUrl: new URL((result as { joinPath: string }).joinPath, req.url).toString() }
        : result;

    await auditRequest(g.store, {
      now: g.now,
      token: g.token,
      room: g.room,
      tool: op,
      status: "ok",
      durationMs: Date.now() - startedAt,
    });
    return Response.json(withUrl);
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
      // THIS MAPPING WAS INVERTED UNTIL S#276 — it sent 429 for terminal
      // refusals and 403 for recoverable ones, which is backwards twice over.
      //
      // 429 means "come back shortly" and is retried automatically by HTTP
      // client libraries and SDK retry middleware. Sending it for the `STOP.`
      // idle brake meant the one refusal whose entire purpose is to END a
      // runaway loop instructed the transport to continue it — below the level
      // where the message explaining why could be read. And 403 for a bad
      // question id told a caller its one fixable mistake was permanent.
      //
      // Now: terminal -> 403 (retrying cannot succeed, and no client retries a
      // 403), recoverable -> 400 (your arguments were wrong; fix and resend).
      // 429 is never emitted here — the only genuinely time-based refusal is
      // the per-minute rate limit, which lives in the gate and carries
      // `Retry-After`. See the invariant on `DENY_STATUS`.
      //
      // The mapping itself is in `http-gate` so a test can reach it; inline
      // here it was wrong for months with nothing able to assert on it.
      return Response.json(
        { error: e.message, code: "refused", terminal: e.terminal },
        { status: operationRefusalStatus(e.terminal) },
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
