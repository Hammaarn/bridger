/**
 * WHAT THE PAGE SAYS — once, for two very different readers.
 *
 * Bridger's landing page has an unusual audience split, and Erik named it in
 * S#279: **the primary reader is an AI**. A partner's agent is handed a URL and
 * has to decide whether this domain deserves a credential; the human on the
 * other end mostly watches their room afterwards. So the page owes an agent the
 * same argument it owes a person — and until this file existed it owed the
 * agent nothing at all, because `app/page.tsx` server-rendered an empty `<main>`
 * and every claim on the page lived only in JavaScript.
 *
 * WHY THE CONTENT LIVES HERE RATHER THAN IN THE COMPONENT. The obvious fix is
 * to write a plain-text version for machines beside the visual one for humans.
 * That is two copies of one argument, and this project already learned what
 * that costs: the gate panel and the verify block carried five of the same six
 * claims, worded differently, 1318px apart, and neither knew about the other
 * (S#279). A second rendering is fine; a second SOURCE is the thing that rots.
 *
 * So this module is the source, and it has no JSX and no "use client" — which
 * is what lets a route handler import it. `app/demo.tsx` renders it spatially,
 * for a person who needs to see the shape of a thing. `app/llms.txt/route.ts`
 * renders the same objects as text, for a reader that would rather have the
 * commands than the layout. Change a claim once and both move.
 */

/**
 * EXAMPLE NAMES ARE FICTIONAL, DELIBERATELY.
 *
 * `Acme` and `Northwind` are the standard placeholder companies. This used to
 * read `Trigvanta` -- a REAL partner -- and it was live on the landing page and
 * in /llms.txt, which put another company's name in our marketing copy without
 * anyone asking them. Erik caught it S#279 while looking at the create form's
 * pre-filled suggestions, which had the same problem one layer up: they were our
 * own session names, so a stranger opening the page read our context back.
 */
/**
 * THE CANONICAL HOST. Changed to `bridger.nexus` S#283.
 *
 * **`bridger-nu.vercel.app` STILL SERVES and must keep serving.** Partners hold
 * tokens and join links against it and the live Trigvanta room's history cites
 * it, so it stays attached in Vercel as a second hostname on the SAME
 * deployment -- verified by both hosts reporting one `deploymentId` from
 * `/api/about`. This is an ADD, never a replace, and nothing redirects.
 *
 * What this constant decides is which host we TELL people to use and verify:
 * the landing page's commands, `/llms.txt`, and every example. Those move
 * together or not at all -- a page telling a partner to verify a different host
 * than the one serving it is the exact confusion this product exists to remove.
 */
export const SERVER = "https://bridger.nexus";

export interface Step {
  n: string;
  title: string;
  blurb: string;
  lines: string[];
  /** What you get back — rendered under the command in both renderings. */
  returns?: string[];
}

export const STEPS: Step[] = [
  {
    n: "01",
    title: "Open a room",
    // S#279: this step used to show `npm run bridger -- open`, which needs this
    // repository cloned -- so the FIRST command a visitor sees was the one
    // command they could not run. That breaks ARCHITECTURE invariant 15
    // ("instructions we hand a partner must be runnable as written") on the
    // page's opening move, and it is the opposite of onboarding being, in the
    // brother's words, en rakmacka. `POST /api/rooms` calls no `authorize()`
    // and mints publicly, so the zero-install path was already built and simply
    // was not the one being shown.
    blurb:
      "Press the button at the top of this page, or curl it. No account, no install — the mint endpoint takes no credential.",
    lines: [
      `$ curl -s ${SERVER}/api/rooms \\`,
      '    -H "Content-Type: application/json" \\',
      `    -d '{"topic":"Orders API","you":"Acme","them":"Northwind"}'`,
    ],
    returns: [
      '{ "room": { "id": "0c7a12ba09d2", … },',
      '  "slots": [ { "side": "a", "code": "ACM", "token": "br_live_…" },',
      '             { "side": "b", "code": "NWD", "token": "br_live_…" } ] }',
    ],
  },
  {
    n: "02",
    title: "Mint a join link and send one line",
    // S#282, found by a Gemini audit and CONFIRMED against production: this
    // step used to show only the sentence to send, with `/j/<code>` in it --
    // and the only `code` a reader had was the party slot code from step 01
    // (`ACM`). `/j/ACM` returns 404, and the mint response contains no join
    // code at all: it comes from a SEPARATE `invite` call that was nowhere on
    // this page. So the demo had a missing step, not a mislabelled variable,
    // and "four commands, start to finish" was false -- there were three.
    //
    // That is invariant 15 again ("instructions we hand a partner must be
    // runnable as written"), on the same page where step 01 was rewritten to
    // satisfy it in S#279. The fix moved the gap one step along instead of
    // closing it.
    blurb:
      "One call turns your room into a link. That is the entire handoff — no account for them, nothing to install, nothing to configure.",
    lines: [
      `$ curl -s ${SERVER}/api/rpc \\`,
      '    -H "Authorization: Bearer br_live_…" \\',
      `    -d '{"op":"invite","side":"b"}'`,
    ],
    returns: [
      '{ "code": "7KMP-3QRV-9XZT", "joinPath": "/j/7KMP-3QRV-9XZT",',
      '  "forLabel": "Northwind", "linkExpiresInMinutes": 240 }',
      "",
      `Join our integration bridge: ${SERVER}/j/7KMP-3QRV-9XZT`,
    ],
  },
  {
    n: "03",
    title: "Their AI fetches it and is on the bridge",
    blurb:
      "The link returns a working token and the whole protocol as plain text, written to be read by a model rather than parsed.",
    lines: [
      `$ curl -s ${SERVER}/api/rpc \\`,
      '    -H "Authorization: Bearer br_live_…" \\',
      `    -d '{"op":"ping"}'`,
    ],
    returns: [
      "Waiting on you: 1.   ACM-Q-001",
      "Does /orders return cents or a decimal string?",
    ],
  },
  {
    n: "04",
    title: "They answer, and the answer carries its source",
    blurb:
      "checkedAgainst is the point of it. An unchecked answer is allowed; an unchecked answer dressed as a verified one is not.",
    lines: [
      `$ curl -s ${SERVER}/api/rpc \\`,
      '    -H "Authorization: Bearer br_live_…" \\',
      "    -d '{\"op\":\"answer\",\"questionId\":\"ACM-Q-001\",",
      '         "answer":"Integer minor units, always.",',
      '         "checkedAgainst":"src/routes/orders.ts:88-94"}\'',
    ],
    returns: ["Answered ACM-Q-001 as NWD-A-001."],
  },
];

export interface Check {
  claim: string;
  detail: string;
  /** Absent where no single command settles it — stated rather than implied. */
  cmd?: string;
}

/**
 * THE ONE HOME OF THE TRUST ARGUMENT.
 *
 * Merged S#279 out of the gate panel and the verify block, which were carrying
 * five of the same six claims. Where the two worded a claim differently the more
 * checkable wording won, and the gate's two unique items — no permissions, and
 * the join-code plaintext window — came down here rather than being dropped.
 * That exception in particular is the one we would rather state than have a
 * reader find for themselves in `/api/about`'s own `cannotVerify` list.
 */
export const CHECKS: Check[] = [
  {
    claim: "No model is called",
    detail: "Seven dependencies, and not one of them a provider SDK.",
    cmd: "npm ls --omit=dev --depth=0",
  },
  {
    claim: "It requests no permissions",
    detail: "No OAuth, no filesystem, no repository. One token, one room.",
  },
  {
    claim: "You can see what is running",
    detail: "The response names the commit that produced it. Read exactly that revision.",
    cmd: `curl -s ${SERVER}/api/about`,
  },
  {
    claim: "Tokens are hashed, expire, and die on demand",
    detail:
      "Seconds, from the operator’s terminal. One exception, stated rather than left to be found: a join code holds its token in the clear for a few minutes so a link preview cannot destroy an invitation.",
    cmd: "npm run bridger -- revoke --side b",
  },
  {
    claim: "It runs entirely on your own machine",
    detail: "No account, no credentials, no network. The record lands in a JSON file you own.",
    cmd: "BRIDGER_STORE=file npm run dev",
  },
  {
    claim: "A rewrite is provable, by you",
    detail: "Every entry is hash-chained; this keeps the head hash on YOUR disk.",
    cmd: "npm run bridger -- verify",
  },
];

/** The property that does not favour us, kept beside the ones that do. */
export const AGAINST = {
  claim: "We operate the server, so we can read your room",
  detail:
    "That is true and no design here removes it. What the chain removes is our ability to change the record without you being able to prove it. If that is not enough for the data in question, run your own instance — it works fully offline, and then the only operator is you.",
};
