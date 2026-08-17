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
  markJoined,
  retryAfterSeconds,
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

  /**
   * MARK THE SIDE AS JOINED HERE, because this is the seam both transports pass
   * through (S#276).
   *
   * It used to be called only from the MCP route's own auth, so a partner who
   * joined by the PASTE path — the zero-install one we actively recommend —
   * could read, write, ask and answer while `joinedAt` stayed null forever.
   * Every surface that reports connection state then lied in the same
   * direction: the UI badge, the CLI's "(has NOT connected yet)",
   * `status.peer.joined`, and `/api/whoami`.
   *
   * Found by running it. The header of this file already warned that a second
   * transport with its own gate would drift invisibly; the gate was shared and
   * this was left behind, so the drift happened one layer up.
   *
   * Cheap: `markJoined` early-returns once the side is marked, so this is one
   * extra write per side per room, ever.
   */
  const room = await markJoined(store as Store, outcome.room, outcome.token.side, now);

  return { ok: true, store: store as Store, room, token: outcome.token, now };
}

/**
 * The refusal body. Shaped for an AGENT, not a browser.
 *
 * `terminal` is the field that matters MOST, but S#276 corrected the belief
 * that it was therefore the only thing that mattered: a looping agent reads any
 * 4xx as "try again", and its HTTP client acts on the STATUS CODE before the
 * model ever sees this body. So the status has to agree with `terminal` — see
 * the invariant on `DENY_STATUS` — and this field is the explanation, not the
 * whole defence.
 */
export function refusalBody(reason: DenyReason) {
  return {
    error: DENY_MESSAGE[reason],
    code: reason,
    terminal: TERMINAL_DENIALS.has(reason),
  };
}

/**
 * Headers that must ride with a refusal.
 *
 * Any status that invites a retry has to say WHEN, or a naive client picks its
 * own interval and hammers. Exported so both transports use one answer.
 */
export function refusalHeaders(reason: DenyReason, now: Date): Record<string, string> {
  const secs = retryAfterSeconds(reason, now);
  return secs === null ? {} : { "Retry-After": String(secs) };
}

/**
 * HTTP status for an `OperationRefused` — the refusals raised by the operations
 * themselves (viewer gate, idle brake, wrong-side reopen, bad question id)
 * rather than by the gate.
 *
 * EXPORTED SO IT CAN BE TESTED. It lived inline in the flat transport's catch
 * block and was inverted there for the whole life of the project: terminal
 * refusals got 429 and recoverable ones got 403. Nothing caught it because
 * nothing could reach it — a rule that only exists inside a route handler is a
 * rule with no test, which is the same shape as `question-state.ts`.
 *
 * 429 is deliberately unreachable from here. The only genuinely time-based
 * refusal is the per-minute limiter, which lives in the gate and says when.
 */
export function operationRefusalStatus(terminal: boolean): number {
  return terminal ? 403 : 400;
}

export function refusalResponse(reason: DenyReason, now: Date = new Date()): Response {
  return Response.json(refusalBody(reason), {
    status: DENY_STATUS[reason],
    headers: refusalHeaders(reason, now),
  });
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
