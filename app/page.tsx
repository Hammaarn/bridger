"use client";

/**
 * BRIDGER, FROM THE BROWSER.
 *
 * WHAT CHANGED IN S#275, and why the file grew. This page used to be one thing:
 * paste a token, watch a ledger. Erik's direction turned the browser into where
 * a room BEGINS — *"I open Bridger in the browser, click start new room, select
 * slots, and the tokens generated from that room are the connectors you paste
 * into the session you are having with your AI of choice."* So there are four
 * views now, in the order a person meets them:
 *
 *   gate    → open a room, or watch one you already have a token for
 *   create  → name it, name both parties, pick slots
 *   minted  → the token box: every connector, shown exactly once
 *   room    → the three-panel view (record / conversation / agreements)
 *
 * WHAT CHANGED IN S#277 — THE DESIGN. The markup was restructured onto "the
 * wire" (see `globals.css`; the `wire.tsx` this used to name was deleted by the
 * S#279 "the wave is deleted" commit, and two documents kept pointing at it
 * until S#280). Three things drove it:
 *   - The gate is now a real first screen rather than a token box with a trust
 *     paragraph stapled underneath. The person it has to convince is often a
 *     partner's operator deciding whether this domain deserves a credential.
 *   - The conversation is drawn as a CHAIN, because it is one: `lib/chain.ts`
 *     hash-links every entry, and the spine down the feed is that structure made
 *     visible instead of merely claimed.
 *   - A real arrival on the bridge sends a packet down the wire in the room
 *     header. The animation is driven by the record, never by a timer.
 * No behaviour moved. Same polling, same roles, same single write path.
 *
 * IT STILL WRITES NOTHING INTO THE RECORD. Erik's call, asked directly: *"The
 * chat is watch only, the communication between you and gemini is the users
 * chatting."* So the page mints and renames, and never posts an entry — there
 * is still exactly one write path into the ledger and it runs through the MCP
 * tools. A UI that could post would need its own authorship rules, and "who
 * wrote this" is the property the whole ledger rests on.
 *
 * THE TOKEN NEVER GOES IN THE URL. Pasted, held in `sessionStorage`, sent as a
 * bearer header. A token in a query string ends up in browser history, in
 * server logs, and in any screenshot of the address bar — which is exactly the
 * artefact someone would post while demoing this.
 *
 * THE BROWSER HOLDS THE *VIEWER* TOKEN. After minting, this page keeps the
 * read-only seat, not either participant token. Watching must not be able to
 * become writing just because a tab was left open on a shared screen — the same
 * reasoning that put the `viewer` role in `room-registry.ts` in the first place.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openQuestionIds } from "@/lib/question-state";
import { classifyCitation, describeCitation, isUnlocated, isWideRange } from "@/lib/citation";
import LetterGlitch from "./backgrounds/letter-glitch";
import Demonstration from "./demo";

interface Entry {
  id: string;
  seq: number;
  type: "question" | "answer" | "decision" | "note" | "contract" | "reopen" | "signoff";
  side: "a" | "b";
  code: string;
  author: string;
  ts: string;
  title: string;
  body: string;
  answers: string | null;
  why: string | null;
  checkedAgainst: string | null;
  /**
   * Three readings, not two. Shipped server-side in S#279 (`lib/entries.ts`)
   * and never plumbed to this page, so every honest `opinion` rendered here as
   * "unchecked -- nobody named what this rests on" -- the exact shaming the
   * field was built to remove. Found S#280 by grepping this file for `basis`
   * and getting zero hits.
   */
  basis: "opinion" | "inference" | null;
}

interface ExportPayload {
  room: {
    id: string;
    topic: string;
    phase?: "plan" | "build";
    you: { side: string; label: string; code: string; joinedAt: string | null; agent?: string | null };
    peer: { side: string; label: string; code: string; joinedAt: string | null; agent?: string | null };
  };
  contract: { body: string; updatedBy: string; updatedAt: string } | null;
  plan?: {
    items: {
      id: string;
      title: string;
      note: string;
      owner: "a" | "b" | "both" | null;
      state: "open" | "agreed" | "dropped";
      raisedBy: "a" | "b";
    }[];
    readiness: { complete: boolean; open: number; unowned: number; agreed: number; blocking: string[] };
  };
  entries: Entry[];
  exportedAt: string;
}

interface Slot {
  side: "a" | "b";
  label: string;
  code: string;
  token: string;
}

interface Minted {
  room: { id: string; topic: string; createdAt: string };
  slots: Slot[];
  viewerToken: string;
  endpoint: string;
  unclaimedExpiresInSeconds: number;
  note: string;
}

/**
 * How often the room view asks the server what changed.
 *
 * WAS 3000, WHICH IS EXACTLY THE LIMIT. A 3-second poll is 20 requests a
 * minute, and `RATE_LIMIT_PER_MINUTE` is 20 — so the UI ran permanently on the
 * ceiling and the first extra call (the `whoami` on mount, a second tab, a
 * clock hiccup) tipped it into `429: rate-limited`. A customer's first screen
 * said so out loud.
 *
 * 4 seconds is 15/minute against a viewer ceiling of 60. The gap is the point:
 * a poll interval that only just fits is one that fails the moment anything
 * else shares the budget.
 */
const POLL_MS = 4000;
/**
 * And when it does fail, back off instead of leaning on the door.
 *
 * The old loop kept firing at the same rate after an error, so a rate-limited
 * tab re-earned its rate limit every single minute and could never recover on
 * its own — "stalled" was permanent until someone reloaded. Doubling to a cap
 * lets a tab that hit any transient failure heal itself, and stops a hundred
 * open tabs from turning one outage into a stampede.
 */
const POLL_MAX_MS = 30000;

/**
 * HOW SLOW THE POLL GETS WHEN THE ROOM IS QUIET, and why this exists.
 *
 * The interval above was reasoned about carefully against the PER-MINUTE limit
 * and never against the per-DAY one. At 4s that is 15 requests a minute, 900 an
 * hour, against a `perTokenPerDay` of 400 — so an open watch tab exhausted its
 * own viewer token in about twenty-seven minutes and then showed a rate-limit
 * error for the rest of the day. It did exactly that during the first live
 * partner run, while the operator was watching the room it had just been given.
 *
 * The fix is not a bigger number. A room where nothing has happened for four
 * minutes does not need fifteen requests a minute, and the product's own
 * argument to its partners is that the other side is a human-paced team rather
 * than a service. The poll now backs off when NOTHING CHANGED, not only when
 * something failed, and snaps back to full speed the instant an entry lands.
 *
 * Budget: reaching this ceiling takes ~8 quiet ticks (about four minutes), then
 * costs 30 calls an hour — roughly 240 across an eight-hour day against the 400
 * cap, with room left for the operator to actually use the room.
 */
const POLL_IDLE_MAX_MS = 120000;
const POLL_IDLE_GROWTH = 1.7;
const STORAGE_KEY = "bridger.token";
const TREE_KEY = (roomId: string) => `bridger.tree.${roomId}`;

const TYPE_LABEL: Record<Entry["type"], string> = {
  question: "asks",
  answer: "answers",
  decision: "decides",
  note: "notes",
  contract: "contract",
  reopen: "REOPENS",
  signoff: "signs off",
};

/**
 * Never render a blank verb. `TYPE_LABEL` is typed against the union above, but
 * the data arrives as JSON from a server that may be a version ahead of this
 * page — an entry type added server-side would otherwise render as an empty
 * span with no clue that anything was missing.
 */
const verbFor = (t: string) => TYPE_LABEL[t as Entry["type"]] ?? t;
const timeOf = (iso: string) => iso.slice(11, 19);

/**
 * THE ROOM READS AS A DIALOGUE (S#280, D1 + D2 + D4).
 *
 * Erik, after watching a real cross-company session: *"it should read like two
 * people talking in Teams -- each side on its own side of the column, in its own
 * bubble."* The three findings filed separately from that session (nobody can
 * tell who is who / the conversation is not shaped like a conversation / the
 * create flow is too vague) are one deliverable, and this is its core.
 *
 * WHAT THE TODO GOT WRONG, checked before building on it: D1 said *"there is no
 * per-side colour anywhere in the room view"*. There was -- a 9px node ring and
 * a coloured author name (`globals.css`, `.entry.sideA::before`). The complaint
 * was real and the stated cause was not: the signal existed and was too weak to
 * read at a glance. So this is not "add colour", it is "make position carry the
 * author before any text is read, and let colour confirm it" -- which is the
 * Teams principle worth taking.
 *
 * WHAT IS DELIBERATELY NOT TAKEN FROM TEAMS: a compose box. The browser still
 * writes nothing into the record -- Erik's call, asked directly in S#277 (*"The
 * chat is watch only, the communication between you and gemini is the users
 * chatting."*). There is exactly one write path and it runs through the tools.
 * Adding a message box here would need its own authorship rules, and "who wrote
 * this" is the property the whole ledger rests on.
 */

/** Consecutive entries from one side, close in time, drawn under one header. */
interface Turn {
  side: "a" | "b";
  author: string;
  mine: boolean;
  entries: Entry[];
}

/**
 * Five minutes, the same window Teams uses to decide whether a message belongs
 * to the message above it. Long enough that a burst of related entries reads as
 * one turn; short enough that a reply an hour later gets its own header rather
 * than pretending to be part of a conversation that had already ended.
 */
const TURN_GAP_MS = 5 * 60 * 1000;

function toTurns(entries: Entry[], mySide: string): Turn[] {
  const turns: Turn[] = [];
  for (const e of entries) {
    const last = turns.at(-1);
    const contiguous =
      last &&
      last.side === e.side &&
      last.author === e.author &&
      Date.parse(e.ts) - Date.parse(last.entries.at(-1)!.ts) < TURN_GAP_MS;
    if (contiguous) last.entries.push(e);
    else turns.push({ side: e.side, author: e.author, mine: e.side === mySide, entries: [e] });
  }
  return turns;
}

/**
 * THE PROVENANCE LINE, WITH THE THIRD READING IT WAS ALWAYS OWED.
 *
 * `basis` shipped in S#279 with its own argument: an honest opinion and an
 * unsourced factual claim had rendered identically, one of them looked like a
 * failure, and the cheapest way out of looking like a failure was to invent a
 * citation. The server has said three things ever since (`wire()` in
 * `lib/operations.ts`); this page kept saying two. The wording here is lifted
 * from `wire()` verbatim so a reader who has seen the tool output and then
 * opens the room is not learning a second vocabulary for the same field.
 *
 * This is also the tension the whole chat shape has to survive: a bubble is a
 * message, an entry is a typed record with a basis and a citation. If the
 * bubble hides this line, the layout has removed the thing the product is for.
 */
function Provenance({ entry }: { entry: Entry }) {
  /**
   * WHICH ENTRIES GET A PROVENANCE LINE, and why this is not just answers.
   *
   * Found S#280 by driving the room: an `inference` on a note rendered nothing.
   * The server takes `checkedAgainst` and `basis` on `answer`, `post` AND
   * `decide` (see the schemas in `app/api/rpc/route.ts`) -- and S#276 added them
   * to `decide` on purpose, because a decision was *"the most consequential
   * entry type and the only one that structurally could not say what it was
   * checked against"*. This page then showed that evidence on answers only, so
   * the citation behind the most consequential entry in the room was accepted,
   * stored, exported, and displayed nowhere.
   *
   * The rule: if provenance was DECLARED, always show it. If it was not, only
   * an ANSWER is scolded for the omission -- a note or a decision is not
   * obliged to cite, and warning on those would re-create the pressure to
   * invent a citation that `basis` exists to remove.
   */
  const declared = entry.checkedAgainst !== null || entry.basis !== null;
  if (!declared && entry.type !== "answer") return null;

  if (entry.checkedAgainst) {
    const c = classifyCitation(entry.checkedAgainst);
    const weak = isUnlocated(c) || isWideRange(c);
    return (
      <p className={`prov ${weak ? "thin" : "ok"}`}>
        <span className="glyph">{weak ? "\u25d0" : "\u2713"}</span>
        checked against <code>{entry.checkedAgainst}</code>
        <span
          className="span"
          title="How specific the citation is. Says nothing about whether the answer is correct."
        >
          {describeCitation(c)}
        </span>
      </p>
    );
  }
  if (entry.basis === "opinion")
    return (
      <p className="prov judged">
        <span className="glyph">{"\u25c6"}</span>
        opinion <span className="span">no citation expected</span>
      </p>
    );
  if (entry.basis === "inference")
    return (
      <p className="prov judged">
        <span className="glyph">{"\u25c7"}</span>
        inference <span className="span">reasoned, not read</span>
      </p>
    );
  return (
    <p className="prov bad">
      <span className="glyph">{"\u26a0"}</span>
      unchecked <span className="span">nobody named what this rests on</span>
    </p>
  );
}

/**
 * THE PLAN, AS A BOARD (F1).
 *
 * Erik's whiteboard instinct was pointing at something real and the noun was
 * wrong: what both sides wanted was SPATIAL AND SIMULTANEOUS rather than
 * LINEAR -- which is the same complaint as D2, one layer up. A freehand canvas
 * would have cost 46 MB, needed a collaboration server the package does not
 * ship, and sat outside the hash chain. Three columns of owned items give the
 * same reading -- who holds what, at a glance -- for none of that.
 *
 * Columns are OWNERSHIP, not authorship: an item side A raised and side B owns
 * belongs in B's column, because the question this answers is "who is doing
 * it". Who raised it is a small mark, not a position.
 */
function PlanBoard({
  plan,
  you,
  peer,
  phase,
}: {
  plan: NonNullable<ExportPayload["plan"]>;
  you: { side: string; label: string };
  peer: { side: string; label: string };
  phase?: string;
}) {
  const live = plan.items.filter((i) => i.state !== "dropped");
  const columns = [
    { key: "yours", label: you.label, side: you.side, items: live.filter((i) => i.owner === you.side) },
    { key: "both", label: "Both", side: null, items: live.filter((i) => i.owner === "both") },
    { key: "theirs", label: peer.label, side: peer.side, items: live.filter((i) => i.owner === peer.side) },
  ];
  const unowned = live.filter((i) => i.owner === null);

  return (
    <section className="bx-board">
      <h2>
        Plan
        <span className={`bx-phase ${phase === "plan" ? "on" : ""}`}>{phase ?? "build"}</span>
      </h2>

      {live.length === 0 ? (
        <p className="bx-none">
          Nothing planned yet. Either side adds items with <code>bridger_plan</code>.
        </p>
      ) : (
        <>
          <div className="bx-board-cols">
            {columns.map((col) => (
              <div
                key={col.key}
                className={`bx-col ${col.side === "a" ? "sideA" : col.side === "b" ? "sideB" : "shared"}`}
              >
                <h3>
                  {col.label}
                  <span className="bx-count">{col.items.length}</span>
                </h3>
                {col.items.length === 0 && <p className="bx-none">nothing</p>}
                {col.items.map((i) => (
                  <div key={i.id} className={`bx-card ${i.state}`}>
                    <div className="bx-card-head">
                      <code>{i.id}</code>
                      {/* The state is a word, not a colour alone -- a colour-only
                          state is invisible to a reader who cannot see it. */}
                      <span className="st">{i.state === "agreed" ? "agreed" : "open"}</span>
                    </div>
                    <strong>{i.title}</strong>
                    {i.note && <p>{i.note}</p>}
                  </div>
                ))}
              </div>
            ))}
          </div>

          {/*
            Unowned items get their own strip rather than a fourth column,
            because they are not a party -- they are the thing standing between
            this plan and being finished, and that is the readiness check's
            single most common blocker.
          */}
          {unowned.length > 0 && (
            <div className="bx-unowned">
              <h3>
                Nobody has claimed these
                <span className="bx-count">{unowned.length}</span>
              </h3>
              {unowned.map((i) => (
                <div key={i.id} className="bx-card open">
                  <div className="bx-card-head">
                    <code>{i.id}</code>
                    <span className="st">unowned</span>
                  </div>
                  <strong>{i.title}</strong>
                  {i.note && <p>{i.note}</p>}
                </div>
              ))}
            </div>
          )}

          <p className={`bx-ready ${plan.readiness.complete ? "done" : ""}`}>
            {plan.readiness.complete
              ? "Every item is owned and agreed."
              : `${plan.readiness.agreed} agreed · ${plan.readiness.open} open · ${plan.readiness.unowned} unowned`}
          </p>
        </>
      )}
    </section>
  );
}

/**
 * THE AGENT MARK.
 *
 * Erik saw a shared-chat product where every participant carried its vendor's
 * logo and liked that you could tell at a glance who was who. He is right about
 * the problem: checked against production S#280, the real cross-company room has
 * `label: "claude"` on BOTH sides, so the one place a reader looks to confirm
 * what the layout told them says the same word twice.
 *
 * A MONOGRAM, NOT A BRAND ASSET, and that is a decision rather than a shortcut.
 * This page is served under a strict CSP with no external hosts, so a vendor
 * logo would mean shipping inlined copies of other companies' trademarks from
 * our own origin, on a public product. Nominative use is usually defensible;
 * "usually defensible" is not a call to make unilaterally on somebody else's
 * business. So the mechanism ships with initials, and swapping in real marks
 * later is this one function.
 *
 * The colour is the SIDE's hue, not the vendor's. Two Claudes in one room have
 * to be distinguishable, which a vendor palette would actively prevent.
 */
function AgentMark({ agent, side }: { agent?: string | null; side: string }) {
  if (!agent) return null;
  const initials = agent.slice(0, 2).toUpperCase();
  return (
    <span
      className={`bx-agent ${side === "a" ? "sideA" : "sideB"}`}
      title={`Self-declared as "${agent}" by that side. Nothing verifies this.`}
    >
      {initials}
    </span>
  );
}

/**
 * Who is in the room, and whether they are actually here.
 *
 * The old header said this in prose -- two coloured names, a dot, and an
 * "-- has not connected yet" clause appended to a metadata line. That is the
 * information, in the place nobody looks. A party is either present or it is
 * not, and that is a state worth its own object on screen.
 */
function SideChip({
  side,
  label,
  joinedAt,
  agent,
  you,
}: {
  side: string;
  label: string;
  joinedAt: string | null;
  agent?: string | null;
  you?: boolean;
}) {
  const here = joinedAt !== null;
  return (
    <span className={`bx-chip ${side === "a" ? "sideA" : "sideB"} ${here ? "here" : "away"}`}>
      <span className="bx-chip-dot" />
      <AgentMark agent={agent} side={side} />
      <span className="bx-chip-name">{label}</span>
      {you && <span className="bx-chip-you">you</span>}
      {!here && <span className="bx-chip-state">not connected</span>}
    </span>
  );
}


/**
 * The tree's folders, and why they are these five.
 *
 * Erik: *"The folder tree is just a nice to have storage of things like
 * implementations agreed upon or decisions argued and conclusion reached on.
 * It's for traceability and storing."* So it is a VIEW over entry types that
 * already exist, not a second store — the durable artefacts of the room, sorted
 * by what kind of artefact they are. Nothing here is new data.
 *
 * The names are editable (Erik asked for that) and kept in `localStorage` per
 * room. Deliberately NOT server state: renaming your own folder headings is a
 * private preference, and putting it in Redis would mean one side's cosmetic
 * choice silently rewrote the other side's screen.
 */
const FOLDERS = [
  { key: "agreements", label: "Agreements", types: ["contract"] as Entry["type"][] },
  { key: "decisions", label: "Decisions", types: ["decision"] as Entry["type"][] },
  { key: "answered", label: "Answered", types: ["answer"] as Entry["type"][] },
  { key: "open", label: "Open questions", types: ["question"] as Entry["type"][] },
  { key: "notes", label: "Notes", types: ["note", "signoff", "reopen"] as Entry["type"][] },
];

function copy(text: string) {
  void navigator.clipboard?.writeText(text);
}

/** A one-click copy that says it worked, because a silent copy button is a coin flip. */
function CopyButton({ value, children }: { value: string; children: React.ReactNode }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`bx-copy ${done ? "done" : ""}`}
      onClick={() => {
        copy(value);
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
    >
      {done ? "copied" : children}
    </button>
  );
}

/**
 * The GitHub mark, inline.
 *
 * Inline rather than an icon dependency or a remote SVG for the same reason the
 * fonts are self-hosted: this page is read by people deciding whether the
 * domain deserves a credential, and every extra host it talks to is another
 * thing they have to take on faith. It is also the single most load-bearing
 * link here — "read the source" is the whole trust argument — so it should not
 * be able to fail to load.
 */
function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" width="17" height="17" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/**
 * The brand mark is one crest of the wire. The signature element and the logo
 * are the same object, which is the cheapest kind of coherence there is.
 */
function Nav({ over = false }: { over?: boolean }) {
  return (
    <nav className={`nav ${over ? "nav-over" : ""}`} aria-label="Bridger">
      <a className="brand" href="/">
        {/*
          THE MARK IS THE FIELD, at mark scale.
          It was a sine wave until S#279, when Erik settled the identity on the
          letter-glitch and the wave was removed from the product entirely. A
          logo that still drew a wave would be the last thing in the codebase
          claiming the old design -- and the one a visitor sees first.
          Seven columns of three cells, with the middle row lit: noise, and a row
          resolving out of it. That is literally what the background does.
        */}
        <svg viewBox="0 0 34 12" width="26" height="10" aria-hidden="true">
          {[1, 6, 11, 16, 21, 26, 31].map((x, i) => (
            <g key={x} fill="currentColor">
              <rect x={x} y={1} width={3} height={2} opacity={0.22 + ((i * 7) % 5) * 0.06} />
              <rect x={x} y={5} width={3} height={2} opacity={0.9} />
              <rect x={x} y={9} width={3} height={2} opacity={0.2 + ((i * 3) % 4) * 0.07} />
            </g>
          ))}
        </svg>
        Bridger
      </a>
      <div className="nav-links">
        <a href="/api/about">/api/about</a>
        <a
          href="https://github.com/Hammaarn/bridger"
          className="nav-icon"
          aria-label="Bridger source on GitHub"
          title="Source on GitHub"
        >
          <GitHubMark />
        </a>
      </div>
    </nav>
  );
}

// ── view: gate ───────────────────────────────────────────────────

function Gate({
  onWatch,
  onCreate,
  booting,
}: {
  onWatch: (t: string) => void;
  onCreate: () => void;
  /** First paint, before sessionStorage has been read. See `Bridger` below. */
  booting?: boolean;
}) {
  const [draft, setDraft] = useState("");
  return (
    <main className="gate" data-booting={booting ? "" : undefined}>
      <section className="hero">
        <LetterGlitch className="bg-hero" word="BRIDGER" intensity={0.92} />
        <Nav over />
        <div className="hero-inner">
          {/*
            ALPHA IS ON THE PAGE BECAUSE ERIK SAYS IT IN THE ROOM.
            S#279: he showed it to eight people, all of whom wanted it, and told
            them plainly it is alpha and far from done. A product that states its
            trust properties with the command that checks each one cannot then be
            quiet about its own maturity -- that is the same omission it criticises
            gateways for, one level up. The visitor should not have to be in the
            conversation to learn the stage.
          */}
          <span className="eyebrow">
            <span className="led" />
            <b className="stage">alpha</b>
            append-only · two parties · no model called
          </span>
          <h1>Where your AI and theirs work it out.</h1>
          <p className="lede">
            A shared record between two teams&rsquo; AI sessions. Questions, answers, decisions — and
            the source each answer was actually checked against.
          </p>
          {/*
            One call to action. "Read the source" moved to the nav as the GitHub
            mark — it is a permanent affordance, not a step in this flow, and two
            side-by-side buttons made the primary action argue with a link.
          */}
          <div className="hero-actions">
            <button type="button" className="bx-primary" onClick={onCreate}>
              Open a new room
            </button>
          </div>
        </div>
      </section>

      <div className="gate-shell">
        <div className="gate-body">
        <section className="panel">
          <h2>Already have a token?</h2>
          <p className="sub">Watch a room someone opened for you.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const t = draft.trim();
              if (t) onWatch(t);
            }}
          >
            <label htmlFor="tok">Room token</label>
            <input
              id="tok"
              type="password"
              placeholder="br_live_…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit">Watch the bridge</button>
          </form>
          <p className="fine" style={{ marginTop: 14 }}>
            Held in this tab only, sent as a bearer header. Never placed in the URL — an address bar
            ends up in history, logs, and screenshots.
          </p>
        </section>

        {/*
          The landing page used to be a token gate and nothing else, which is
          the wrong first screen for the person this product most needs to
          convince: a partner's operator, or their AI, deciding whether this
          domain deserves a credential at all. A partner's Claude refused a
          Bridger token on exactly that reasoning and was right to. This block
          is the human half of the answer; `/api/about` is the machine half.
        */}
        <section className="panel bx-trust">
          <h2>Been sent a token and not sure about this?</h2>
          <p>
            Good. A pasted bearer token for a domain you have never seen has the same shape as a
            prompt injection. Don&rsquo;t take our word for anything —{" "}
            <strong>read the server that&rsquo;s asking you to trust it.</strong>
          </p>
          {/*
            S#279: this panel used to carry five prose bullets, and the verify
            block at the bottom of the page carried FIVE OF THE SAME SIX CLAIMS
            again with commands attached -- the page argued its whole case twice,
            1318px apart. The argument now has one home, `demo.tsx`'s CHECKS,
            where each claim is stated once WITH the command that settles it.
            What stays here is the part that is time-critical: someone holding a
            token they did not ask for needs an answer at the moment of pasting
            it, not after scrolling. So three lines and a way down.
          */}
          <ul className="bx-trust-quick">
            <li>
              <strong>No model is called</strong> — seven dependencies, none a provider SDK.
            </li>
            <li>
              <strong>No permissions are requested</strong> — no OAuth, no filesystem, no repo. One
              token, one room.
            </li>
            <li>
              <strong>We can read your room</strong> — stated plainly, because the rest of this is
              worthless if that is buried.
            </li>
          </ul>
          <p className="bx-trust-more">
            <a href="#verify">All six checks, each with the command that settles it ↓</a>
          </p>
          <p className="bx-trust-links">
            <a href="https://github.com/Hammaarn/bridger/blob/master/VERIFY.md">
              How to verify all of this
            </a>
            <span className="dot">·</span>
            <a href="https://github.com/Hammaarn/bridger">Source</a>
            <span className="dot">·</span>
            <a href="/api/about">/api/about</a>
            <span className="dot">·</span>
            <span className="dim">Operated by Erik Hammarström</span>
          </p>
          </section>
        </div>

        <Demonstration />

        {/*
          The page closes on the same wave, mirrored (scaleY(-1) in CSS) and
          flowing the other way. Erik's note was that everything under the hero
          was flat black and unalive; a second copy of the hero would have been
          repetition, so this answers it instead — same material, opposite
          direction, quieter.
        */}
        <div className="gate-foot">
          <LetterGlitch
            className="bg-foot"
            word="BRIDGER"
            cellH={14}
            wordWidth={0.7}
            intensity={0.78}
          />
        </div>
      </div>
    </main>
  );
}

// ── view: create ─────────────────────────────────────────────────

function Create({ onMinted, onCancel }: { onMinted: (m: Minted) => void; onCancel: () => void }) {
  const [topic, setTopic] = useState("");
  const [you, setYou] = useState("");
  const [them, setThem] = useState("");
  const [slots, setSlots] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [badField, setBadField] = useState<string | null>(null);
  /**
   * A8. Where you stand, BEFORE you try.
   *
   * Erik's brother opened three rooms and the fourth was refused; the cap was
   * raised the same session, but the real complaint was that nothing said where
   * he stood until it fired. `GET /api/rooms` only READS the counter -- a peek
   * that charged would mean opening this screen spent your allowance.
   *
   * Failure is silent on purpose: this is a courtesy, and a create screen that
   * shows an error because it could not fetch a quota reading has made a
   * working form look broken.
   */
  const [quota, setQuota] = useState<{
    usedToday: number;
    limit: number | null;
    remaining: number | null;
    unlimited: boolean;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/rooms");
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled && body?.rooms) setQuota(body.rooms);
      } catch {
        /* a courtesy that cannot be delivered is simply not shown */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setBadField(null);
    try {
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, you, them, slots }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setBadField(body.field ?? null);
        setError(body.error ?? `The server said ${res.status}.`);
        return;
      }
      onMinted(body as Minted);
    } catch {
      setError("Could not reach the bridge server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="sheet">
      {/*
        The same field as the landing page, without the word.
        Erik, S#279, looking at this screen: "the landing page's vibe does not
        follow at all". It did not -- these views were a form on flat black
        while the page that sent you here is full-bleed and moving. The word is
        off deliberately: BRIDGER at hero scale behind a four-field form fights
        the thing you came here to fill in. Same material, quieter, which is the
        move the closing band already makes.
      */}
      <LetterGlitch className="bg-sheet" showWord={false} intensity={0.42} glitchMs={130} />
      <Nav />
      <div className="sheet-card">
        <h1>Open a room</h1>
        <p className="sub">Two AI sessions, one record, and a token each.</p>

        <form onSubmit={submit}>
          <label htmlFor="topic">What is this room for?</label>
          <input
            id="topic"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Checkout API — payload shapes"
            className={badField === "topic" ? "bx-bad" : ""}
            maxLength={200}
            autoFocus
          />

          <div className="bx-pair">
            <div>
              <label htmlFor="you">Your side</label>
              <input
                id="you"
                value={you}
                onChange={(e) => setYou(e.target.value)}
                placeholder="Acme (your AI)"
                className={badField === "ownerLabel" ? "bx-bad" : ""}
                maxLength={60}
              />
            </div>
            <div>
              <label htmlFor="them">Their side</label>
              <input
                id="them"
                value={them}
                onChange={(e) => setThem(e.target.value)}
                placeholder="Northwind (their AI)"
                className={badField === "ownerLabel" ? "" : badField === "peerLabel" ? "bx-bad" : ""}
                maxLength={60}
              />
            </div>
          </div>

          <label>Slots</label>
          <div className="bx-slots">
            {[2, 3, 4].map((n) => (
              <button
                key={n}
                type="button"
                className={`bx-slot ${slots === n ? "on" : ""} ${n > 2 ? "off" : ""}`}
                disabled={n > 2}
                onClick={() => setSlots(n)}
              >
                {n}
              </button>
            ))}
          </div>
          {/*
            Not a coming-soon tease. Sides are "a" | "b" in room-registry.ts and
            two-ness is the data model: otherSide() is a boolean flip, entry ids
            are namespaced per side, and "the peer" is singular in whoami, in
            the wait cursor and in the idle brake. Saying so is more useful than
            greying the buttons out silently.
          */}
          <p className="fine" style={{ marginTop: 9 }}>
            Three or more is a rewrite of the room model, not a bigger number here — every side is{" "}
            <code>a</code> or <code>b</code> throughout the registry.
          </p>

          {error && <div className="error">{error}</div>}

          {/*
            Shown only when a cap actually applies and the reading arrived.
            `unlimited` is its own flag rather than `limit === null`, because
            "no cap" and "none left" must never render the same.
          */}
          {quota && !quota.unlimited && quota.limit !== null && (
            <p className={`bx-quota ${quota.remaining === 0 ? "spent" : ""}`}>
              {quota.remaining === 0 ? (
                <>
                  You have opened all {quota.limit} of today&rsquo;s rooms from this connection. The
                  count resets at midnight UTC.
                </>
              ) : (
                <>
                  {quota.remaining} of {quota.limit} rooms left today from this connection. A room
                  nobody joins still costs one.
                </>
              )}
            </p>
          )}

          <div className="bx-row">
            <button type="submit" className="bx-primary" disabled={busy || !topic || !you || !them}>
              {busy ? "Opening…" : "Open the room"}
            </button>
            <button type="button" className="link" onClick={onCancel}>
              back
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}

// ── view: minted (the token box) ─────────────────────────────────

interface InviteLink {
  joinUrl: string;
  forLabel: string;
  linkExpiresInMinutes: number;
  tokenExpiresInDays: number;
  replacedPreviousLink: boolean;
}

function TokenBox({
  minted,
  onWatch,
}: {
  minted: Minted;
  onWatch: (t: string, invite?: InviteLink | null) => void;
}) {
  /**
   * THE INVITE LINK, and why it is the primary handoff now.
   *
   * This screen's only way to invite anyone used to be the raw `br_live_...`
   * token below — so the recommended action was to paste a live credential into
   * a chat message, which is durable, forwardable and screenshot-able. It is
   * also the exact artefact a partner's AI is right to refuse: Northwind's
   * Claude declined precisely that in S#275 and its reasoning was correct.
   *
   * A `/j/<code>` link is not a credential. It dies in minutes, it mints exactly
   * one token, and it hands the far side the whole protocol as a document. The
   * mechanism has existed since S#276 and was reachable only from the CLI, which
   * is to say: not reachable by anyone who arrived at this page.
   */
  const [invite, setInvite] = useState<InviteLink | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const rpcEndpoint = minted.endpoint.replace(/\/api\/mcp$/, "/api/rpc");

  /**
   * Mint the link and go straight into the room.
   *
   * Erik's brother, S#279: "once you have created the room there should be a
   * generate invite link that also takes you to the room instantly." He is
   * right that this screen was a dead end -- you minted a link and then stood on
   * a static page holding it. The link now travels with you and is displayed in
   * the room, which is also where it belongs: the invite is a property of a room
   * waiting for its second party, not of the one screen that happened to create
   * it.
   *
   * It carries in memory, NOT in sessionStorage. The link mints a credential, so
   * persisting it would put a token-bearing URL on disk next to the viewer token
   * for no gain -- a reload half an hour later would find it expired anyway.
   */
  async function makeInviteAndEnter() {
    const link = await makeInvite();
    if (link) onWatch(minted.viewerToken, link);
  }

  async function makeInvite(): Promise<InviteLink | null> {
    setInviteBusy(true);
    setInviteError(null);
    try {
      const res = await fetch(rpcEndpoint, {
        method: "POST",
        headers: {
          // Side A's own token: inviting is a participant action, and the
          // server re-checks that rather than trusting this screen.
          Authorization: `Bearer ${minted.slots[0].token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ op: "invite" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setInviteError(body.error ?? `The server said ${res.status}.`);
        return null;
      }
      setInvite(body as InviteLink);
      return body as InviteLink;
    } catch {
      setInviteError("Could not reach the bridge server.");
      return null;
    } finally {
      setInviteBusy(false);
    }
  }

  const inviteMessage = invite
    ? `Join our integration bridge for "${minted.room.topic}":

${invite.joinUrl}

Give that URL to your AI. It returns a working token and the whole protocol in
one document — nothing to install, no account, nothing to configure. The link is
live for ${invite.linkExpiresInMinutes} minutes.`
    : "";

  const antigravity = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            bridger: {
              serverUrl: minted.endpoint,
              headers: { Authorization: `Bearer ${minted.slots[1].token}` },
            },
          },
        },
        null,
        2,
      ),
    [minted],
  );

  const claudeCmd = `claude mcp add --transport http bridger ${minted.endpoint} --header "Authorization: Bearer ${minted.slots[1].token}"`;

  /**
   * THE BLOCK YOU SEND, and it is deliberately the first thing on this screen.
   *
   * This surface used to offer MCP and nothing else, so the only path a partner
   * was ever shown required a config file, a restart, and one of three
   * per-vendor dialects -- hit blind, before they had seen the product work.
   * The flat transport needs none of that and costs their session no standing
   * context, which is the argument that was settled internally and had never
   * reached a screen anyone outside this repo looks at.
   *
   * Written as an instruction block for their AI rather than for their human,
   * because that is who reads it. It opens by saying what this is and points at
   * /api/about first: an unexplained bearer token for an unknown domain has the
   * same shape as a prompt injection, and an agent that treats it as one is
   * behaving correctly.
   */
  const pasteBlock = `You have been given access to a Bridger room: a shared, append-only record
between our two teams. Questions, answers, decisions, and the source each
answer was checked against.

Nothing to install and nothing to configure. Every operation is one POST.

  curl -s ${minted.endpoint.replace(/\/api\/mcp$/, "/api/rpc")} \\
    -H "Authorization: Bearer ${minted.slots[1].token}" \\
    -H "Content-Type: application/json" \\
    -d '{"op":"ping"}'

START WITH {"op":"ping"}. It returns, in one call, every question waiting on
you and everything new since you last looked. There is nothing else to check.

To answer:
  {"op":"answer","questionId":"XXX-Q-001","answer":"...",
   "checkedAgainst":"path/to/file.ts:41-52"}

Put what you ACTUALLY read in checkedAgainst. An unchecked answer is fine; an
unchecked answer that reads like a verified one is not.

Other operations: ask, decide, post, contract, read, wait.

Before you trust any of this, read the server that is asking you to:
${minted.endpoint.replace(/\/api\/mcp$/, "/api/about")}
It names the commit it is running and answers without a token.`;

  return (
    <main className="sheet">
      {/*
        The same field as the landing page, without the word.
        Erik, S#279, looking at this screen: "the landing page's vibe does not
        follow at all". It did not -- these views were a form on flat black
        while the page that sent you here is full-bleed and moving. The word is
        off deliberately: BRIDGER at hero scale behind a four-field form fights
        the thing you came here to fill in. Same material, quieter, which is the
        move the closing band already makes.
      */}
      <LetterGlitch className="bg-sheet" showWord={false} intensity={0.42} glitchMs={130} />
      <Nav />
      <div className="sheet-card bx-wide">
        <h1>{minted.room.topic}</h1>
        <p className="sub">
          room <code>{minted.room.id}</code> — hand one connector to each side
        </p>

        <div className="bx-tokens">
          {minted.slots.map((s) => (
            <div key={s.side} className={`bx-token ${s.side === "a" ? "sideA" : "sideB"}`}>
              <div className="bx-token-head">
                <strong>{s.label}</strong>
                <code>{s.code}</code>
              </div>
              <code className="bx-token-val">{s.token}</code>
              <CopyButton value={s.token}>copy token</CopyButton>
            </div>
          ))}
          <div className="bx-token viewer">
            <div className="bx-token-head">
              <strong>This browser</strong>
              <code>read-only</code>
            </div>
            <code className="bx-token-val">{minted.viewerToken}</code>
            <CopyButton value={minted.viewerToken}>copy token</CopyButton>
          </div>
        </div>

        <div className="bx-warn">
          {minted.note} A room nobody joins is deleted after{" "}
          {Math.round(minted.unclaimedExpiresInSeconds / 3600)} hours.
        </div>

        <div className="bx-handoff">
          <div className="bx-handoff-head">
            <div>
              <h2>Send this to them</h2>
              <p className="fine">
                A link rather than a token. It dies in minutes, mints exactly one credential, and
                hands their AI the whole protocol in one document — so the message you send stays
                worthless to anyone who finds it later.
              </p>
            </div>
            <button
              type="button"
              className="bx-primary bx-invite-make"
              onClick={makeInvite}
              disabled={inviteBusy}
            >
              {inviteBusy ? "minting…" : invite ? "new link" : "generate invite link"}
            </button>
          </div>

          {inviteError ? <p className="bx-invite-error">{inviteError}</p> : null}

          {invite ? (
            <div className="bx-invite">
              <code className="bx-invite-url">{invite.joinUrl}</code>
              <div className="bx-invite-actions">
                <CopyButton value={invite.joinUrl}>copy link</CopyButton>
                <CopyButton value={inviteMessage}>copy message</CopyButton>
              </div>
              <p className="fine">
                For <strong>{invite.forLabel}</strong>. Live for {invite.linkExpiresInMinutes}{" "}
                minutes; the token it mints lasts {invite.tokenExpiresInDays} days.
                {invite.replacedPreviousLink
                  ? " The previous link for this seat has stopped working."
                  : null}
              </p>
            </div>
          ) : null}

          {/*
            Kept, not deleted, and demoted rather than hidden. The token block
            works when a link cannot -- a partner behind something that mangles
            URLs, or one who wants a credential that outlives thirty minutes --
            and removing a working path to make a point is not an improvement.
          */}
          <details className="bx-details bx-handoff-fallback">
            <summary>Or hand over the token directly</summary>
            <p className="fine">
              Everything the link would have given them, inline. The tradeoff is that this message
              contains a live credential, so it stays valid for as long as the token does — in the
              chat, the inbox and the transcript.
            </p>
            <div className="bx-handoff-head">
              <div />
              <CopyButton value={pasteBlock}>copy the whole block</CopyButton>
            </div>
            <pre className="bx-handoff-body">{pasteBlock}</pre>
          </details>
        </div>

        <details className="bx-details">
          <summary>Or connect it as an MCP server (optional)</summary>
          <p className="fine">
            Better ergonomics where the client supports it: the tools are discoverable and the token
            lives in a config file the model never reads. The tradeoff is that an MCP tool schema is
            resident — it costs the far side context on every turn of their session, used or not, so
            it is the upgrade rather than the starting point. Every client needs the same two facts
            and differs only in what it calls the endpoint key.
          </p>
          <div className="bx-snippet">
            <div className="bx-snippet-head">
              Claude Code <CopyButton value={claudeCmd}>copy</CopyButton>
            </div>
            <pre>{claudeCmd}</pre>
          </div>
          <div className="bx-snippet">
            <div className="bx-snippet-head">
              Antigravity — <code>~/.gemini/config/mcp_config.json</code>
              <CopyButton value={antigravity}>copy</CopyButton>
            </div>
            <pre>{antigravity}</pre>
            <p className="fine">
              Antigravity wants <code>serverUrl</code> and rejects <code>url</code> and{" "}
              <code>httpUrl</code>. It keeps three of these files on disk and two are usually empty —
              use the IDE&rsquo;s <em>View raw config</em> button to find the live one.
            </p>
          </div>
        </details>

        <div className="bx-close-actions">
          <button
            type="button"
            className="bx-primary"
            onClick={makeInviteAndEnter}
            disabled={inviteBusy}
          >
            {inviteBusy ? "minting…" : "Generate link & open the room"}
          </button>
          <button type="button" className="link" onClick={() => onWatch(minted.viewerToken)}>
            open the room without a link
          </button>
        </div>
        {/*
          Said plainly rather than discovered. Leaving this screen loses YOUR
          connector -- the tokens above are shown once and are not recoverable,
          including by us. That was already true of the old "Watch this room"
          button; making the exit one click makes it likelier, so it gets a
          sentence instead of a shrug.
        */}
        <p className="fine bx-close-note">
          Your own connector is on this screen only. Copy it before you leave — a lost
          token is replaced with <code>bridger rotate</code>, not recovered.
        </p>
      </div>
    </main>
  );
}

// ── view: room (three panels) ────────────────────────────────────

function RoomView({
  token,
  onForget,
  invite,
}: {
  token: string;
  onForget: () => void;
  /** Present only just after creating a room; see `makeInviteAndEnter`. */
  invite?: InviteLink | null;
}) {
  const [data, setData] = useState<ExportPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [canWrite, setCanWrite] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [focus, setFocus] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const lastSeq = useRef(0);
  const [flash, setFlash] = useState<number | null>(null);
  /**
   * Counts real arrivals, and nothing else. It drives the packet that runs down
   * the wire in the header, so that animation can only be caused by something
   * actually landing in the record — not by a poll, a reconnect or a clock.
   */
  const [arrivals, setArrivals] = useState(0);

  /**
   * Three outcomes, not two, and the third one is the whole point.
   *
   * `STATUS.md` calls "does a real client stop on a terminal refusal?" the one
   * question none of the tests can answer. Measured in production S#279, the
   * answer was no, and the client that would not stop was OURS: this loop
   * rescheduled after EVERY failure, so a 403 `daily-cap` -- which the server
   * means as "this cannot succeed again today" -- was retried exactly like a
   * dropped packet. It ran for five days and 2,479 denied calls, and because a
   * quota REFUSAL burns a slot (ARCHITECTURE #32), the retries were spending the
   * budget they were being refused for.
   *
   * The signal was already on the wire: terminal refusals carry `terminal: true`
   * and moved to 403 in S#276 precisely so a client could tell. Nothing read it.
   */
  const load = useCallback(async (tok: string): Promise<"ok" | "retry" | "stop"> => {
    try {
      const res = await fetch("/api/export", { headers: { Authorization: `Bearer ${tok}` } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        // The body's own flag first; the status only as a fallback for a refusal
        // that predates the field or is shaped by the platform rather than us.
        const terminal =
          body?.terminal === true || res.status === 403 || res.status === 401 || res.status === 410;
        setError(
          res.status === 401
            ? `Token rejected (${body.error ?? "unknown"}). It may have been revoked, rotated, or expired.`
            : res.status === 410
              ? "This room has been closed."
              : body?.code === "daily-cap"
              ? // WRITTEN FOR A HUMAN, because this is the one refusal a person
                // reads rather than a model. S#280: Erik's friend saw the raw
                // code `daily-cap` and had no way to tell whether the room was
                // broken, the join had failed, or the record was lost. It was
                // none of those -- a watch tab had spent its own daily budget.
                "This watch tab has used up its daily budget of calls. " +
                "The room, the record and both sides' own tokens are unaffected — " +
                "it is this read-only viewer credential that is spent, and it resets at 00:00 UTC. " +
                "Ask whoever opened the room for a fresh viewer token if you need to keep watching today."
              : res.status === 429
                ? "Polling too fast — backing off and retrying automatically."
              : res.status === 503
                ? "The registry is unreachable — the server cannot read its own token store."
                : terminal
                  ? `${body.error ?? `Server said ${res.status}.`} Retrying will not change this — reload once it is resolved.`
                  : `Server said ${res.status}: ${body.error ?? ""}`,
        );
        setLive(false);
        return terminal ? "stop" : "retry";
      }
      const payload = (await res.json()) as ExportPayload;
      const newest = payload.entries.at(-1)?.seq ?? 0;
      if (lastSeq.current && newest > lastSeq.current) {
        setFlash(newest);
        setArrivals((n) => n + 1);
      }
      lastSeq.current = newest;
      setData(payload);
      setError(null);
      setLive(true);
      return "ok";
    } catch {
      // A thrown fetch is the network, not the server's verdict -- retry.
      setError("Cannot reach the bridge server. Is it running?");
      setLive(false);
      return "retry";
    }
  }, []);

  // Role is asked once, from whoami. Renaming is a participant action, so the
  // pencil must not appear on a read-only seat and then fail with a 403 —
  // offering an action you cannot perform is worse than not offering it.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/whoami", { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled) setCanWrite(Boolean(body?.you?.canWrite));
      } catch {
        /* the poll below surfaces connectivity problems; this is only the pencil */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // A self-rescheduling timeout rather than setInterval, so the delay can grow
  // on failure and snap back on the first success. setInterval cannot do that —
  // its period is fixed at creation, which is precisely why the rate-limited
  // state was unrecoverable.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    /**
     * THE BACKOFF SURVIVES A RELOAD, AND THAT IS THE WHOLE FIX (S#280).
     *
     * C0 fixed the poll RATE: back off when nothing changes, ceiling 120s,
     * budgeted at ~240 calls across an eight-hour day against a cap of 400.
     * The arithmetic was right and the assumption underneath it was not --
     * `delay` lived in this closure, so **every page load restarted the ramp at
     * four seconds** and paid the fast part again. Reloading is exactly what a
     * person does when a room looks stuck, and two tabs on one viewer token
     * double the whole thing. Measured tonight: 406 calls against a cap of 400,
     * on a room that had seen 12 entries all day.
     *
     * Persisted per room, so a reopened tab resumes at the pace the room had
     * earned rather than sprinting again. Read defensively: a corrupt or absent
     * value must start at full speed, never at the ceiling, because a viewer
     * that opens slow on a busy room is a worse failure than one extra call.
     */
    const paceKey = `bridger.pace.${token.slice(-8)}`;
    const savedPace = (() => {
      try {
        const n = Number(sessionStorage.getItem(paceKey));
        return Number.isFinite(n) && n >= POLL_MS && n <= POLL_IDLE_MAX_MS ? n : POLL_MS;
      } catch {
        return POLL_MS;
      }
    })();
    let delay = savedPace;
    const remember = (d: number) => {
      try {
        sessionStorage.setItem(paceKey, String(d));
      } catch {
        /* a private window simply does not get the benefit */
      }
    };

    const tick = async () => {
      const before = lastSeq.current;
      const outcome = await load(token);
      if (stopped) return;
      // A refusal the server calls terminal ends the loop. The error stays on
      // screen and a reload is the way back -- which is the correct cost, since
      // every retry here was spending the budget it was being refused for.
      if (outcome === "stop") return;
      if (outcome === "retry") {
        // An error backs off faster and to a lower ceiling: the goal there is to
        // recover, not to idle.
        delay = Math.min(Math.max(delay, POLL_MS) * 2, POLL_MAX_MS);
      } else if (lastSeq.current !== before) {
        // Something arrived. Back to full speed — the room is live again.
        delay = POLL_MS;
      } else {
        delay = Math.min(delay * POLL_IDLE_GROWTH, POLL_IDLE_MAX_MS);
      }
      remember(delay);
      timer = setTimeout(tick, delay);
    };

    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [token, load]);

  useEffect(() => {
    if (flash === null) return;
    const t = setTimeout(() => setFlash(null), 2000);
    return () => clearTimeout(t);
  }, [flash]);

  const roomId = data?.room.id;
  useEffect(() => {
    if (!roomId) return;
    try {
      setNames(JSON.parse(localStorage.getItem(TREE_KEY(roomId)) ?? "{}"));
    } catch {
      setNames({});
    }
  }, [roomId]);

  function renameFolder(key: string, label: string) {
    if (!roomId) return;
    const next = { ...names, [key]: label };
    setNames(next);
    localStorage.setItem(TREE_KEY(roomId), JSON.stringify(next));
  }

  async function saveName() {
    const topic = nameDraft.trim();
    setRenaming(false);
    if (!topic || !data || topic === data.room.topic) return;
    const res = await fetch("/api/rooms", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ topic }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "The room could not be renamed.");
      return;
    }
    void load(token);
  }

  const entries = data?.entries ?? [];
  const openIds = openQuestionIds(entries);
  const reopenedIds = new Set(
    entries.filter((e) => e.type === "reopen" && e.answers).map((e) => e.answers as string),
  );
  const open = entries.filter((e) => e.type === "question" && openIds.has(e.id));
  /**
   * An honest `opinion` is no longer counted as a failure to check.
   *
   * This counter and the feed had the same bug from the same cause: written
   * when `checkedAgainst` had two states, never revisited when S#279 gave it
   * three. Counting an opinion as "unchecked" re-creates the exact pressure
   * `basis` removed -- a number on screen that goes down if you invent a
   * citation. `inference` is counted the same way: it is a declared stance, not
   * an omission.
   */
  const uncheckedAnswers = entries.filter(
    (e) => e.type === "answer" && !e.checkedAgainst && e.basis === null,
  ).length;
  const thinEvidence = entries.filter((e) => {
    if (e.type !== "answer" || !e.checkedAgainst) return false;
    const c = classifyCitation(e.checkedAgainst);
    return isUnlocated(c) || isWideRange(c);
  }).length;
  const decisions = entries.filter((e) => e.type === "decision");

  /**
   * The dialogue, grouped. Memoised because it walks every entry on each poll
   * and the poll runs every four seconds in an active room.
   *
   * `mySide` comes from the export payload rather than from the token, because
   * this page authenticates with the read-only VIEWER seat -- a viewer belongs
   * to neither side, so `you` is whichever side the payload names and a viewer
   * simply sees side A on the right. That is honest: it says "this record has
   * two parties" without claiming the watcher is one of them.
   */
  const mySide = data?.room.you.side ?? "a";
  /** Which agent sits on a side, for the feed. Self-declared; may be absent. */
  const agentFor = (side: string) =>
    data ? (side === data.room.you.side ? data.room.you.agent : data.room.peer.agent) : null;
  const turns = useMemo(() => toTurns(entries, mySide), [entries, mySide]);

  /**
   * The record as markdown. Used by both the .md download and "copy for your
   * AI" — the same bytes either way, because a partner pasting the record into
   * their own session should get exactly what the file would have contained.
   */
  const asMarkdown = useCallback(() => {
    if (!data) return "";
    return [
      `# ${data.room.topic}`,
      ``,
      `Room \`${data.room.id}\` — ${data.room.you.label} and ${data.room.peer.label}`,
      `Exported ${data.exportedAt}`,
      ``,
      ...(data.contract
        ? [`## Contract`, ``, data.contract.body, ``, `_last changed by ${data.contract.updatedBy}_`, ``]
        : []),
      `## Record`,
      ``,
      ...entries.flatMap((e) => [
        `### ${e.id} — ${e.author} ${verbFor(e.type)}${e.answers ? ` → ${e.answers}` : ""}`,
        ``,
        e.title,
        ...(e.body && e.body !== e.title ? [``, e.body] : []),
        ...(e.why ? [``, `**Why:** ${e.why}`] : []),
        // The same three readings the screen shows, on the same rule. This is
        // the "copy for your AI" payload as well as the .md download, so a
        // partner's model reading the record must not be told an honest opinion
        // was an unchecked claim -- it would be reading a stricter version of
        // the ledger than the ledger.
        ...(e.checkedAgainst
          ? [``, `**Checked against:** \`${e.checkedAgainst}\``]
          : e.basis === "opinion"
            ? [``, `**Opinion** — no citation expected.`]
            : e.basis === "inference"
              ? [``, `**Inference** — reasoned, not read.`]
              : e.type === "answer"
                ? [``, `**Unchecked** — nobody named what this rests on.`]
                : []),
        ``,
      ]),
    ].join("\n");
  }, [data, entries]);

  /** The whole record, as the two files a person would actually keep. */
  function download(kind: "json" | "md") {
    if (!data) return;
    const stamp = data.exportedAt.slice(0, 10);
    const name = `bridger-${data.room.id}-${stamp}.${kind}`;
    const body = kind === "json" ? JSON.stringify(data, null, 2) : asMarkdown();

    const url = URL.createObjectURL(new Blob([body], { type: kind === "json" ? "application/json" : "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="bx-room">
      <header className="bx-top">
        {/*
          The wire, at 46px. `arrivals` only ever increments when an entry
          actually lands, so the packet crossing this strip is caused by the
          record and by nothing else.
        */}
        <div className="bx-top-wire">
          <LetterGlitch
            className="bg-strip"
            intensity={0.55}
            ping={arrivals}
            showWord={false}
          />
        </div>

        <div className="bx-top-bar">
          <div className="bx-title">
            {renaming ? (
              <input
                className="bx-rename"
                value={nameDraft}
                autoFocus
                maxLength={200}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={saveName}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveName();
                  if (e.key === "Escape") setRenaming(false);
                }}
              />
            ) : (
              <h1>
                {data?.room.topic ?? "…"}
                {canWrite && data && (
                  <button
                    type="button"
                    className="bx-pencil"
                    title="Rename this room"
                    onClick={() => {
                      setNameDraft(data.room.topic);
                      setRenaming(true);
                    }}
                  >
                    ✎
                  </button>
                )}
              </h1>
            )}
            <div className="meta bx-presence">
              {data ? (
                <>
                  {/*
                    Both parties, always both, and each carrying its own state.
                    The old line named them and then appended "-- has not
                    connected yet" as prose, which is the load-bearing fact of an
                    unstarted room written in the least visible way available.
                  */}
                  <SideChip
                    side={data.room.you.side}
                    label={data.room.you.label}
                    joinedAt={data.room.you.joinedAt}
                    agent={data.room.you.agent}
                    you
                  />
                  <span className="bx-chip-wire" aria-hidden="true" />
                  <SideChip
                    side={data.room.peer.side}
                    label={data.room.peer.label}
                    joinedAt={data.room.peer.joinedAt}
                    agent={data.room.peer.agent}
                  />
                  <span className="mono dim bx-roomid">room {data.room.id}</span>
                </>
              ) : (
                "connecting…"
              )}
            </div>
          </div>
          <div className="bx-actions">
            {/*
              The record, shaped for the reader it was built for. A partner's
              agent that cannot reach this room can still be handed everything
              in it, in the format a model reads best — the same bytes the .md
              download writes.
            */}
            <CopyButton value={asMarkdown()}>copy for your AI</CopyButton>
            <button type="button" className="bx-save" onClick={() => download("md")} disabled={!data}>
              Save .md
            </button>
            <button type="button" className="bx-save" onClick={() => download("json")} disabled={!data}>
              Save .json
            </button>
            <div className={`pulse ${live ? "on" : "off"}`}>
              <span className="led" />
              {live ? "live" : "stalled"}
            </div>
          </div>
        </div>
      </header>

      {/*
        THE INVITE, WHERE IT BELONGS.
        A link is a property of a room that is waiting for its second party, not
        of the one screen that happened to create it. Shown only while `invite`
        is in memory, which is only just after creating a room -- the point at
        which the other side definitionally has not joined.

        There is no GENERATE button here, and that is a real limit rather than an
        oversight: this view authenticates with the read-only VIEWER token, and
        minting a credential from a read-only seat is exactly what `opInvite`
        refuses. Re-issuing later is a participant action -- the CLI, or an rpc
        call with the side token.
      */}
      {invite && (
        <div className="bx-room-invite">
          <div>
            <strong>Waiting for {invite.forLabel}.</strong> Send them this — it is live for{" "}
            {invite.linkExpiresInMinutes} minutes.
          </div>
          <code>{invite.joinUrl}</code>
          <CopyButton value={invite.joinUrl}>copy link</CopyButton>
        </div>
      )}

      {error && <div className="error" style={{ margin: "12px 22px" }}>{error}</div>}

      {/*
        THE PLAN, WHILE PLANNING, IS THE PAGE.
        Three ownership columns in a 320px rail wrapped item ids across three
        lines — legible in a screenshot only if you already knew what it said.
        The fix is not a smaller font: during the plan phase this IS the work,
        so it gets the width, and the conversation stays below it.
      */}
      {data?.plan && data.room.phase === "plan" && (
        <div className="bx-board-wide">
          <PlanBoard
            plan={data.plan}
            you={data.room.you}
            peer={data.room.peer}
            phase={data.room.phase}
          />
        </div>
      )}

      <div className="bx-panels">
        {/* LEFT — the record, as browsable folders */}
        <aside className="bx-tree">
          <h2>Record</h2>
          {FOLDERS.map((f) => {
            // "Open questions" is the one folder that is not a plain type
            // filter: a question stops belonging there once it is answered, and
            // `openQuestionIds` is the shared predicate that knows a `reopen`
            // makes it open again. Every other folder is its types.
            const items = f.key === "open" ? open : entries.filter((e) => f.types.includes(e.type));
            return (
              <section key={f.key} className="bx-folder">
                <h3>
                  <input
                    className="bx-folder-name"
                    value={names[f.key] ?? f.label}
                    onChange={(e) => renameFolder(f.key, e.target.value)}
                    aria-label={`Rename the ${f.label} folder`}
                  />
                  <span className="bx-count">{items.length}</span>
                </h3>
                <ul>
                  {items.map((e) => (
                    <li key={e.id}>
                      <button
                        type="button"
                        className={`bx-leaf ${focus === e.id ? "on" : ""} ${e.side === "a" ? "sideA" : "sideB"}`}
                        onClick={() => setFocus(focus === e.id ? null : e.id)}
                      >
                        <code>{e.id}</code>
                        <span>{e.title}</span>
                      </button>
                    </li>
                  ))}
                  {items.length === 0 && <li className="bx-none">empty</li>}
                </ul>
              </section>
            );
          })}
          <p className="fine">
            Folder names are yours and stay in this browser. The contents are the room&rsquo;s real
            entries, grouped — nothing here is a second copy.
          </p>
        </aside>

        {/* CENTRE -- the dialogue. Position says who; colour confirms it. */}
        <section className="bx-chat">
          <div className="bx-chat-head">
            <h2>Conversation</h2>
            {focus && (
              <button type="button" className="link" onClick={() => setFocus(null)}>
                showing {focus} — show everything
              </button>
            )}
          </div>
          <div className={`feed ${focus ? "focused" : ""}`}>
            {entries.length === 0 && (
              <p className="empty">
                Nothing on the bridge yet. When either side calls <code>bridger_ask</code>, it
                appears here within {POLL_MS / 1000} seconds.
              </p>
            )}
            {turns.map((turn) => {
              const shown = turn.entries.filter(
                (e) => !focus || e.id === focus || e.answers === focus,
              );
              if (shown.length === 0) return null;
              return (
                <div
                  key={`${turn.entries[0].id}-turn`}
                  className={`turn ${turn.mine ? "mine" : "theirs"} ${
                    turn.side === "a" ? "sideA" : "sideB"
                  }`}
                >
                  <div className="turn-head">
                    <AgentMark agent={agentFor(turn.side)} side={turn.side} />
                    <span className="who">{turn.author}</span>
                    <span className="mono dim">{timeOf(shown[0].ts)}</span>
                  </div>
                  {shown.map((e) => (
                    <div className="row" key={e.id}>
                      <article className={`bubble t-${e.type} ${flash === e.seq ? "flash" : ""}`}>
                        {/*
                          The type stays on the bubble, always. A chat shape that
                          flattens `asks` / `decides` / `signs off` into "a
                          message" has thrown away the reason this is a record
                          rather than a chat log.
                        */}
                        <div className="head">
                          <span className="verb">{verbFor(e.type)}</span>
                          <code className="id">{e.id}</code>
                          {e.answers && (
                            <button
                              type="button"
                              className="ref"
                              title={`Show ${e.answers} and everything answering it`}
                              onClick={() => setFocus(focus === e.answers ? null : e.answers)}
                            >
                              → {e.answers}
                            </button>
                          )}
                          {reopenedIds.has(e.id) && <span className="reopened">reopened</span>}
                        </div>
                        {/*
                          AN ENTRY WHOSE BODY EQUALS ITS TITLE RENDERED BLANK.
                          The old pair of conditions was `!body.startsWith(title)`
                          for the title and `body !== title` for the body, so an
                          entry where the two are identical satisfied NEITHER and
                          the bubble showed a type badge, a citation, and no text
                          at all. `opAnswer` produces exactly that shape, which
                          means every answer in every room has been rendering
                          without its answer. Found S#280 by looking at a
                          screenshot -- the DOM assertions were all green.
                        */}
                        {!e.body ? (
                          <p className="title">{e.title}</p>
                        ) : e.body.startsWith(e.title) ? (
                          <p className="title">{e.body}</p>
                        ) : (
                          <>
                            <p className="title">{e.title}</p>
                            <p className="body">{e.body}</p>
                          </>
                        )}
                        {e.why && (
                          <p className="why">
                            <span>why</span> {e.why}
                          </p>
                        )}
                        <Provenance entry={e} />

                      </article>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </section>

        {/* RIGHT — what the two sides are going to do, then what they agreed */}
        <aside className="bx-agree">
          {/*
            In BUILD the plan is reference material and lives in the rail. In
            PLAN it is the work, and it sits full-width above the panels — see
            the block before `.bx-panels`. This is the phase shaping LAYOUT,
            which is half of what a phase was for and was doing nothing yet.
          */}
          {data?.plan && data.room.phase !== "plan" && (
            <PlanBoard
              plan={data.plan}
              you={data.room.you}
              peer={data.room.peer}
              phase={data.room.phase}
            />
          )}

          <h2>Agreements</h2>

          <section className="stats bx-stats">
            <div className={open.length ? "hot" : ""}>
              <strong>{open.length}</strong>
              <span>open</span>
            </div>
            <div className={uncheckedAnswers ? "flag" : ""}>
              <strong>{uncheckedAnswers}</strong>
              <span>unchecked</span>
            </div>
            <div
              className={thinEvidence ? "flag" : ""}
              title="Cited, but not to a place you could go and check. Counts the citation, not the answer."
            >
              <strong>{thinEvidence}</strong>
              <span>thin</span>
            </div>
          </section>

          {data?.contract ? (
            <div className="bx-contract">
              <h3>Contract</h3>
              <p className="meta">
                last changed by {data.contract.updatedBy} at {timeOf(data.contract.updatedAt)}
              </p>
              <pre>{data.contract.body}</pre>
            </div>
          ) : (
            <p className="bx-none">
              No contract yet. Either side writes one with <code>bridger_contract</code>.
            </p>
          )}

          <h3>Decisions</h3>
          {decisions.length === 0 && <p className="bx-none">Nothing decided yet.</p>}
          {decisions.map((dec) => (
            <div key={dec.id} className={`bx-decision ${dec.side === "a" ? "sideA" : "sideB"}`}>
              <code>{dec.id}</code>
              <strong>{dec.title}</strong>
              {dec.body && <p>{dec.body}</p>}
              {dec.why && (
                <p className="why">
                  <span>why</span> {dec.why}
                </p>
              )}
            </div>
          ))}

          {open.length > 0 && (
            <>
              <h3>Waiting on an answer</h3>
              {open.map((q) => (
                <div key={q.id} className={`openq ${q.side === "a" ? "sideA" : "sideB"}`}>
                  <code>{q.id}</code>
                  <span className="who">{q.author} asked</span>
                  <span className="qt">{q.title}</span>
                </div>
              ))}
            </>
          )}
        </aside>
      </div>

      <footer>
        <button className="link" onClick={onForget}>
          forget token
        </button>
        <span className="dim">read-only · every write goes through the MCP tools</span>
      </footer>
    </main>
  );
}

// ── shell ────────────────────────────────────────────────────────

export default function Bridger() {
  const [view, setView] = useState<"gate" | "create" | "minted">("gate");
  const [minted, setMinted] = useState<Minted | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [invite, setInvite] = useState<InviteLink | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (saved) setToken(saved);
    setReady(true);
  }, []);

  const watch = (t: string, inv?: InviteLink | null) => {
    sessionStorage.setItem(STORAGE_KEY, t);
    setToken(t);
    // Memory only: a link that mints a credential does not belong on disk, and
    // it expires long before a later reload would want it.
    if (inv !== undefined) setInvite(inv);
  };

  /**
   * BOOT WITHOUT GOING BLANK TO EVERY MACHINE THAT ASKS.
   *
   * This used to be `if (!ready) return <main className="gate" />` — and since
   * `ready` is false on the server, that WAS the server's entire output. Measured
   * on production S#279: 7,615 bytes and **zero characters of visible body text**.
   * Every claim, command and instruction on this page existed only once
   * JavaScript had run, on the page whose primary reader — Erik's framing — is a
   * partner's AI deciding whether this domain deserves a credential. It fetches
   * a URL; it does not run our React.
   *
   * The guard's REASON was sound: without it the gate flashes for a frame on
   * every reload of an already-watched room. But that wants VISIBILITY gated,
   * not EXISTENCE. The gate is rendered here in full — so it is in the HTML for
   * anything that reads HTML — and `.gate[data-booting]` hides it for the one
   * frame before the token is known. Same tree on the server and on the first
   * client render, so nothing to mismatch on hydration.
   */
  if (!ready) return <Gate booting onWatch={watch} onCreate={() => setView("create")} />;

  if (token) {
    return (
      <RoomView
        invite={invite}
        token={token}
        onForget={() => {
          sessionStorage.removeItem(STORAGE_KEY);
          setToken(null);
          setMinted(null);
          setView("gate");
        }}
      />
    );
  }
  if (view === "minted" && minted) return <TokenBox minted={minted} onWatch={watch} />;
  if (view === "create")
    return (
      <Create
        onCancel={() => setView("gate")}
        onMinted={(m) => {
          setMinted(m);
          setView("minted");
        }}
      />
    );
  return <Gate onWatch={watch} onCreate={() => setView("create")} />;
}
