/**
 * Seed a local file-backed bridge with a realistic-looking record.
 *
 * For LOOKING AT THE UI, which is the only way a visible surface gets verified
 * — a string check on served HTML once reported success while this very page
 * shipped completely unstyled (ARCHITECTURE #1, #2).
 *
 * Run:  BRIDGER_STORE=file npx tsx scripts/seed-demo.ts
 * Then: BRIDGER_STORE=file npm run dev   and paste the printed token.
 *
 * Writes only to the local file store. It refuses to run against Upstash, so
 * it cannot dirty a real bridge.
 */

import { createStore } from "../lib/store";
import { authorize, createRoom } from "../lib/room-registry";
import { appendEntry, setContract } from "../lib/entries";
import { opReopen, opSignoff } from "../lib/operations";

if (process.env.BRIDGER_STORE !== "file") {
  console.error("\n  Refusing to run: set BRIDGER_STORE=file. This is a demo seeder.\n");
  process.exit(1);
}

const store = createStore();
if (!store) {
  console.error("no store");
  process.exit(1);
}

const at = (mins: number) => new Date(Date.now() - mins * 60_000);

async function main() {
  const { room, ownerToken, peerToken } = await createRoom(store!, {
    topic: "JudgeMySite × Trigvanta — live review API",
    ownerLabel: "JudgeMySite",
    peerLabel: "Trigvanta",
    now: at(600),
  });

  const a = await authorize(store!, { presentedToken: ownerToken, now: at(600) });
  const b = await authorize(store!, { presentedToken: peerToken, now: at(600) });
  if (!a.ok || !b.ok) throw new Error("auth failed");
  const jms = a.token;
  const tri = b.token;

  const ctx = (token: typeof jms, mins: number) => ({ store: store!, room, token, now: at(mins) });

  // A settled exchange, with provenance.
  const q1 = await appendEntry(
    store!,
    room,
    tri,
    {
      type: "question",
      title: "What exactly is in the `verdict` SSE payload?",
      body: "We are building the renderer against it and do not want to guess the field names.",
    },
    at(540),
  );
  await appendEntry(
    store!,
    room,
    jms,
    {
      type: "answer",
      title: "grade, judge, url, requestId, findings (CONFIRMED-ONLY), unchecked, unverified, commendations, summary, verdict, oneLiner, meta",
      body: "grade, judge, url, requestId, findings (CONFIRMED-ONLY), unchecked, unverified, commendations, summary, verdict, oneLiner, meta. Byte-compatible with POST /api/external/review, so your existing renderer needs no new code.",
      answers: q1.id,
      checkedAgainst: "app/api/external/live-review/route.ts:876-910",
    },
    at(520),
  );

  // An answer that did not land — reopened by the asker.
  const q2 = await appendEntry(
    store!,
    room,
    tri,
    {
      type: "question",
      title: "Does `done` mean the review succeeded?",
      body: "We key our UI off it.",
    },
    at(300),
  );
  await appendEntry(
    store!,
    room,
    jms,
    {
      type: "answer",
      title: "It fires at the end of every run.",
      body: "It fires at the end of every run.",
      answers: q2.id,
    },
    at(280),
  );
  await opReopen(ctx(tri, 200), {
    questionId: q2.id,
    why: "That is not what we asked. Does `done` after an `error` frame mean success or not? We need to know whether to render a report.",
  });

  // An unchecked answer — the thing the header counts.
  const q3 = await appendEntry(
    store!,
    room,
    jms,
    { type: "question", title: "What share of your customers sit behind a WAF?", body: "" },
    at(180),
  );
  await appendEntry(
    store!,
    room,
    tri,
    {
      type: "answer",
      title: "Roughly a third, we think — not measured yet.",
      body: "Roughly a third, we think — not measured yet.",
      answers: q3.id,
    },
    at(170),
  );

  await appendEntry(
    store!,
    room,
    jms,
    {
      type: "decision",
      title: "Narration-only feed for v1; the full capture comes later",
      body: "Ship `say` + `scrollTo` + `nav`. `anchorId` stays opaque for now.",
      why: "Three of the four target forms already transfer to a consumer not running our player, so narration is nearly free and dodges the egress question entirely.",
    },
    at(120),
  );

  await setContract(
    store!,
    room,
    jms,
    "protocol: 1\nevents: run, beat, phase, verdict, done, error\nid: monotonic SSE frame index\nretry: sent before the first event",
    "first cut of the wire contract",
    at(100),
  );
  await setContract(
    store!,
    room,
    jms,
    "protocol: 1\nevents: run, beat, phase, verdict, done, error\nid: monotonic SSE frame index\nretry: sent before the first event\nheartbeat: ': hb <epoch_ms>' comment lines",
    "documented the heartbeat",
    at(90),
  );

  await appendEntry(
    store!,
    room,
    tri,
    {
      type: "note",
      title: "Our staging renderer is up",
      body: "Pointed at the preview URL, not production.",
      checkedAgainst: "commit 4f2a91c",
    },
    at(60),
  );

  await opSignoff(ctx(tri, 25), { note: "back tomorrow morning CET" });

  console.log(`
  Seeded a local bridge.

  Topic : ${room.topic}
  Room  : ${room.id}

  Paste this into the page (it is the VIEWER's side, side A):

      ${ownerToken}

  Start the server with:  BRIDGER_STORE=file npm run dev
`);
}

void main();
