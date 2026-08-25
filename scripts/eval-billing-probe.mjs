/**
 * DOES UPSTASH BILL AN `EVAL` AS ONE COMMAND, OR AS ITS CONTENTS?
 *
 * TODO U1.B1 calls this the largest single lever in the product: if a Lua
 * script performing ten operations is billed as ONE command, the write path
 * collapses from six commands to one or two. If it is billed as ten, the
 * script buys latency and nothing else, and the whole idea is dead.
 *
 * WHAT IS ALREADY SETTLED, and it did not need this script:
 *
 *   PIPELINES ARE BILLED PER INNER COMMAND. Upstash says so in their own
 *   words -- "A pipeline collapses the round trips but keeps the command
 *   count: 7 SETBITs in one pipeline are still 7 billed commands."
 *   (upstash.com/blog/how-to-build-a-bloom-filter-on-upstash-redis-with-typescript)
 *
 *   So pipelining is a LATENCY tool here, never a cost one. Anything in U1
 *   that assumed otherwise is dead on arrival.
 *
 * WHY EVAL STILL NEEDS A HUMAN, and why this script does not answer it alone:
 *
 * Nothing in Upstash's pricing page, their pipeline docs or their Lua-scripting
 * post states how EVAL is metered. A web search returns a confident answer that
 * dissolves on reading: the sentence it quotes is about ATOMICITY ("the script
 * invocation is still one serialized command" -- i.e. other clients see it as
 * one), which is a statement about concurrency, not about the bill.
 *
 * And it cannot be measured from inside. `INFO` is free and reports
 * `total_commands_processed`, but that is REDIS's internal counter, not
 * Upstash's meter -- the meter lives at their HTTP proxy and its policy for
 * inner script operations is not observable from the database. A measurement
 * built on `INFO` would produce a confident WRONG answer, which is worse than
 * no answer, because it would be spent as evidence for rewriting the hot path.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * HOW TO GET THE ANSWER (Erik, ~5 minutes, needs the Upstash console)
 * ────────────────────────────────────────────────────────────────────────────
 *
 *   1. Open the Upstash console for this database and note the current
 *      command count for today (Usage / Commands).
 *   2. Run:  node scripts/eval-billing-probe.mjs --run
 *      It sends exactly 100 EVALs, each performing 10 writes to one scratch
 *      key, then deletes the key. Nothing else in the database is touched.
 *   3. Wait for the console to refresh, then read the delta.
 *
 *        delta ~= 100    -> EVAL is billed as ONE command. U1.B1 is a YES and
 *                           the write path is worth rewriting around it.
 *        delta ~= 1000   -> billed per inner operation. Lua buys atomicity and
 *                           latency only. Close U1.B1 and move to C1.
 *        anything else   -> report the number; do not round it to a story.
 *
 * The probe is deliberately 100 x 10 rather than 1 x 10: the two answers are
 * then 100 and 1000, which no rounding, no background traffic and no console
 * refresh delay can confuse. One run of ten would put the whole verdict inside
 * the noise of a single page load.
 *
 * IT REFUSES TO RUN WITHOUT `--run`, because it writes to the real database.
 */

import { readFileSync } from "node:fs";

const ITERATIONS = 100;
const OPS_PER_SCRIPT = 10;
const SCRATCH = "bridger:probe:eval-billing";

/** The two numbers this probe is designed to tell apart. */
const IF_BILLED_AS_ONE = ITERATIONS;
const IF_BILLED_PER_OP = ITERATIONS * OPS_PER_SCRIPT;

function env() {
  // .env.local is not loaded by node, and this script deliberately does not
  // depend on next/dotenv -- it must run standalone, from a clean shell.
  let url = process.env.UPSTASH_REDIS_REST_URL;
  let token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    try {
      for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
        const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
        if (!m) continue;
        // STRIP SURROUNDING QUOTES. `.env.local` in this repo stores both
        // values quoted, and `fetch` rejects a URL with a literal `"` in it --
        // which is how the first run of this probe failed, on the parse rather
        // than on anything it was measuring.
        const v = m[2].trim().replace(/^["']|["']$/g, "");
        if (m[1] === "UPSTASH_REDIS_REST_URL") url ??= v;
        if (m[1] === "UPSTASH_REDIS_REST_TOKEN") token ??= v;
      }
    } catch {
      /* no .env.local is a legitimate state; the check below reports it */
    }
  }
  return { url, token };
}

async function main() {
  if (!process.argv.includes("--run")) {
    console.log(`
  This probe WRITES TO THE REAL DATABASE. It will not run without --run.

    node scripts/eval-billing-probe.mjs --run

  Read the header of this file first: you need the Upstash console open, and
  the command count BEFORE and AFTER, or the run tells you nothing.

  It sends ${ITERATIONS} EVALs of ${OPS_PER_SCRIPT} writes each, to one scratch key
  (${SCRATCH}), and deletes it afterwards.

    delta ~= ${IF_BILLED_AS_ONE}   -> EVAL is billed as ONE command
    delta ~= ${IF_BILLED_PER_OP}  -> billed per inner operation
`);
    return;
  }

  const { url, token } = env();
  if (!url || !token) {
    console.error("  No UPSTASH_REDIS_REST_URL / _TOKEN in the environment or .env.local.");
    process.exit(1);
  }

  // Ten writes in one script. Deliberately trivial: the question is how the
  // invocation is METERED, so the script's content only has to be
  // unambiguously more than one operation.
  const lua = `
    for i = 1, ${OPS_PER_SCRIPT} do
      redis.call('SET', KEYS[1] .. ':' .. i, ARGV[1])
    end
    return ${OPS_PER_SCRIPT}
  `;

  const send = async (body) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json();
  };

  console.log(`
  Sending ${ITERATIONS} EVALs, ${OPS_PER_SCRIPT} writes each.
  Expect ${IF_BILLED_AS_ONE} billed commands if EVAL is one, ${IF_BILLED_PER_OP} if it is not.
`);

  const started = Date.now();
  for (let i = 0; i < ITERATIONS; i++) {
    await send(["EVAL", lua, "1", SCRATCH, "x"]);
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  // Clean up the scratch keys. These deletes ARE billed and they are not part
  // of the measurement -- so they are counted out loud rather than left for
  // whoever reads the console to wonder about.
  const keys = Array.from({ length: OPS_PER_SCRIPT }, (_, i) => `${SCRATCH}:${i + 1}`);
  await send(["DEL", ...keys]);

  console.log(`  Done in ${elapsed}s.

  ${ITERATIONS} EVAL calls were sent, plus 1 DEL to clean up.
  So the console delta should be ${IF_BILLED_AS_ONE} + 1 if EVAL bills as one,
  or ${IF_BILLED_PER_OP} + 1 if it bills per inner operation.

  Read the console now. Do not round the number to whichever story you expected.
`);
}

main().catch((e) => {
  console.error(`  Probe failed: ${e.message}`);
  process.exit(1);
});
