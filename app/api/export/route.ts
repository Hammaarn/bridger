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
import { authorize, writeAudit } from "@/lib/room-registry";
import { DENY_STATUS } from "@/lib/room-registry";
import { createStore } from "@/lib/store";

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
    return Response.json({ error: outcome.reason }, { status: DENY_STATUS[outcome.reason] });
  }

  const { room, token: tok } = outcome;
  const [entries, contract] = await Promise.all([
    readEntries(store!, room.id),
    getContract(store!, room.id),
  ]);

  await writeAudit(store, {
    ts: now.toISOString(),
    tokenId: tok.id,
    roomId: room.id,
    side: tok.side,
    tool: "export",
    status: "ok",
  });

  return Response.json({
    room: {
      id: room.id,
      topic: room.topic,
      createdAt: room.createdAt,
      you: { side: tok.side, ...room.sides[tok.side] },
      peer: { side: tok.side === "a" ? "b" : "a", ...room.sides[tok.side === "a" ? "b" : "a"] },
    },
    contract,
    entries,
    exportedAt: now.toISOString(),
  });
}
