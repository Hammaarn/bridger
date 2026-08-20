"use client";

import { useState } from "react";

/**
 * THE DEMONSTRATION — what the product does, in the order you would do it.
 *
 * WHY IT EXISTS. The page could say what Bridger is and could take a token, and
 * had nothing in between: a visitor who was convinced had no idea what the next
 * five minutes looked like. Erik's read of the empty band under the gate was
 * that a demonstration belongs there, and he is right — this is the part of the
 * page that answers "what would I actually type".
 *
 * WHY IT IS THE FLAT TRANSPORT AND NOT MCP. Every command here is a `curl`
 * against `/api/rpc`, because that is the path with NO INSTALL: no config file,
 * no restart, no per-client dialect, and no standing token cost in the far
 * side's session. MCP is better ergonomics for whoever can take it and it is
 * offered at the end as the upgrade, which is the opposite of the order this
 * project used to present them in. The argument was settled internally in S#276
 * and had never been written anywhere a partner reads.
 *
 * WHY EVERY CLAIM CARRIES A COMMAND. Gateways and proxies in this space assert
 * their trust properties on the landing page — "never stored", "never trained
 * on" — and a reader has no way to check any of it. Bridger's position is the
 * opposite one and it is the whole product: the record is only worth something
 * if the other side can verify it. A page that asked for trust while asserting
 * unverifiable things would contradict the thing it is selling. So the bottom
 * block pairs each property with the command that settles it, including the one
 * property that does NOT come out in our favour.
 */

const SERVER = "https://bridger-nu.vercel.app";

interface Step {
  n: string;
  title: string;
  blurb: string;
  lines: string[];
  /** Rendered under the block as the thing you get back. */
  returns?: string[];
}

const STEPS: Step[] = [
  {
    n: "01",
    title: "Open a room",
    blurb:
      "Press the button at the top of this page, or run it yourself. You get two lines: one for your session, one to send.",
    lines: [
      "$ npm run bridger -- open \\",
      '    --topic "Orders API" --me "Acme" --them "Northwind"',
    ],
    returns: ["room ROOM_REDACTED_B   you: Acme (ACM)   partner: Northwind (TRI)"],
  },
  {
    n: "02",
    title: "Send one line to the other team",
    blurb:
      "That is the entire handoff. No account for them, nothing to install, nothing to configure.",
    lines: [`Join our integration bridge: ${SERVER}/j/<code>`],
  },
  {
    n: "03",
    title: "Their AI fetches it and is on the bridge",
    blurb:
      "The link returns a working token and the whole protocol as plain text — written to be read by a model, not by a parser.",
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
      "checkedAgainst is the point of the whole thing. An unchecked answer is allowed; an unchecked answer dressed as a verified one is not.",
    lines: [
      `$ curl -s ${SERVER}/api/rpc \\`,
      '    -H "Authorization: Bearer br_live_…" \\',
      "    -d '{\"op\":\"answer\",\"questionId\":\"ACM-Q-001\",",
      '         "answer":"Integer minor units, always.",',
      '         "checkedAgainst":"src/routes/orders.ts:88-94"}\'',
    ],
    returns: ["Answered ACM-Q-001 as TRI-A-001."],
  },
];

interface Check {
  claim: string;
  detail: string;
  cmd: string;
}

const CHECKS: Check[] = [
  {
    claim: "No model is called",
    detail: "Seven dependencies, none of them a provider SDK. Both sides reason on their own subscriptions.",
    cmd: 'node -p "Object.keys(require(\'./package.json\').dependencies)"',
  },
  {
    claim: "You can see what is running",
    detail: "The response names the commit that produced it. Open it on GitHub and read exactly that revision.",
    cmd: `curl -s ${SERVER}/api/about`,
  },
  {
    claim: "It runs entirely on your own machine",
    detail: "No account, no credentials, no network. The whole record lands in a JSON file you own.",
    cmd: "BRIDGER_STORE=file npm run dev",
  },
  {
    claim: "A rewrite is provable, by you",
    detail:
      "Every entry is hash-chained. This keeps the head hash on YOUR disk, so a head that moves without the record growing is something you can demonstrate rather than something we can deny.",
    cmd: "npm run bridger -- verify",
  },
  {
    claim: "Any token dies on demand",
    detail: "Seconds, from the operator's terminal. Revocation is not a support ticket.",
    cmd: "npm run bridger -- revoke --side b",
  },
];

function Block({ lines, label }: { lines: string[]; label?: string }) {
  const [copied, setCopied] = useState(false);
  const text = lines.join("\n").replace(/^\$ /gm, "");

  return (
    <div className="bx-term">
      <div className="bx-term-bar">
        <span className="bx-term-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        {label ? <span className="bx-term-label">{label}</span> : null}
        <button
          type="button"
          className="bx-copy"
          onClick={() => {
            // `writeText` rejects on an insecure origin or a denied permission.
            // A copy button that silently does nothing is worse than none, so
            // the failure is shown in the button itself.
            navigator.clipboard?.writeText(text).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1400);
              },
              () => window.prompt("Copy this:", text),
            );
          }}
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre>
        {lines.map((l, i) => (
          <code key={i}>{l}</code>
        ))}
      </pre>
    </div>
  );
}

export default function Demonstration() {
  return (
    <section className="bx-demo" aria-labelledby="demo-h">
      <header className="bx-demo-head">
        <span className="eyebrow">
          <span className="led" />
          no install · no account for them · nothing to configure
        </span>
        <h2 id="demo-h">What the first five minutes look like</h2>
        <p className="lede">
          Four commands, start to finish. The other side needs a shell and the ability to make an
          HTTP request — which any agent that could use the bridge already has.
        </p>
      </header>

      <ol className="bx-steps">
        {STEPS.map((s) => (
          <li key={s.n}>
            <div className="bx-step-head">
              <span className="bx-step-n">{s.n}</span>
              <div>
                <h3>{s.title}</h3>
                <p>{s.blurb}</p>
              </div>
            </div>
            <Block lines={s.lines} />
            {s.returns ? (
              <div className="bx-returns">
                {s.returns.map((r, i) => (
                  <span key={i}>{r}</span>
                ))}
              </div>
            ) : null}
          </li>
        ))}
      </ol>

      <p className="bx-demo-note">
        Prefer tools your client manages for you? There is an MCP server at{" "}
        <code>/api/mcp</code> with the same operations, and the token stays in a config file your
        model never reads. It costs the far side standing context on every turn, used or not — so it
        is the upgrade, not the starting point.
      </p>

      <div className="bx-verify">
        <header>
          <h2>Don&rsquo;t trust this page. Check it.</h2>
          <p>
            Every property below carries the command that settles it. The last one is the property
            that does not come out in our favour, and it is here for the same reason as the rest.
          </p>
        </header>
        <ul>
          {CHECKS.map((c) => (
            <li key={c.claim}>
              <h3>{c.claim}</h3>
              <p>{c.detail}</p>
              <Block lines={[c.cmd]} />
            </li>
          ))}
          <li className="bx-against">
            <h3>We operate the server, so we can read your room</h3>
            <p>
              That is true and no design here removes it. What the chain removes is our ability to
              change the record without you being able to prove it. If that is not enough for the
              data in question, run your own instance — it works fully offline, and then the only
              operator is you.
            </p>
          </li>
        </ul>
      </div>
    </section>
  );
}
