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

import { OP_NATURE } from "@/lib/op-nature";

import { CLAIM_BASES, ENTRY_TYPES } from "@/lib/entries";
import { CITATION_MAX } from "@/lib/store";
import { auditRequest, gate, operationRefusalStatus, refusalResponse } from "@/lib/http-gate";
import {
  OperationRefused,
  opInvite,
  opWebhook,
  WAIT_MAX_SECONDS,
  opAnswer,
  opAsk,
  opContract,
  opDecide,
  opPing,
  opPost,
  opPurge,
  opRead,
  opIdentify,
  opPlan,
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
  /**
   * D5. `help` WAS NOT AN OPERATION, AND SOMEBODY REACHED FOR IT.
   *
   * One `help error` row in the audit for the first cross-company session. An
   * agent looked for a help verb and got a refusal -- recoverable, because the
   * refusal lists `knownOps`, but a transport whose whole pitch is "one POST, no
   * docs to install" should answer the most obvious verb in it rather than
   * making the caller recover.
   *
   * It answers with the SHAPE of each op, not prose about the product: what it
   * does in one line, whether it writes to the shared record, and its argument
   * names. That is what an agent needs to make its next call, and it comes from
   * `lib/op-nature.ts` plus the live zod schemas -- so an op added without a
   * description fails loudly here instead of quietly appearing undocumented.
   */
  help: {
    schema: z.object({}),
    run: (_ctx: OpContext, _a: Record<string, never>) => Promise.resolve(describeOps()),
  },
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
  /**
   * Register a URL for this seat to be POSTed when the OTHER side writes. The
   * only operation that makes this service call outward; see `lib/webhooks.ts`
   * for the guard that surrounds it.
   */
  webhook: {
    schema: z.object({
      action: z.enum(["register", "remove", "status"]).optional(),
      url: z.string().max(2000).optional(),
      secret: z.string().min(8).max(200).optional(),
    }),
    run: opWebhook,
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
      // C3c. Both transports get the same schema, in the same commit, because a
      // capability that exists on one is a capability the other side cannot rely
      // on -- and `basis` is still MCP-invisible for exactly that reason.
      sections: z.record(z.string().min(1).max(200), z.string().max(100000).nullable()).optional(),
      ifUnchangedSince: z.string().max(64).optional(),
    }),
    run: opContract,
  },
  /**
   * D1's residue: the real cross-company room has both sides labelled "claude".
   * A side may name itself -- and only itself. Self-declared, never verified.
   */
  identify: {
    schema: z.object({
      label: z.string().min(1).max(60).optional(),
      agent: z.string().max(40).nullable().optional(),
      // S#281. Validated in `opIdentify` against a forge allow-list rather than
      // here, so both transports get the same refusal with the same reason.
      repo: z.string().max(300).nullable().optional(),
      repoRef: z.string().max(100).nullable().optional(),
    }),
    run: opIdentify,
  },
  /**
   * F1. One verb for one concept: no arguments reads the plan, `add` raises an
   * item, `set` changes one, `phase` moves the room. The far side's standing
   * complaint about this product was ceremony, so this is not four operations.
   */
  plan: {
    schema: z.object({
      add: z
        .object({
          title: z.string().min(1).max(200),
          note: z.string().max(20000).optional(),
          owner: z.union([z.enum(["a", "b", "both"]), z.null()]).optional(),
        })
        .optional(),
      set: z
        .object({
          id: z.string().min(1).max(40),
          title: z.string().min(1).max(200).optional(),
          note: z.string().max(20000).optional(),
          owner: z.union([z.enum(["a", "b", "both"]), z.null()]).optional(),
          state: z.enum(["open", "agreed", "dropped"]).optional(),
        })
        .optional(),
      phase: z.enum(["plan", "build"]).optional(),
    }),
    run: opPlan,
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

/**
 * The op table, described from itself. Argument names are read off the live zod
 * schemas rather than re-typed, because a hand-written argument list is a second
 * copy of the schema and would go stale the first time one changed.
 */
function describeOps() {
  return {
    transport: "flat",
    how: 'POST /api/rpc with `Authorization: Bearer <token>` and a JSON body `{"op": "<name>", ...args}`.',
    ops: OP_NAMES.filter((name) => name !== "help").map((name) => {
      const entry = OPS[name as keyof typeof OPS];
      const shape = (entry.schema as unknown as { shape?: Record<string, unknown> }).shape ?? {};
      const nature = OP_NATURE[name];
      return {
        op: name,
        // An op with no recorded nature is a bug, and saying so is better than
        // silently listing it with no summary -- absence and emptiness again.
        summary: nature?.summary ?? "UNDOCUMENTED — this op has no entry in lib/op-nature.ts.",
        writesToRecord: nature ? nature.writes : null,
        args: Object.keys(shape),
      };
    }),
    guidance:
      "If you are here to work rather than to browse: call `ping`. It returns everything waiting on " +
      "you in one round trip. `status` + `read` costs roughly eight times the bytes to learn the same thing.",
  };
}

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
