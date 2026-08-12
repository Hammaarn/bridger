/**
 * The gate both transports pass through.
 *
 * Bridger now answers on two surfaces — `/api/mcp` (JSON-RPC, for clients that
 * speak MCP) and `/api/rpc` (flat JSON, for the paste-and-go path). They share
 * the operations already (`lib/operations.ts`). This is the other half: the
 * kill switch, the budget, the deny vocabulary and the audit row, in one place,
 * so a caller cannot get a cheaper set of rules by choosing a different door.
 *
 * A second transport with its own gate would be a second security posture, and
 * the drift would be invisible until it mattered.
 */

import {
  authorize,
  writeAudit,
  DENY_MESSAGE,
  DENY_STATUS,
  TERMINAL_DENIALS,
  type DenyReason,
  type RoomRecord,
  type TokenRecord,
} from "./room-registry";
import { createStore, type Store } from "./store";

export type GateResult =
  | { ok: true; store: Store; room: RoomRecord; token: TokenRecord; now: Date }
  | { ok: false; reason: DenyReason; store: Store | null; now: Date };

/** Pull a bearer token out of the Authorization header, or null. */
export function bearerFrom(req: Request): string | null {
  const [scheme, raw] = req.headers.get("authorization")?.split(" ") ?? [];
  return scheme?.toLowerCase() === "bearer" ? (raw ?? null) : null;
}

/**
 * Authorise and CHARGE the request. Exactly one gate per request may charge —
 * see `AuthContext.charge`; charging twice halves every cap.
 */
export async function gate(req: Request): Promise<GateResult> {
  const store = createStore();
  const now = new Date();
  const outcome = await authorize(store, { presentedToken: bearerFrom(req), now });
  if (!outcome.ok) return { ok: false, reason: outcome.reason, store, now };
  return { ok: true, store: store as Store, room: outcome.room, token: outcome.token, now };
}

/**
 * The refusal body. Shaped for an AGENT, not a browser.
 *
 * `terminal` is the field that matters and it is why this is not just an HTTP
 * status: a looping agent reads any 4xx as "try again", and the whole reason
 * this project has a deny vocabulary is that a generic refusal buys one more
 * turn, forever.
 */
export function refusalBody(reason: DenyReason) {
  return {
    error: DENY_MESSAGE[reason],
    code: reason,
    terminal: TERMINAL_DENIALS.has(reason),
  };
}

export function refusalResponse(reason: DenyReason): Response {
  return Response.json(refusalBody(reason), { status: DENY_STATUS[reason] });
}

/** One audit row per request, on whichever transport. */
export async function auditRequest(
  store: Store | null,
  fields: {
    now: Date;
    token?: TokenRecord;
    room?: RoomRecord;
    tool: string;
    status: "ok" | "deny" | "error";
    reason?: string;
    durationMs?: number;
  },
): Promise<void> {
  await writeAudit(store, {
    ts: fields.now.toISOString(),
    tokenId: fields.token?.id ?? null,
    roomId: fields.room?.id ?? null,
    side: fields.token?.side ?? null,
    tool: fields.tool,
    status: fields.status,
    ...(fields.reason ? { reason: fields.reason } : {}),
    ...(fields.durationMs !== undefined ? { durationMs: fields.durationMs } : {}),
  });
}
