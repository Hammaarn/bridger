/**
 * WHOAMI — "did this token work, and who am I on this bridge?"
 *
 * The last piece of the join story (D3, greenlit S#272). A partner handed a
 * token has, until now, had exactly one way to find out whether it works: make
 * a real call and see what happens. That is a bad first contact — it costs them
 * a turn, and a failure at that moment reads as "this product is broken" rather
 * than "this string is stale".
 *
 * WHY IT LEAKS NOTHING
 * --------------------
 * It answers only for a valid token and refuses opaquely otherwise. The
 * asymmetry is the design:
 *
 *   - A prober WITHOUT a valid token learns nothing. Every refusal is the same
 *     status and the same sentence, so it cannot distinguish "no such room"
 *     from "revoked" from "wrong bridge", and the endpoint is useless for
 *     enumeration.
 *   - A prober WITH a valid token already holds everything this returns. Room,
 *     side, label, role are all visible from its first real call. Withholding
 *     them costs an honest partner a round trip and an attacker nothing.
 *
 * The refusal shapes live in `lib/whoami.ts` so that indistinguishability is
 * something a test asserts rather than something this comment claims.
 *
 * NO BUDGET, NO IDLE STREAK. This is a connectivity check, not participation:
 * it reads no entries and moves no cursor, so a partner may call it at setup
 * without it counting against the daily cap or nudging the brake. It is
 * deliberately the one authenticated call that is free — the alternative is a
 * partner afraid to check whether their own token works.
 *
 * It is audited precisely BECAUSE it is free: a burst of whoami denials is the
 * signature of probing, and "who called what" must stay answerable afterwards.
 */

import { authorize, writeAudit, DENY_STATUS } from "@/lib/room-registry";
import { createStore } from "@/lib/store";
import { whoamiBody, whoamiRefusal } from "@/lib/whoami";

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
    // The real reason is recorded for the OPERATOR and never returned to the
    // caller. This is the one place the two audiences deliberately differ.
    await writeAudit(store, {
      ts: now.toISOString(),
      tokenId: null,
      roomId: null,
      side: null,
      tool: "whoami",
      status: "deny",
      reason: outcome.reason,
    });
    const refusal = whoamiRefusal(outcome.reason, DENY_STATUS["bridge-disabled"]);
    return Response.json(refusal.body, { status: refusal.status });
  }

  const { room, token: tok } = outcome;
  await writeAudit(store, {
    ts: now.toISOString(),
    tokenId: tok.id,
    roomId: room.id,
    side: tok.side,
    tool: "whoami",
    status: "ok",
  });

  return Response.json(whoamiBody(room, tok));
}
