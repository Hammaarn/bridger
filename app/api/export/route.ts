/**
 * Export the room to the caller's local `bridger/` folder.
 *
 * WHY THIS IS NOT AN MCP TOOL
 * ---------------------------
 * Writing files on the caller's disk is the CLI's job, not the agent's. The
 * agent reads the bridge through MCP tools; the human runs `bridger pull` to
 * materialise the permanent record. Keeping them separate means the local
 * folder only ever changes when a person asks for it.
 *
 * WHY IT IS BEARER-AUTHED RATHER THAN REDIS-BACKED
 * ------------------------------------------------
 * Your partner has a room token and nothing else — no database credentials, no
 * account, no repo access. If `pull` needed registry access, only the operator
 * could ever hold a copy of the record, which defeats the point of both sides
 * owning it. Same token, same authorisation path as the MCP endpoint.
 */

import { getContract, readEntries } from "@/lib/entries";
import { verifyChain, type ChainedEntry } from "@/lib/chain";
import { authorize, otherSide, readPlan, seat, seatsFor, writeAudit } from "@/lib/room-registry";
import { refusalResponse } from "@/lib/http-gate";
import { createStore } from "@/lib/store";
import { readiness } from "@/lib/plan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const store = createStore();
  const now = new Date();

  const header = req.headers.get("authorization");
  const [scheme, token] = header?.split(" ") ?? [];
  const presented = scheme?.toLowerCase() === "bearer" ? token : null;

  const outcome = await authorize(store, { presentedToken: presented ?? null, now });
  if (!outcome.ok) {
    await writeAudit(store, {
      ts: now.toISOString(),
      tokenId: null,
      roomId: null,
      side: null,
      tool: "export",
      status: "deny",
      reason: outcome.reason,
    });
    // THE ONE ROUTE THAT HAND-ROLLED ITS REFUSAL, found S#280 by a real user.
    //
    // Erik's friend watched a room and got `daily-cap` on screen -- the raw
    // machine CODE, with no message, no `terminal` flag and no `Retry-After`,
    // because this line built its own body while `/api/rpc` and `/api/rooms`
    // both use the shared one. So the human saw an identifier instead of the
    // sentence the product wrote for exactly that moment, and the browser had
    // to infer "do not retry" from the status code alone.
    //
    // Same shape as the mint route's 429-with-terminal:true (TODO A8): a route
    // that answers refusals in its own words drifts from the contract every
    // other route keeps.
    return refusalResponse(outcome.reason, now);
  }

  const { room, token: tok } = outcome;
  const [entries, contract, plan] = await Promise.all([
    readEntries(store!, room.id),
    getContract(store!, room.id),
    readPlan(store!, room.id),
  ]);

  await writeAudit(store, {
    ts: now.toISOString(),
    tokenId: tok.id,
    roomId: room.id,
    side: tok.side,
    tool: "export",
    status: "ok",
  });

  // The chain verdict travels WITH the record, so a caller never has to know
  // that verification exists to benefit from it. It is computed here from the
  // entries actually being served, not from a stored summary — a cached "ok"
  // would survive the very edit it is supposed to catch.
  const chain = verifyChain(entries as ChainedEntry[]);

  return Response.json({
    room: {
      id: room.id,
      topic: room.topic,
      createdAt: room.createdAt,
      you: { side: tok.side, ...seat(room, tok.side) },
      // Singular, and kept: `peer` is correct in a trust room and a partner may
      // already read it. `seats` below is the additive answer for rooms that
      // have more than two.
      peer: { side: otherSide(tok.side), ...seat(room, otherSide(tok.side)) },
      seats: seatsFor(room).map((id) => ({
        side: id,
        ...seat(room, id),
        you: id === tok.side,
      })),
      kind: room.kind,
      phase: room.phase,
    },
    contract,
    // F1. The board a watcher sees. Read-only here like everything on this
    // route -- the plan is written through the tools, same single write path as
    // every other part of the record.
    plan: { items: plan.items, readiness: readiness(plan) },
    entries,
    chain,
    exportedAt: now.toISOString(),
  });
}
