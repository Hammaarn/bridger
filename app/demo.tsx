"use client";

import { useState } from "react";

import LetterGlitch from "@/app/backgrounds/letter-glitch";
import { AGAINST, CHECKS, STEPS } from "@/lib/site-content";

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
 * project used to present them in.
 *
 * WHY EVERY CLAIM CARRIES A COMMAND. Gateways and proxies in this space assert
 * their trust properties on the landing page — "never stored", "never trained
 * on" — and a reader has no way to check any of it. Bridger's position is the
 * opposite one and it is the whole product: the record is only worth something
 * if the other side can verify it.
 *
 * ── S#279, and the reason this file changed shape ────────────────────────
 *
 * Erik's brother, a UI/UX designer, was asked to roast the page: it is TOO
 * SPREAD, and the steps / information / verification modules want compacting.
 * Measured before touching anything, `.bx-demo` was **1854px at a 1600px
 * viewport — 52% of the whole page**. Two things were making it that, and only
 * one of them was styling:
 *
 * 1. THE PAGE ARGUED THE SAME CASE TWICE. The gate's trust panel and the verify
 *    block shared FIVE of six claims — "no model is called", "runs offline",
 *    "a rewrite is provable", "tokens die on demand", "we can read your room" —
 *    once as prose at the top and again with commands 1318px further down.
 *    Shrinking each block separately would have kept the duplication and just
 *    made it smaller. So `lib/site-content.ts` is now the ONE home of that
 *    argument, and the gate keeps a short answer plus a link to it. The content
 *    left this file entirely in the same session, once it turned out an AGENT
 *    was the page's primary reader and needed the same claims as plain text.
 *
 * 2. THE CHROME OUTWEIGHED THE CONTENT. `Block` draws a terminal frame — dots
 *    bar, copy button, ~50px — and it was used NINE times. Every verify command
 *    is a SINGLE LINE, so there the frame was about half the height and carried
 *    no information. One-liners now use `Cmd`, which is a line with a copy
 *    affordance and nothing else. The full frame is kept for the multi-line
 *    step commands, where the dots earn their place by saying "this is a shell".
 *
 * The steps became an accordion because they are SEQUENTIAL: a reader needs 01
 * to start and can pull the rest when they get there. The checks deliberately
 * did NOT, and that is not an oversight — that block works because six checkable
 * claims, including the one that counts against us, are visible AT ONCE. Behind
 * a click it would read as "there are some claims", which is the failure it was
 * built to avoid.
 */

/** Shared by both command shapes, so a copy failure behaves the same in each. */
function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    // `writeText` rejects on an insecure origin or a denied permission. A copy
    // button that silently does nothing is worse than none, so the failure is
    // shown in the button itself.
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      },
      () => window.prompt("Copy this:", text),
    );
  };
  return { copied, copy };
}

/**
 * A ONE-LINE COMMAND, and nothing around it.
 *
 * The terminal frame exists to say "this is a shell", which a reader needs once
 * and not nine times. For a single line it was ~50px of chrome on ~34px of
 * content. This is the line, a monospace face, and a copy affordance.
 */
function Cmd({ cmd }: { cmd: string }) {
  const { copied, copy } = useCopy(cmd.replace(/^\$ /, ""));
  return (
    <div className="bx-cmd">
      <code>{cmd}</code>
      <button type="button" className="bx-copy bx-cmd-copy" onClick={copy}>
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}

/** The full frame, kept for MULTI-LINE commands where the dots earn their place. */
function Block({ lines, label }: { lines: string[]; label?: string }) {
  const { copied, copy } = useCopy(lines.join("\n").replace(/^\$ /gm, ""));

  return (
    <div className="bx-term">
      <div className="bx-term-bar">
        <span className="bx-term-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        {label ? <span className="bx-term-label">{label}</span> : null}
        <button type="button" className="bx-copy" onClick={copy}>
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
  // 01 open on arrival: a closed accordion reads as an empty section, and the
  // first step is the one a reader wants anyway.
  const [open, setOpen] = useState(0);

  return (
    <section className="bx-demo" aria-labelledby="demo-h">
      {/*
        THE CURSOR WAKE AND THE CLICK RIPPLE — this module, and nowhere else.

        Erik, S#282, pointing at React Bits' `Cursor Wave`: the section should
        answer the mouse. The adaptation is his — glitched glyphs rather than
        coloured shapes — so this is the field the page already runs, given a
        reason to notice where you are.

        WHY THIS MODULE AND NOT THE HERO. The hero already moves on its own and
        already carries the word; a second motion source there competes with the
        thing it is meant to frame. This band was flat, it is the part of the
        page a reader lingers on, and a step-by-step list is exactly where a
        cursor travels — the effect fires where the pointer already is.

        AND GETTING THE EXTENT RIGHT TOOK TWO WRONG VERSIONS.

        v1 covered the section at intensity 0.3 and put a churning, LEGIBLE
        glyph field behind the `Don't trust this page` checks -- plain
        paragraphs with no card of their own, so the text sat on the noise.
        v2 fixed that by shrinking the field to the heading and the steps, which
        Erik immediately read as the bug it was: *"Seems the mouse hover was
        only in 1 section of the whole module I was pointing at?"* -- a field
        that stops halfway down a section looks broken, not deliberate.

        Both versions were solving the wrong variable. The problem was never the
        AREA, it was the IDLE BRIGHTNESS: at 0.3 the resting field reads as
        letters you can almost make out, which competes with any prose over it.
        Dropped to 0.14 it reads as texture, and the WAKE and the RIPPLE become
        the only bright things -- which is the point, since those exist only
        where the pointer is. Area restored, contrast moved instead.
      */}
      <div className="bx-demo-field">
        <LetterGlitch
          className="bg-demo"
          showWord={false}
          pointer
          intensity={0.14}
          glitchMs={150}
        />
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
        {STEPS.map((s, i) => {
          const isOpen = i === open;
          return (
            <li key={s.n} data-open={isOpen ? "" : undefined}>
              {/*
                A real button, so the row is reachable by keyboard and announced
                as expandable. The panel stays in the DOM when closed and is
                hidden in CSS rather than unmounted — a landing page's content
                should survive being read without JavaScript running the show.
              */}
              <button
                type="button"
                className="bx-step-head"
                aria-expanded={isOpen}
                aria-controls={`step-${s.n}`}
                onClick={() => setOpen(isOpen ? -1 : i)}
              >
                <span className="bx-step-n">{s.n}</span>
                <span className="bx-step-title">{s.title}</span>
                <span className="bx-step-chev" aria-hidden="true" />
              </button>
              <div className="bx-step-body" id={`step-${s.n}`} role="region">
                <div className="bx-step-body-in">
                  {/*
                    Two wrappers, and the inner one is not decoration. The
                    collapsing element cannot carry padding: padding is part of
                    the box and `overflow: hidden` does not clip it, so a 0fr row
                    resolved to 15px -- the exact padding-bottom -- and every
                    closed step leaked its first line. Measured, after it shipped
                    into a capture looking like a rendering glitch.
                  */}
                  <div className="bx-step-pad">
                  <p>{s.blurb}</p>
                  <Block lines={s.lines} />
                  {s.returns ? (
                    <div className="bx-returns">
                      {s.returns.map((r, k) => (
                        <span key={k}>{r}</span>
                      ))}
                    </div>
                  ) : null}
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      <p className="bx-demo-note">
        Prefer tools your client manages for you? There is an MCP server at{" "}
        <code>/api/mcp</code> with the same operations, and the token stays in a config file your
        model never reads. It costs the far side standing context on every turn, used or not — so it
        is the upgrade, not the starting point.
      </p>

      <div className="bx-verify" id="verify">
        <header>
          <h2>Don&rsquo;t trust this page. Check it.</h2>
          <p>
            Every property below carries the command that settles it. The last one is the property
            that does not come out in our favour, and it is here for the same reason as the rest.
          </p>
        </header>
        <ul className="bx-checks">
          {CHECKS.map((c) => (
            <li key={c.claim}>
              <div className="bx-check-head">
                <h3>{c.claim}</h3>
                {c.cmd ? (
                  <Cmd cmd={c.cmd} />
                ) : (
                  <span className="bx-check-nocmd">no single command settles this — read the source</span>
                )}
              </div>
              <p>{c.detail}</p>
            </li>
          ))}
          <li className="bx-against">
            <h3>{AGAINST.claim}</h3>
            <p>{AGAINST.detail}</p>
          </li>
        </ul>
      </div>
      </div>
    </section>
  );
}
