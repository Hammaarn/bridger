/**
 * "HAS ANYTHING HAPPENED?" — THE CHEAPEST QUESTION IN THE PRODUCT. (S#281, C3b)
 *
 * A listener asks this all night and the answer is almost always no. Every
 * other route answers it as a side effect of doing something bigger, and pays
 * for the bigger thing: `wait` spends ~16 Redis commands on a 45-second call
 * (six fixed, ten polling the seq counter while it blocks) and `status` spends
 * six for a payload the listener throws away.
 *
 * This route exists to answer that one question for **two commands**, and its
 * design is mostly a list of what it deliberately does NOT do.
 *
 * ── THE ARITHMETIC, WHICH IS THE WHOLE JUSTIFICATION ─────────────────────
 *
 * One side, listening for eight hours, in Redis commands:
 *
 *     server long-poll, 45s waits (today) ......... 10,240
 *     server long-poll, 300s waits (if allowed) ....  4,608
 *     local sleep 60s, hitting /api/rpc ............  2,880
 *     local sleep 60s, hitting THIS ................    960
 *
 * Against a free tier of 500,000 commands a month, that is the difference
 * between one room's overnight listener costing 2% of the month and costing 20%.
 *
 * ── AND IT CORRECTS AN EARLIER CLAIM OF OURS ─────────────────────────────
 *
 * S#281b recorded that a daemon sleeping locally and polling is WORSE for the
 * database than one holding a long server-side wait. That was true for the
 * 30-second interval it happened to test and false as a general statement: the
 * crossover sits near 45-50 seconds, because a local sleep costs ZERO commands
 * while server-side blocking spends one every few seconds. Past that interval,
 * sleeping wins — and with a purpose-built endpoint it wins by 10x.
 *
 * ── WHAT IT DOES NOT DO, AND WHY EACH OMISSION IS SAFE ───────────────────
 *
 *  - **No audit row.** `writeAudit` is 2-5 commands. A poll that learns nothing
 *    is not an event worth a line; the calls that MATTER (`read`, `post`,
 *    `answer`) are all still logged, so the audit still answers "what happened
 *    in this room" — it just stops recording "somebody asked and the answer was
 *    no" ten thousand times a night.
 *  - **No op-trail, no idle streak, no room-activity tally.** Those exist to
 *    advise an AGENT that is looping. A daemon is not looping by mistake; it is
 *    doing its job, and advising it would be noise it cannot act on.
 *  - **No daily counters.** Deliberate, and bounded another way — see below.
 *  - **No entries.** It returns a NUMBER. Learning that something changed is a
 *    different question from reading it, and fusing them would make the common
 *    case (nothing changed) pay for the rare one.
 *
 * ── HOW A RUNAWAY IS STILL BOUNDED ───────────────────────────────────────
 *
 * Skipping the daily cap would be reckless on any other route. Here the bound
 * is a much TIGHTER per-minute ceiling instead: `SINCE_RATE_PER_MINUTE`. A
 * listener that respects it costs ~960 commands a night; one that ignores it is
 * refused rather than served, and the worst a stuck client can spend is that
 * ceiling times two commands.
 *
 * That is a deliberate trade of one bound for another: the daily cap protects
 * the CALLER's model quota, which a daemon does not have — it burns no tokens
 * at all, which is the entire point of C3b.
 */

import { NextRequest } from "next/server";

import { authorize, DENY_MESSAGE, DENY_STATUS } from "@/lib/room-registry";
import { refusalHeaders } from "@/lib/http-gate";
import { SEQ_KEY, createStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Polls per minute allowed on this route.
 *
 * Four, not twenty. This endpoint is FOR patient listeners, and saying so in
 * the limit is more honest than allowing an interactive rate on a route whose
 * whole argument is that its caller can wait. One poll every fifteen seconds is
 * far more than a background listener needs and far less than a loop can spend.
 */
export const SINCE_RATE_PER_MINUTE = 4;

/** The interval a well-behaved listener should use. Advertised in the reply. */
export const SINCE_SUGGESTED_INTERVAL_SECONDS = 60;

function bearer(req: NextRequest): string | null {
  const h = req.headers.get("authorization");
  if (!h?.toLowerCase().startsWith("bearer ")) return null;
  const t = h.slice(7).trim();
  return t || null;
}

export async function GET(req: NextRequest) {
  const now = new Date();
  const store = createStore();

  const outcome = await authorize(store, {
    presentedToken: bearer(req),
    now,
    // Charged, because an uncharged endpoint is an unbounded one — but see
    // `SINCE_RATE_PER_MINUTE`: the ceiling this route is held to is its own.
    charge: true,
    rateCeiling: SINCE_RATE_PER_MINUTE,
    // The expensive bookkeeping is skipped. This is the flag that makes the
    // route cost two commands instead of six.
    minimal: true,
  });

  if (!outcome.ok) {
    return Response.json(
      { error: DENY_MESSAGE[outcome.reason], code: outcome.reason },
      { status: DENY_STATUS[outcome.reason], headers: refusalHeaders(outcome.reason, now) },
    );
  }

  const { room } = outcome;
  const since = Number(new URL(req.url).searchParams.get("seq") ?? 0);
  const latest = Number((await store!.get(SEQ_KEY(room.id))) ?? 0);

  /**
   * 204 when nothing changed, and the empty body is the point.
   *
   * It is the common answer by a wide margin — a listener asks all night and
   * hears "no" almost every time — so it is the one that must cost the least,
   * in commands, in bytes and in the caller's attention. A JSON body saying
   * `{"changed": false}` would be ~20 bytes of nothing, ten thousand times.
   */
  if (!Number.isFinite(since) || latest <= since) {
    return new Response(null, {
      status: 204,
      headers: {
        "X-Bridger-Seq": String(latest),
        "X-Bridger-Poll-Seconds": String(SINCE_SUGGESTED_INTERVAL_SECONDS),
      },
    });
  }

  return Response.json(
    {
      changed: true,
      latestSeq: latest,
      since,
      // Named rather than implied: this route says THAT something changed, and
      // nothing about what. Reading it is a separate, deliberate call.
      next: "Call `read` with this `since` to fetch what is new.",
    },
    { status: 200, headers: { "X-Bridger-Seq": String(latest) } },
  );
}
