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

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { openQuestionIds } from "@/lib/question-state";
import { buildEvidenceIndex } from "@/lib/evidence";
import { classifyCitation, describeCitation, isUnlocated, isWideRange } from "@/lib/citation";
import { defaultColourFor, monogramFor, vendorFor, SEAT_COLOURS } from "@/lib/seats";
import { ROOM_SHAPES } from "@/lib/room-shapes";
// Only for the COUNT in the trust panel's link. The claims themselves are
// rendered once, by `demo.tsx` — this page must never restate them (S#279).
// Derived rather than written, because "six" was hardcoded here and would have
// silently gone wrong the moment CHECKS grew, which it did in S#285.
import { CHECKS } from "@/lib/site-content";
import LetterGlitch from "./backgrounds/letter-glitch";
import Demonstration from "./demo";

/**
 * A seat id. Widened from `"a" | "b"` at S#281: a `trust` room still has
 * exactly two, a `solo` room has up to six. The viewer must not crash on a
 * room shape the server can legitimately produce.
 */
type Seat = "a" | "b" | "c" | "d" | "e" | "f";

interface Entry {
  id: string;
  seq: number;
  type: "question" | "answer" | "decision" | "note" | "contract" | "reopen" | "signoff";
  side: Seat;
  code: string;
  author: string;
  ts: string;
  title: string;
  body: string;
  answers: string | null;
  why: string | null;
  checkedAgainst: string | null;
  /**
   * The citation resolved to a URL, when its AUTHOR declared a repository.
   * Absent means no link — never an empty string, so a falsy check is enough.
   */
  checkedUrl?: string | null;
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
    /**
     * Every seat. Optional so an older server -- or a cached response from one
     * -- renders the two-party room correctly instead of an empty rail.
     */
    seats?: {
      side: Seat;
      label: string;
      code: string;
      joinedAt: string | null;
      agent?: string | null;
      colour?: string | null;
      you: boolean;
    }[];
    kind?: "trust" | "solo";
  };
  contract: { body: string; updatedBy: string; updatedAt: string } | null;
  plan?: {
    items: {
      id: string;
      title: string;
      note: string;
      owner: Seat | "both" | null;
      state: "open" | "agreed" | "dropped";
      raisedBy: Seat;
    }[];
    readiness: { complete: boolean; open: number; unowned: number; agreed: number; blocking: string[] };
  };
  entries: Entry[];
  exportedAt: string;
}

interface Slot {
  side: Seat;
  label: string;
  code: string;
  token: string;
}

interface Minted {
  room: { id: string; topic: string; createdAt: string; kind?: "trust" | "solo" };
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
const dayOf = (iso: string) => iso.slice(0, 10);

/**
 * A day label for the feed separator.
 *
 * Built from the ISO string in UTC on purpose: `timeOf` already slices UTC out
 * of the timestamp, so the whole feed has always been in UTC. Deriving the date
 * from a local `Date` would put a LOCAL day heading over UTC times, which is
 * wrong for exactly the readers most likely to notice -- two parties in
 * different timezones, which is this product's entire situation. The `UTC` tag
 * on the separator is the cheapest place to say so once for the whole column.
 */
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dayLabel(iso: string): string {
  const d = new Date(`${dayOf(iso)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return dayOf(iso);
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  if (dayOf(iso) === today) return "Today";
  if (dayOf(iso) === yesterday) return "Yesterday";
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Where this browser had read up to, per room. A private reading position. */
const SEEN_KEY = (roomId: string) => `bridger.seen.${roomId}`;

/**
 * Which rails are collapsed. GLOBAL, not per room: how wide you like your
 * reading column is a property of you and your screen, not of a conversation.
 */
const RAILS_KEY = "bridger.rails";

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
  side: Seat;
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
function Provenance({ entry, n }: { entry: Entry; n?: number }) {
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
    // Server-resolved, against the AUTHOR's repo. Deliberately not recomputed
    // here: the browser does not know which seat wrote this entry's citation
    // without threading the room through, and two resolvers would drift.
    const citeUrl = entry.checkedUrl ?? null;
    return (
      <p className={`prov ${weak ? "thin" : "ok"}`}>
        {/*
          The number is the whole borrow from Erik's reference: a claim and the
          artifact under it stop being a self-contained footnote and become a
          pointer into one index for the room. The path stays visible -- it is
          the evidence, and hiding it behind a chip would be style winning over
          the thing this field exists for.
        */}
        {n !== undefined ? (
          <span className="cite">{n}</span>
        ) : (
          <span className="glyph">{weak ? "◐" : "✓"}</span>
        )}
        checked against{" "}
        {/*
          THE CITATION BECOMES OPENABLE (S#281), when and only when its author
          declared a repository. The path stays exactly as written either way --
          it is the evidence, and a link that replaced the text with a friendly
          label would hide the thing this field exists for.

          `rel="noreferrer"` and `target="_blank"` because the destination is a
          host the FAR SIDE named: it is validated against a forge allow-list
          before it is ever stored, and it still does not get a referrer or a
          window handle from us.
        */}
        {citeUrl ? (
          <a className="prov-link" href={citeUrl} target="_blank" rel="noreferrer noopener">
            <code>{entry.checkedAgainst}</code>
            <span className="prov-out" aria-hidden="true">
              ↗
            </span>
          </a>
        ) : (
          <code>{entry.checkedAgainst}</code>
        )}
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
 * A BODY THAT CLAMPS ONLY IF IT ACTUALLY OVERFLOWS.
 *
 * The first version decided by CHARACTER COUNT, and that control could lie: at a
 * wide viewport 860 characters fits in six lines, so the button offered to "show
 * all 860 characters" when all 860 were already on screen. Small, but this
 * product's whole argument is that it does not say things it has not checked --
 * and a count is a guess about layout, not a reading of it.
 *
 * So it measures. The character count survives as a cheap pre-filter (no point
 * mounting an observer on a one-line note) and the control appears only when the
 * rendered text is genuinely taller than the clamp.
 */
function Clampable({ text, className, mine }: { text: string; className: string; mine: boolean }) {
  const ref = useRef<HTMLParagraphElement | null>(null);
  const [overflows, setOverflows] = useState(false);
  const [open, setOpen] = useState(false);
  /**
   * The open height, in real pixels.
   *
   * The obvious version transitions `max-height` from the clamp to something
   * huge, and it LOOKS like a snap: the element reaches its natural height long
   * before `max-height` finishes travelling to 200em, so all the easing happens
   * after there is anything left to see. Measured at 90ms into a 240ms
   * transition, the body was already at its final 546px.
   *
   * So it animates to the MEASURED height instead, and the whole 240ms is spent
   * on distance the reader can actually see.
   */
  const [openH, setOpenH] = useState<number | null>(null);

  // Layout effect, not effect: this reads geometry, and measuring after paint
  // would flash the control for a frame before deciding it was not needed.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => {
      if (el.classList.contains("clamped")) {
        setOverflows(el.scrollHeight > el.clientHeight + 4);
      } else {
        // Open, and the column changed width: keep the target honest or the
        // text clips at the old measurement.
        setOpenH(el.scrollHeight);
      }
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  return (
    <>
      <p
        ref={ref}
        className={`${className} ${open ? "" : "clamped"}`}
        style={open && openH ? { maxHeight: openH } : undefined}
      >
        {text}
      </p>
      {overflows && (
        <button
          type="button"
          className="bx-more"
          style={mine ? { alignSelf: "flex-end" } : undefined}
          onClick={() => {
            const el = ref.current;
            if (!open && el) setOpenH(el.scrollHeight);
            setOpen((v) => !v);
          }}
        >
          {open ? "show less" : "show all"}
        </button>
      )}
    </>
  );
}

/**
 * THE EVIDENCE INDEX — every artifact this room has actually rested on.
 *
 * Erik's reference was a chat with "pinned context sources and per-message
 * citations that map answers to evidence": numbered chips in the prose,
 * resolving to a numbered list in the rail. Taking the IDEA rather than the
 * layout, because we are the only ones who can do it honestly — a chat app
 * pins sources somebody chose in advance, while `checkedAgainst` records what
 * an author says they actually read to know a specific claim was true.
 *
 * So this is derived, never curated. Nobody "pins" anything: an artifact
 * appears here because somebody cited it, numbered by FIRST appearance so the
 * numbers are stable as the room grows, and carrying how many claims now rest
 * on it. That last count is the interesting one and nothing showed it before —
 * an artifact holding up six answers is a different risk from one holding up
 * a single note.
 */
/**
 * MOVED TO `lib/evidence.ts` (S#284).
 *
 * It lived here, which meant the human WATCHING a room could see what its
 * agreement rests on and the agent WRITING that agreement could not. One
 * implementation now serves both, for the same reason one set of rules serves
 * two transports: two aggregations of one record drift, and the drift shows up
 * as two parties reading the same evidence differently.
 */

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
  you: { side: string; label: string; code?: string };
  peer: { side: string; label: string; code?: string };
  phase?: string;
}) {
  const live = plan.items.filter((i) => i.state !== "dropped");
  // Disambiguated exactly like the feed. A board whose two owner columns are
  // both headed "claude" is worse than no board -- its entire job is saying who
  // holds what, and that was the complaint that started this pass.
  const same = you.label.trim().toLowerCase() === peer.label.trim().toLowerCase();
  const nameOf = (s: { label: string; code?: string }) =>
    same && s.code ? `${s.label} ${s.code}` : s.label;
  const columns = [
    { key: "yours", label: nameOf(you), side: you.side, items: live.filter((i) => i.owner === you.side) },
    { key: "both", label: "Both", side: null, items: live.filter((i) => i.owner === "both") },
    { key: "theirs", label: nameOf(peer), side: peer.side, items: live.filter((i) => i.owner === peer.side) },
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
function CopyButton({
  value,
  children,
  strong,
}: {
  value: string;
  children: React.ReactNode;
  /** Filled rather than outlined: for the copy that IS the step, not a convenience beside it. */
  strong?: boolean;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`bx-copy ${strong ? "strong" : ""} ${done ? "done" : ""}`}
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
function Nav({ over = false, spec = false }: { over?: boolean; spec?: boolean }) {
  return (
    <nav className={`nav ${over ? "nav-over" : ""} ${spec ? "nav-spec" : ""}`} aria-label="Bridger">
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
        {/*
          THE STAMP RIDES WITH THE NAME, not with the headline.
          Erik, S#282, moving the nameplate into the header: a maturity stamp
          belongs against the thing it qualifies, and that is the product name.
          It also stops `alpha` floating alone over the hero once the facts move
          up, which would have re-introduced exactly the badge we just removed.
        */}
        {spec && <b className="stage">alpha</b>}
      </a>
      {/*
        THE SPEC LINE, in the header field.
        Erik, S#282: *"we should move up this single element so its in the
        header above the Bridger forming in the background"*. It was sitting
        directly over the word it was supposed to introduce; up here it reads as
        what it is -- the plate on the front of the instrument -- and the hero is
        left with headline, sentence, button and clear air.

        Hidden on narrow viewports rather than wrapped: three facts folding onto
        a second line under the brand is a worse header than no facts at all.
      */}
      {spec && (
        <span className="nav-facts" aria-label="What Bridger is">
          <span>append-only</span>
          <span>two parties</span>
          <span>no model called</span>
        </span>
      )}
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
        {/*
          `wordY` 0.30, not the centre it was hardcoded at. The designer's note
          was that the word forming out of the noise is the best thing on the
          page and the type sits on top of it. Both moved: the word up to 30% of
          the hero, the content block down (see `.hero` padding), so the one
          moment this field exists for happens in clear air.
        */}
        <LetterGlitch className="bg-hero" word="BRIDGER" intensity={0.92} wordY={0.3} />
        <Nav over spec />
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
            {/*
              The label is wrapped because the sweep is a pseudo-element and a
              bare text node cannot be lifted above it. See `.hero-actions
              .bx-primary` in globals.css for what the sweep means.
            */}
            <button type="button" className="bx-primary" onClick={onCreate}>
              <span>Open a new room</span>
            </button>
          </div>
        </div>
      </section>

      <div className="gate-shell">
        {/*
          THE CURSOR WAKE AND THE CLICK RIPPLE — the whole middle of the page.

          Erik, S#282, pointing at React Bits' `Cursor Wave`: this part of the
          page should answer the mouse. The adaptation is his — glitched glyphs
          rather than coloured shapes — so it is the field the page already runs,
          given a reason to notice where you are.

          THE EXTENT TOOK THREE GOES AND EACH WRONG ONE WAS SMALLER THAN THIS.
          It was scoped first to the whole `.bx-demo` section, then narrowed to
          just its heading and steps, before Erik named the actual boundary:
          *"It should be under the div gate-body and the section bx-demo, it
          should cover the whole middle gate-shell but not the footer."* Both of
          my versions were reasoning about the demo module while the thing on
          screen is the MIDDLE OF THE PAGE — the token form and the trust panel
          are part of what a reader's cursor is moving over, and a field that
          starts halfway down reads as broken rather than deliberate.

          NOT THE FOOTER, and not the hero: both already run their own field at
          full strength (`.bg-foot`, `.bg-hero`), and both carry the word. This
          one is the quiet middle between them, so it is the one that reacts.
        */}
        <div className="gate-mid">
          {/*
            The wrapper is not decoration. It spans the module and carries the
            edge fade, while the canvas inside it is viewport-height and sticky
            — so opening a step cannot resize the field. See `.bg-mid-layer`.
          */}
          <div className="bg-mid-layer">
            <LetterGlitch
              className="bg-mid"
              showWord={false}
              pointer
              intensity={0.14}
              glitchMs={150}
            />
          </div>
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
            <a href="#verify">All {CHECKS.length} checks, each with the command that settles it ↓</a>
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
        </div>

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
          {/*
            A REAL FOOTER, because the wave was never one (S#285).

            A JudgeMySite review charged that the page "simply stops" — no footer
            region, no closure, no repeat of the primary action. I argued back
            that the mirrored wave IS the terminus and was wrong: the shipped
            markup was a lone `<canvas aria-hidden="true">`, so to a screen
            reader the page genuinely ended at the operator disclosure, and to
            anyone who had read this far there was nowhere to go.

            The wave stays — it was doing the visual half correctly. What was
            missing is the informational half: what this is, who runs it, where
            to check it, and one way back to the only action on the page.

            The button calls the SAME `onCreate` as the hero. The review's own
            proposed footer shipped a `<button>` with no handler, which is worse
            than no footer: a dead primary action teaches a reader the page is a
            mockup.
          */}
          <footer className="site-foot">
            <div className="site-foot-in">
              <div className="site-foot-id">
                <span className="site-foot-name">Bridger</span>
                <span className="site-foot-sub">
                  A shared, append-only record two teams’ AI sessions read and write.
                  Operated by Erik Hammarström, Stockholm · Apache-2.0
                </span>
              </div>

              <nav className="site-foot-nav" aria-label="About this service">
                <a href="https://github.com/Hammaarn/bridger">Source</a>
                <a href="https://github.com/Hammaarn/bridger/blob/master/VERIFY.md">
                  How to verify it
                </a>
                <a href="/api/about">What this server is</a>
                <a href="/llms.txt">llms.txt</a>
              </nav>

              <button type="button" className="bx-primary site-foot-cta" onClick={onCreate}>
                <span>Open a new room</span>
              </button>
            </div>
          </footer>
        </div>
      </div>
    </main>
  );
}

// ── view: create ─────────────────────────────────────────────────

/**
 * THE SEAT EDITOR — where a solo room's whole problem is solved or is not.
 *
 * The problem: six seats that are all your own models, several of them called
 * Claude something. Naming them is not enough, which S#280 learned the hard way
 * when the live room had `label: "claude"` on both sides.
 *
 * So the mark is DERIVED AS YOU TYPE. Type "Gemini" and the seat takes Google's
 * blue and a G; type "backend team" and it takes a monogram. Nothing is picked
 * from a dropdown, because the vendor is already in the word you just wrote and
 * asking twice is the kind of form people abandon.
 *
 * **The mark is a guess and never says otherwise.** A seat whose label we do not
 * recognise gets initials, not a fallback logo -- guessing wrong would put a
 * false statement about who is in the room into a product whose entire argument
 * is that its record can be trusted.
 */
const SEAT_ORDER = ["a", "b", "c", "d", "e", "f"] as const;
/** The case people actually arrive with, spelled out rather than "Model 1". */
const SEAT_PLACEHOLDERS = ["Claude", "Gemini", "GPT", "Mistral", "Llama", "Grok"];

function SeatFields({
  seats,
  setSeats,
  badField,
}: {
  seats: string[];
  setSeats: (s: string[]) => void;
  badField: string | null;
}) {
  const set = (i: number, v: string) => setSeats(seats.map((s, j) => (j === i ? v : s)));
  const add = () => setSeats([...seats, ""]);
  const drop = (i: number) => setSeats(seats.filter((_, j) => j !== i));
  const named = seats.filter((x) => x.trim()).length;

  return (
    <>
      <label>Who is at the table?</label>
      <div className="seatlist">
        {seats.map((value, i) => {
          const colour = defaultColourFor(SEAT_ORDER[i] ?? "a");
          const vendor = vendorFor(value);
          return (
            <div className="seatrow" key={i} style={{ ["--seat" as string]: `var(--sc-${colour.id})` }}>
              <span
                className={`seatmark ${vendor ? "vendor" : ""}`}
                style={vendor ? { ["--vh" as string]: vendor.hue } : undefined}
                title={vendor ? `Looks like ${vendor.name}` : "No vendor recognised — initials"}
                aria-hidden
              >
                {vendor ? vendor.glyph : monogramFor(value)}
              </span>
              <input
                value={value}
                onChange={(e) => set(i, e.target.value)}
                placeholder={SEAT_PLACEHOLDERS[i] ?? "Another model"}
                className={badField === `seats[${i}]` ? "bx-bad" : ""}
                maxLength={60}
                aria-label={`Seat ${i + 1}`}
              />
              {/*
                Removable only down to two. A one-seat room is a notepad, and
                the server refuses it -- so the button disappears at the floor
                rather than offering an action that would be rejected.
              */}
              {seats.length > 2 && (
                <button
                  type="button"
                  className="seatdrop"
                  onClick={() => drop(i)}
                  aria-label={`Remove seat ${i + 1}`}
                  title="Remove this seat"
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="seatfoot">
        {seats.length < 6 ? (
          <button type="button" className="link" onClick={add}>
            + add a seat
          </button>
        ) : (
          <span className="fine">Six is the most one room holds.</span>
        )}
        <span className="fine">
          {named < 2 ? "Name at least two." : `${named} named.`} Each gets its own token.
        </span>
      </div>
    </>
  );
}

function Create({ onMinted, onCancel }: { onMinted: (m: Minted) => void; onCancel: () => void }) {
  const [topic, setTopic] = useState("");
  const [you, setYou] = useState("");
  const [them, setThem] = useState("");
  /**
   * WHAT KIND OF ROOM, and it is the FIRST question because it changes every
   * question after it.
   *
   * This control used to be "Slots: [2] [3 disabled] [4 disabled]" followed by
   * a paragraph explaining that three was a rewrite of the room model. That
   * paragraph was honest and it was also the whole problem: the form's most
   * prominent interactive element did nothing, twice, and then apologised.
   * Solo mode did the rewrite, so the dead buttons become a real choice
   * between two things the product genuinely does.
   */
  const [kind, setKind] = useState<"trust" | "solo">("trust");
  /**
   * Solo seats. Three by default, because the case people arrive with is
   * "my three subscriptions" -- and because two of anything looks like the
   * trust room they just chose not to open.
   */
  const [seats, setSeats] = useState<string[]>(["", "", ""]);
  /**
   * F2. Null means "whatever this room kind defaults to" -- trust rooms open in
   * `plan`, solo rooms in `build`. Kept as null rather than pre-selected so the
   * form does not claim the operator made a choice they never made, and so the
   * server keeps owning the default.
   */
  const [shape, setShape] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [badField, setBadField] = useState<string | null>(null);
  /**
   * WHY THE BUTTON IS DEAD, as a sentence rather than as a colour.
   *
   * The submit used to inline the same boolean and say nothing about it, so an
   * operator with one empty field got a greyed control and no reason. This
   * names the FIRST missing thing, in the order the form asks for it, so the
   * hint points at where they are rather than listing everything at once.
   * Null means nothing is missing.
   */
  const blocker: string | null = !topic
    ? "Name what this room is for."
    : kind === "solo"
      ? seats.filter((x) => x.trim()).length < 2
        ? "Name at least two models."
        : null
      : !you
        ? "Name your side."
        : !them
          ? "Name their side."
          : you.trim().toLowerCase() === them.trim().toLowerCase()
            ? "Give the two sides different names — the record uses the label to say who wrote."
            : null;
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
        body:
          kind === "solo"
            ? JSON.stringify({
                kind: "solo",
                topic,
                seats: seats.map((x) => x.trim()),
                ...(shape ? { shape } : {}),
              })
            : JSON.stringify({ topic, you, them, ...(shape ? { shape } : {}) }),
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
        <p className="sub">
          {kind === "trust"
            ? "Two companies, one record, and a token each."
            : "Your own models, one room, and a token each."}
        </p>

        <form onSubmit={submit}>
          {/*
            THE FIRST DECISION, and it is a pair of cards rather than a radio
            group. The two options are not two values of one setting -- they
            are two different products sharing a transport, and the form below
            changes completely between them. A card can carry the sentence that
            makes the choice obvious; a radio label cannot.
          */}
          <label>What is this room?</label>
          <div className="kindpick">
            <button
              type="button"
              className={`kindcard ${kind === "trust" ? "on" : ""}`}
              onClick={() => setKind("trust")}
              aria-pressed={kind === "trust"}
            >
              <span className="kindcard-t">Two companies</span>
              <span className="kindcard-d">
                You and a partner. Neither side can rewrite the record, and their text
                arrives marked as theirs.
              </span>
            </button>
            <button
              type="button"
              className={`kindcard ${kind === "solo" ? "on" : ""}`}
              onClick={() => setKind("solo")}
              aria-pressed={kind === "solo"}
            >
              <span className="kindcard-t">Your own models</span>
              <span className="kindcard-d">
                Claude, Gemini, GPT — up to six seats on subscriptions you already pay
                for. No partner, no invitations.
              </span>
            </button>
          </div>

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

          {kind === "solo" ? (
            <SeatFields seats={seats} setSeats={setSeats} badField={badField} />
          ) : (
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

          )}

          {/*
            F2. The SECOND decision, and deliberately after the identities: who
            is in the room is a fact the operator already knows, while how it
            should start is a preference they may not have thought about. Asking
            the known thing first means the unknown one arrives with context.
          */}
          <label>How should it start?</label>
          <div className="kindpick shapepick">
            {ROOM_SHAPES.map((sh) => {
              const isDefault =
                shape === null && sh.phase === (kind === "solo" ? "build" : "plan");
              return (
                <button
                  key={sh.id}
                  type="button"
                  className={`kindcard ${shape === sh.id || isDefault ? "on" : ""}`}
                  onClick={() => setShape(sh.id)}
                  aria-pressed={shape === sh.id || isDefault}
                >
                  <span className="kindcard-t">{sh.name}</span>
                  {/* The stages, shown rather than described. This is the part
                      that differs between the two presets, and it was the one
                      part neither card displayed. */}
                  <span className="shapestages" aria-label={`Stages: ${sh.stages.join(", then ")}`}>
                    {sh.stages.map((st, i) => (
                      <Fragment key={st}>
                        {i > 0 && <i aria-hidden="true">→</i>}
                        <b>{st}</b>
                      </Fragment>
                    ))}
                  </span>
                  <span className="kindcard-d">{sh.effect}</span>
                </button>
              );
            })}
          </div>
          <p className="fine" style={{ marginTop: -6, marginBottom: 14 }}>
            Neither one blocks anything -- a room can record a decision in either, and the
            phase can be moved at any time. It changes what the room SUGGESTS next.
          </p>

          {/*
            The trust room's two-ness is now a PROPERTY rather than a limit, so
            this says what it means instead of apologising for a disabled
            button. A third company changes what the record IS -- who an answer
            closes a question for, who a contract binds -- and those are
            unanswered questions, not missing code.
          */}
          {kind === "trust" && (
            <p className="fine" style={{ marginTop: 9 }}>
              Exactly two. A third company changes what the record means, not just how many
              seats it has — for several of your <em>own</em> models, pick the other card.
            </p>
          )}

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

          {/*
            A DISABLED BUTTON THAT SAYS WHAT IS MISSING.
            Gemini's S#282 audit flagged this control for contrast and cited
            WCAG AA -- which is wrong twice: it measured white-on-grey where the
            page renders dark-on-light at ~3.5:1, and SC 1.4.3 exempts inactive
            controls anyway. But there IS a defect here and it is our own,
            stricter rule (shipping-quality#13): a disabled button must explain
            itself, and this one carried no title, no hint, nothing. A reader
            with an empty field saw a dead button and no reason.
          */}
          <div className="bx-row">
            <button
              type="submit"
              className="bx-primary"
              title={blocker ?? undefined}
              aria-describedby={blocker ? "why-blocked" : undefined}
              disabled={Boolean(busy || blocker)}
            >
              {busy ? "Opening…" : kind === "solo" ? "Open the room" : "Open the room"}
            </button>
            <button type="button" className="link" onClick={onCancel}>
              back
            </button>
          </div>
          {/* Visible, not only a tooltip: a title attribute is invisible on
              touch and to anyone not hovering, which is most people. */}
          {blocker && !busy && (
            <p className="bx-blocked" id="why-blocked">
              {blocker}
            </p>
          )}
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
  expiresAt: string;
}

function formatInviteRemaining(ms: number): string {
  if (ms <= 0) return "expired";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function InviteCountdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [expiresAt]);
  const end = Date.parse(expiresAt);
  const remaining = Number.isFinite(end) ? end - now : 0;
  const expired = remaining <= 0;
  return (
    <time
      className={`bx-invite-countdown${expired ? " expired" : ""}`}
      dateTime={expiresAt}
      title={expiresAt}
    >
      {expired ? "expired — mint a new one" : `${formatInviteRemaining(remaining)} left`}
    </time>
  );
}

function TokenBox({
  minted,
  onWatch,
}: {
  minted: Minted;
  onWatch: (t: string, invite?: InviteLink | null) => void;
}) {
  /**
   * A solo room has no partner, so three things on this screen mean nothing in
   * it: the invitation, the "hand one to each side" subtitle, and the
   * unclaimed-room deadline. Derived once here rather than tested three times.
   */
  const isSolo = minted.room.kind === "solo";
  /**
   * THE INVITE LINK, and why it is the primary handoff now.
   *
   * This screen's only way to invite anyone used to be the raw `br_live_...`
   * token below — so the recommended action was to paste a live credential into
   * a chat message, which is durable, forwardable and screenshot-able. It is
   * also the exact artefact a partner's AI is right to refuse: the partner's
   * Claude declined precisely that in S#275 and its reasoning was correct.
   *
   * A `/j/<code>` link is not a credential. It dies in hours, it mints exactly
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
   * for no gain -- a reload after the fuse burns would find it expired anyway.
   */
  /**
   * THE LINK EXISTS BEFORE YOU ASK FOR IT (S#283, Erik).
   *
   * "Literally 1 button to generate a link -> send to the other end -> they
   * join." The button was already there; the problem was that it produced the
   * link on a SECOND action, after a screen showing five other things, so the
   * one artifact you actually need was the one thing not on screen yet.
   *
   * A trust room always needs exactly one invite, so waiting to be asked buys
   * nothing. Minting it on arrival costs one call at the moment the room is
   * created -- the moment it is most certainly wanted.
   */
  const autoMinted = useRef(false);
  useEffect(() => {
    if (isSolo || invite || inviteBusy || autoMinted.current) return;
    // A REF, not the `invite` state, because state has not landed yet when the
    // effect runs a second time. React 19's StrictMode invokes effects twice in
    // development, so the state guard alone minted TWO links -- the second
    // superseding the first, which made a brand-new room announce "the previous
    // link for this seat has stopped working". Harmless in production and
    // alarming on screen, which is the worst combination: it would have read as
    // a real defect to every reader and reproduced for none of them.
    autoMinted.current = true;
    void makeInvite();
    // Once, on arrival. `invite` and `inviteBusy` guard re-entry; adding
    // makeInvite here would re-fire on every render that redefines it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSolo]);

  async function makeInviteAndEnter() {
    // A live URL is already the door. Reminting here was how two links looked
    // current at once: the button said "Open the room" and still superseded.
    const link = invite ?? (await makeInvite());
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
        // Server default is hours (I1). Do not override it here: the two clocks
        // are the link fuse and the token lifetime, and only the fuse is ours
        // to lengthen. Token TTL stays the operation default.
        body: JSON.stringify({ op: "invite" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setInviteError(body.error ?? `The server said ${res.status}.`);
        return null;
      }
      const minutes = Number(body.linkExpiresInMinutes) || 0;
      const link: InviteLink = {
        joinUrl: String(body.joinUrl ?? ""),
        forLabel: String(body.forLabel ?? ""),
        linkExpiresInMinutes: minutes,
        tokenExpiresInDays: Number(body.tokenExpiresInDays) || 0,
        replacedPreviousLink: Boolean(body.replacedPreviousLink),
        expiresAt:
          typeof body.expiresAt === "string" && body.expiresAt
            ? body.expiresAt
            : new Date(Date.now() + minutes * 60_000).toISOString(),
      };
      setInvite(link);
      return link;
    } catch {
      setInviteError("Could not reach the bridge server.");
      return null;
    } finally {
      setInviteBusy(false);
    }
  }

  const inviteMessage = invite
    ? `Paste this URL into your agent / Claude Desktop:

${invite.joinUrl}

This URL is ONE seat. A second model that fetches it joins as the same side, not the other company.

Claude Desktop:
Settings → Connectors → Add custom connector
URL: ${minted.endpoint}
Then in chat: fetch the join URL and follow the protocol.

Live for ${
      invite.linkExpiresInMinutes >= 120
        ? `${Math.round(invite.linkExpiresInMinutes / 60)} hours`
        : `${invite.linkExpiresInMinutes} minutes`
    }.`
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
          room <code>{minted.room.id}</code> —{" "}
          {isSolo ? "one connector per model, all yours" : "keep yours, send theirs"}
        </p>

        {/*
          WHAT THIS BLOCK HAD TO FIX, and it was not styling.
          Erik, S#282, looking at a real minted screen: a novice cannot tell
          what any of these are for, and "Read-Only room token is exactly the
          same as the models tokens". He is right on both counts, and the second
          is the sharper one -- all three are `br_live_...`, identical in shape,
          each under an identical `copy token` button. The ONLY thing separating
          a write credential from a watch pass was a small grey word.

          The role is not a privilege bug: `canWrite` is `role !== "viewer"` in
          room-registry.ts, and a viewer is refused server-side. The bug is that
          nothing on this screen tells you WHICH ONE YOU ARE HOLDING, so the way
          to hand out the wrong one is simply to copy the wrong box.

          So every card now leads with its JOB -- who it is for and what it does
          -- before it shows a single character of the credential.
        */}
        {/*
          THE INVITE COMES FIRST (S#283, Erik: "literally 1 button to generate a
          link -> send to the other end -> they join").

          It used to sit FOURTH, under three credential cards and a warning, so
          the one artifact the operator actually has to act on was the last
          thing they reached -- and the card above it showed the partner's raw
          token, which is the wrong thing to send. Placement was doing the
          opposite of what the copy was saying.
        */}
        {/*
          The whole INVITE CEREMONY -- the link block and the generate-and-enter
          action -- is a trust-room thing. Two siblings, so a fragment: there is
          no wrapper element to reuse and adding one would change the layout for
          the room type that already works.
        */}
        {!isSolo && (
          <>
        <div className="bx-handoff">
          <div className="bx-handoff-head">
            <div>
              <h2>
                {invite
                  ? `1 · Current link for ${invite.forLabel}`
                  : "1 · Send this link to them"}
              </h2>
              <p className="fine">
                Paste this URL into your agent / Claude Desktop.
              </p>
            </div>
            <button
              type="button"
              className="bx-primary bx-invite-make"
              onClick={makeInvite}
              disabled={inviteBusy}
            >
              {inviteBusy ? "Minting…" : invite ? "New link" : "Generate invite link"}
            </button>
          </div>

          {inviteError ? <p className="bx-invite-error">{inviteError}</p> : null}

          {invite ? (
            <div className="bx-invite">
              {invite.replacedPreviousLink ? (
                <p className="bx-invite-replaced" role="status">
                  The previous link for this seat no longer works. This is the current one.
                </p>
              ) : null}
              <code className="bx-invite-url">{invite.joinUrl}</code>
              <div className="bx-invite-actions">
                <CopyButton value={invite.joinUrl} strong>
                  Copy link
                </CopyButton>
                <CopyButton value={inviteMessage}>copy message</CopyButton>
              </div>
              <p className="fine">
                One current URL for <strong>{invite.forLabel}</strong>.{" "}
                <InviteCountdown expiresAt={invite.expiresAt} />
                . The token it mints lasts {invite.tokenExpiresInDays} days.
                A second model on this same URL is the same seat, not the other side.
              </p>
              <p className="bx-invite-desktop">
                <strong>Claude Desktop.</strong> Settings → Connectors → Add custom
                connector. URL: <code>{minted.endpoint}</code>
                <br />
                Then in chat: fetch the join URL and follow the protocol.
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
            {/*
              The label has to follow the state. Since the link is now minted on
              arrival (S#283), "Generate link" was describing work already done
              -- and a button offering to do a thing that is visibly done reads
              as "did it not work?", which is the opposite of the reassurance a
              primary action owes.
            */}
            {inviteBusy ? "minting…" : invite ? "Open the room" : "Generate link & open the room"}
          </button>
          <button type="button" className="link" onClick={() => onWatch(minted.viewerToken)}>
            open the room without a link
          </button>
        </div>
          </>
        )}

        <div className="bx-tokens-intro">
          {/*
            "Two connectors and a watch pass" was true until the partner's raw
            token stopped being shown here (S#283). A trust room now hands you
            YOUR connector and a watch pass; their seat is the invite above.
            A heading that counts wrong is a small lie in the one place a
            reader is trying to work out what they are holding.
          */}
          <h2>
            {isSolo
              ? `${minted.slots.length} connectors, all yours`
              : "2 · Paste your connector into your AI"}
          </h2>
          <p className="fine">
            {/* Was four lines of what a connector IS. This is what you DO. */}
            This is your seat. Without it, your own AI is not in the room.
          </p>
        </div>

        <div className="bx-tokens">
          {minted.slots
            /**
             * THE SCREEN USED TO SHOW THE ARTIFACT IT TELLS YOU NOT TO SEND.
             *
             * The partner's card carried the words "This is theirs, not yours.
             * Send the invite link below instead" -- while displaying the token
             * in a copy box, above the link, in a stack of equals. Erik sent the
             * wrong one on the first real test. That is not a reading failure;
             * it is a screen offering two ways to do one job and giving the
             * worse one better placement.
             *
             * So in a trust room the partner's seat is represented by the INVITE
             * and nothing else. The raw token still exists and is still
             * reachable -- "Or hand over the token directly" is directly below,
             * for the air-gapped partner and the client that cannot fetch a URL.
             * A solo room has no partner, so every slot there is yours and the
             * filter does not apply.
             */
            .filter((s) => isSolo || s.side !== "b")
            .map((s) => {
            // side "a" is `ownerToken` and side "b" is `peerToken`
            // (app/api/rooms/route.ts:371-374), which are exactly the "Your
            // side" and "Their side" fields the create form asked for. The
            // screen has always known which one you keep; it never said so.
            const mine = s.side === "a";
            return (
              <div key={s.side} className={`bx-token ${s.side === "a" ? "sideA" : "sideB"}`}>
                <div className="bx-token-head">
                  <strong>{s.label}</strong>
                  <code className="bx-token-code">{s.code}</code>
                  <span className={`bx-token-role ${isSolo ? "" : mine ? "mine" : "theirs"}`}>
                    {isSolo ? "writes" : mine ? "yours" : "theirs"}
                  </span>
                </div>
                <p className="bx-token-job">
                  {isSolo ? (
                    <>
                      Paste into <strong>{s.label}</strong>. Anything it writes is signed{" "}
                      <code>{s.code}</code> in the record.
                    </>
                  ) : mine ? (
                    <>
                      <strong>Keep this one.</strong> Paste it into your own AI — it reads the room
                      and writes as <strong>{s.label}</strong>.
                    </>
                  ) : (
                    <>
                      <strong>This is theirs, not yours.</strong> Send the invite link below
                      instead where you can — a link expires, a pasted token does not.
                    </>
                  )}
                </p>
                <code className="bx-token-val">{s.token}</code>
                <CopyButton value={s.token} strong={s.side === "a" && !isSolo}>
                  {s.side === "a" && !isSolo ? "Copy connector" : "copy connector"}
                </CopyButton>
              </div>
            );
          })}
          <div className="bx-token viewer">
            <div className="bx-token-head">
              <strong>Watch in this browser</strong>
              <span className="bx-token-role ro">reads only</span>
            </div>
            <p className="bx-token-job">
              <strong>Not a connector — do not send it to anyone as one.</strong> This tab is
              already using it. It can read the record and nothing else: every write is refused,
              and it draws on its own budget rather than the room&rsquo;s.
            </p>
            <code className="bx-token-val">{minted.viewerToken}</code>
            <CopyButton value={minted.viewerToken}>copy watch pass</CopyButton>
          </div>
        </div>

        <div className="bx-warn">
          {minted.note}{" "}
          {/*
            ZERO means "no such deadline", not "a deadline of zero" -- a solo
            room is claimed the instant it exists, because every seat is yours.
            Rendering `0 hours` would have told the operator their room was
            already dead.
          */}
          {minted.unclaimedExpiresInSeconds > 0 &&
            `A room nobody joins is deleted after ${Math.round(
              minted.unclaimedExpiresInSeconds / 3600,
            )} hours.`}
        </div>

        {/*
          A solo room has no invitation to send, so the exit is a plain one.
        */}
        {isSolo && (
          <div className="bx-row" style={{ marginTop: 18 }}>
            <button
              type="button"
              className="bx-primary"
              onClick={() => onWatch(minted.viewerToken)}
            >
              Open the room
            </button>
          </div>
        )}
        {/*
          Said plainly rather than discovered. Leaving this screen loses YOUR
          connector -- the tokens above are shown once and are not recoverable,
          including by us. That was already true of the old "Watch this room"
          button; making the exit one click makes it likelier, so it gets a
          sentence instead of a shrug.
        */}
        <p className="fine bx-close-note">
          {/*
            THIS ADVICE WAS FALSE FOR THE AUDIENCE MOST LIKELY TO NEED IT (S#283).

            It said a lost token is replaced with `bridger rotate`. That command
            calls `operatorStore()`, which requires Upstash credentials -- so a
            browser-only operator, who is exactly the person who just made a
            room by clicking, CANNOT run it. For them a closed tab meant their
            side of the room was gone for good, and the screen pointed them at
            a recovery that does not exist on their machine.
          */}
          <strong>Copy your connector before you close this tab.</strong> It is shown here and
          nowhere else — only its hash is stored, so nobody can look it up again, including us.
          Without it you would have to open a new room.
        </p>
      </div>
    </main>
  );
}

/**
 * WAKE — the one control that makes this service call outward.
 *
 * THE HONEST LIMIT IS THE FIRST THING IT SAYS, because the word "wake" invites
 * exactly the wrong assumption. This POSTs to an endpoint that is ALREADY
 * LISTENING. It cannot make a language model start a turn; nothing can, and a
 * server that could would be able to burn its caller's quota at will. A Claude
 * Code or Cursor session is not a listening process, and the copy sends those
 * readers to the client-side stop hook rather than letting them register an
 * endpoint they do not have.
 *
 * TWO CREDENTIALS SEE THIS DIFFERENTLY, and that is not a bug to paper over.
 * This view is usually opened with a read-only watch pass, and a viewer must
 * not be able to make the server POST anywhere — `opWebhook` refuses it. So a
 * viewer sees STATE and no controls; a participant token gets the toggle. The
 * peer's row is always a boolean, never their URL: their endpoint is their
 * infrastructure, and the only fact that changes how you write is whether they
 * will be woken at all.
 */
function WakeToggle({ token, canWrite }: { token: string; canWrite: boolean }) {
  const [state, setState] = useState<{
    yours: { url: string; failCount: number; lastStatus: string | null } | null;
    peerHasWebhook: boolean;
  } | null>(null);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const call = useCallback(
    async (body: Record<string, unknown>) => {
      const res = await fetch("/api/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ op: "webhook", ...body }),
      });
      // The flat transport is flag-gated. If it is off, this control simply is
      // not available rather than reporting a fault the reader cannot act on.
      if (res.status === 404) {
        setUnavailable(true);
        return null;
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? "That did not work.");
      return json;
    },
    [token],
  );

  const refresh = useCallback(async () => {
    try {
      const j = await call({ action: "status" });
      if (j) setState({ yours: j.yours ?? null, peerHasWebhook: Boolean(j.peerHasWebhook) });
    } catch {
      /* a wake control that cannot read its own state stays quiet */
    }
  }, [call]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (unavailable || !state) return null;

  const on = Boolean(state.yours);

  async function register() {
    setBusy(true);
    setErr(null);
    try {
      const j = await call({ action: "register", url: url.trim() });
      if (j) {
        setSecret(j.secret ?? null);
        setOpen(false);
        setUrl("");
        await refresh();
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setErr(null);
    try {
      await call({ action: "remove" });
      setSecret(null);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bx-wake">
      <div className="bx-wake-row">
        <span className={`bx-wake-led ${on ? "on" : ""}`} aria-hidden />
        <strong>Wake my agent</strong>
        <span className="bx-wake-state">
          {on ? "registered" : "off"}
          {state.yours && state.yours.failCount > 0
            ? ` · ${state.yours.failCount} failed ${state.yours.failCount === 1 ? "delivery" : "deliveries"}`
            : ""}
        </span>
        {canWrite && (
          <button
            type="button"
            className="bx-wake-btn"
            disabled={busy}
            onClick={() => (on ? void remove() : setOpen((v) => !v))}
          >
            {on ? "turn off" : open ? "cancel" : "turn on"}
          </button>
        )}
      </div>

      <p className="bx-wake-note">
        {on
          ? "We POST to your endpoint when the other side writes — never on your own writes, and metadata only: never a title or a body."
          : "Bridger POSTs to an endpoint you register when the other side writes. It wakes a process that is already listening; it cannot make a model start a turn. If you are Claude Code or Cursor, install the stop hook in integrations/claude-code/ instead."}
        {" "}
        <span className="bx-wake-peer">
          {state.peerHasWebhook
            ? "Their side is registered, so they will be woken."
            : "Their side is not registered — write as though nobody is watching for it."}
        </span>
      </p>

      {!canWrite && (
        <p className="bx-wake-note bx-wake-ro">
          You are watching with a read-only pass, so this is state rather than a
          control. Registering makes the server act on your behalf, which a watch
          pass deliberately cannot do.
        </p>
      )}

      {open && canWrite && (
        <div className="bx-wake-form">
          <input
            type="url"
            value={url}
            placeholder="https://your-gateway.example/hooks/bridger"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && url.trim()) void register(); }}
          />
          <button type="button" className="bx-wake-btn" disabled={busy || !url.trim()} onClick={() => void register()}>
            register
          </button>
          <span className="bx-wake-note">
            Public https only. Loopback, private ranges and the cloud metadata
            address are refused, and redirects are never followed.
          </span>
        </div>
      )}

      {/* Shown once, like a minted token, and never fetched back. */}
      {secret && (
        <div className="bx-wake-secret">
          <strong>Signing secret — shown once.</strong> Every delivery carries{" "}
          <code>X-Bridger-Signature: sha256=&lt;hex HMAC of the raw body&gt;</code>.
          Reject anything that does not verify.
          <code className="bx-wake-key">{secret}</code>
          <CopyButton value={secret}>copy secret</CopyButton>
        </div>
      )}

      {err && <div className="error">{err}</div>}
    </div>
  );
}

/**
 * DECLARE YOUR REPO — the least discoverable control in the product (V3).
 *
 * `TODO.md` row 10 said for three sessions that repo permalinks were "shipped
 * and server-proven; no partner has ever declared a repo." It was never a
 * mystery. Declaring one is an optional argument on `bridger_identify` and
 * nothing else — reachable only by an agent that read four optional fields in
 * a tool description closely enough to notice. The OPERATOR, who is the person
 * who actually knows the repository URL, had no way to set it at all.
 *
 * So the highest-value item in the whole citation lane was gated behind a
 * control no human could reach. This is that control.
 *
 * Participant-only, and not by choice: `opIdentify` calls `requireWrite`, so a
 * read-only watch pass cannot even READ its own identity. Correct — a viewer
 * belongs to neither side and has no identity to declare.
 */
function RepoDeclaration({ token, canWrite }: { token: string; canWrite: boolean }) {
  const [repo, setRepo] = useState<{ host: string; owner: string; name: string; ref: string; pinned: boolean } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const call = useCallback(
    async (body: Record<string, unknown>) => {
      const res = await fetch("/api/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ op: "identify", ...body }),
      });
      if (res.status === 404) return null;
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? "That did not work.");
      return json;
    },
    [token],
  );

  useEffect(() => {
    if (!canWrite) return;
    void (async () => {
      try {
        const j = await call({});
        if (j) setRepo(j.repo ?? null);
      } catch {
        /* a control that cannot read its own state stays quiet */
      } finally {
        setLoaded(true);
      }
    })();
  }, [call, canWrite]);

  if (!canWrite || !loaded) return null;

  async function save(next: { repo: string | null; repoRef?: string | null }) {
    setBusy(true);
    setErr(null);
    try {
      const j = await call(next);
      if (j) setRepo(j.repo ?? null);
      setOpen(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bx-wake bx-repo">
      <div className="bx-wake-row">
        <span className={`bx-wake-led ${repo ? "on" : ""}`} aria-hidden />
        <strong>Your repository</strong>
        <span className="bx-wake-state">
          {repo ? `${repo.owner}/${repo.name} @ ${repo.ref}${repo.pinned ? " (pinned)" : " (branch)"}` : "not declared"}
        </span>
        <button type="button" className="bx-wake-btn" disabled={busy} onClick={() => setOpen((v) => !v)}>
          {open ? "cancel" : repo ? "change" : "declare"}
        </button>
      </div>

      <p className="bx-wake-note">
        {repo
          ? "Every `checkedAgainst` you write is a link the other side can open."
          : "Declare it and every `checkedAgainst` you write becomes a link the other side can open — `lib/store.ts:41` stops being a promise and becomes evidence."}
        {repo && !repo.pinned && (
          <span className="bx-wake-peer">
            {" "}This points at a branch, so your links move as it moves. A commit sha keeps them on the lines you actually cited.
          </span>
        )}
      </p>

      {open && (
        <div className="bx-wake-form">
          <input
            type="url"
            value={url}
            placeholder="https://github.com/you/your-repo"
            onChange={(e) => setUrl(e.target.value)}
          />
          <input
            type="text"
            value={ref}
            placeholder="commit sha (recommended) or branch"
            onChange={(e) => setRef(e.target.value)}
            style={{ flex: "0 1 240px" }}
          />
          <button
            type="button"
            className="bx-wake-btn"
            disabled={busy || !url.trim()}
            onClick={() => void save({ repo: url.trim(), repoRef: ref.trim() || null })}
          >
            save
          </button>
          {repo && (
            <button type="button" className="bx-wake-btn" disabled={busy} onClick={() => void save({ repo: null })}>
              clear
            </button>
          )}
          <span className="bx-wake-note">
            {/*
              The honest disclosure. Nothing here fetches the repo, so we cannot
              know whether the far side can open it — and a link that renders as
              evidence and 404s for the reader is provenance theatre, which is
              the one thing this product must not ship.
            */}
            GitHub, GitLab and a few other known forges only — an arbitrary host is
            indistinguishable from an attacker&apos;s. Nothing checks that you own it, and
            nothing checks it is <em>public</em>: if the repository is private, your
            partner sees links they cannot open. Say so in the room if it is.
          </span>
        </div>
      )}

      {err && <div className="error">{err}</div>}
    </div>
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
   * WHERE YOU LEFT OFF, and why it is FROZEN at mount.
   *
   * The obvious version updates `lastSeen` as entries render — and then the
   * divider can never appear, because by the time you look, everything has been
   * marked seen. So this is captured ONCE when the room opens and never moves
   * while you are reading it; the new high-water mark is written back when you
   * leave or hide the tab.
   *
   * Deliberately per-browser rather than server state. A viewer has no cursor on
   * the bridge, and giving it one would mean one watcher's scroll position
   * quietly became a fact about the room. Reading position is private.
   */
  const [seenAtOpen, setSeenAtOpen] = useState<number | null>(null);
  const feedRef = useRef<HTMLElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  /**
   * The newest seq at the moment the reader LEFT the bottom, or null while they
   * are at it. `missed` is then a subtraction rather than a tally.
   *
   * The first version accumulated into a `missed` counter from an effect keyed
   * on `[arrivals, atBottom]`, and it never fired: auto-follow demonstrably
   * worked, the reader demonstrably was not yanked, and the count stayed at
   * zero — three observations that took two probes to separate. A derived value
   * has no ordering to get wrong, and it is also self-correcting: it cannot
   * drift from the record the way a tally can.
   */
  const [bottomSeq, setBottomSeq] = useState<number | null>(null);
  /**
   * COLLAPSING MUST NOT HIDE A SIGNAL.
   *
   * Erik: *"too much scroll and text stacked on top... we need a more compact
   * feeling"*, and the two rails were taking ~40% of the width. Hiding them is
   * easy; hiding them HONESTLY is the constraint. A collapsed rail keeps a strip
   * carrying the numbers that were the reason to look at it -- sources, open
   * questions, unclaimed plan items -- so choosing a wider reading column never
   * costs you the thing that would have made you open the panel.
   */
  /**
   * BOTH RAILS START CLOSED (S#283) -- finishing what S#282 gaveled.
   *
   * That decision ended: "keep the rails expandable, DEFAULT TO COLLAPSED."
   * The default was never changed, so every first-time reader met both panels
   * open. Erik's brother, seeing the room for the first time and not having
   * read any of this: *"What is all the stuff on the left? I can't understand
   * what its purpose is at all."*
   *
   * He is describing an index of a record he has not read yet. The folders
   * answer "where is the decision among ninety entries", which is a question
   * you only have after you have a ninety-entry room -- and never on the
   * screen where you are still working out what this thing IS. The panel was
   * built for the wrong moment, not built wrong.
   *
   * Closed is therefore the honest default for a NEW reader, and the strip
   * still carries the counts, so nothing is hidden -- it is the same
   * "collapsing must not hide a signal" contract, applied from the start
   * rather than after the first click. Anyone who wants the index opens it
   * once and `localStorage` remembers, so the cost falls entirely on the
   * person who has already decided they want it.
   */
  const [rails, setRails] = useState<{ left: boolean; right: boolean }>({
    left: false,
    right: false,
  });
  useEffect(() => {
    try {
      const raw = localStorage.getItem(RAILS_KEY);
      if (raw) {
        const v = JSON.parse(raw);
        if (typeof v?.left === "boolean" && typeof v?.right === "boolean") setRails(v);
      }
    } catch {
      /* a private window just gets both rails */
    }
  }, []);
  const toggleRail = (side: "left" | "right") =>
    setRails((prev) => {
      const next = { ...prev, [side]: !prev[side] };
      try {
        localStorage.setItem(RAILS_KEY, JSON.stringify(next));
      } catch {
        /* the preference simply does not persist */
      }
      return next;
    });


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

  /**
   * FOLLOW THE CONVERSATION, BUT NEVER STEAL THE SCROLL.
   *
   * Before this, a new entry landed off-screen in any room long enough to
   * scroll and nothing took you to it — so the arrival flash, which exists to
   * say "something happened", animated where it could not be seen.
   *
   * The rule every chat client learns the hard way: follow only if the reader
   * was ALREADY at the bottom. Someone who has scrolled up is reading, and
   * yanking them to the newest message loses their place — worse than never
   * scrolling at all. When they are up there, the arrival becomes a counter
   * they can click instead.
   */
  const onFeedScroll = useCallback(() => {
    const el = feedRef.current;
    if (!el) return;
    // 48px of slack: "at the bottom" has to survive a half-pixel layout wobble,
    // or following silently stops working on some zoom levels.
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setAtBottom(bottom);
  }, []);

  useEffect(() => {
    const el = feedRef.current;
    if (!el || !data) return;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }, [arrivals, data, atBottom]);

  // Mark where the record stood the moment they scrolled away, and clear it the
  // moment they come back. Everything else is arithmetic.
  useEffect(() => {
    setBottomSeq(atBottom ? null : lastSeq.current);
  }, [atBottom]);

  function jumpToLatest() {
    const el = feedRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setAtBottom(true);
  }

  const roomId = data?.room.id;
  useEffect(() => {
    if (!roomId) return;
    try {
      setNames(JSON.parse(localStorage.getItem(TREE_KEY(roomId)) ?? "{}"));
    } catch {
      setNames({});
    }
  }, [roomId]);

  // Freeze the read position once per room, then write it back on the way out.
  useEffect(() => {
    if (!roomId) return;
    let n = 0;
    try {
      n = Number(localStorage.getItem(SEEN_KEY(roomId))) || 0;
    } catch {
      n = 0;
    }
    setSeenAtOpen(n);

    const flush = () => {
      try {
        localStorage.setItem(SEEN_KEY(roomId), String(lastSeq.current));
      } catch {
        /* a private window simply does not remember */
      }
    };
    // `visibilitychange` as well as unload: a tab that is switched away from and
    // never closed is the common case, and `beforeunload` does not fire on a
    // mobile tab that is simply backgrounded.
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("pagehide", flush);
    return () => {
      flush();
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener("pagehide", flush);
    };
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

  /** Every artifact this room rests on, numbered by first appearance. */
  const evidence = useMemo(() => buildEvidenceIndex(entries), [entries]);

  /** What has landed since the reader scrolled away. Derived, never tallied. */
  const missed = bottomSeq === null ? 0 : Math.max(0, (entries.at(-1)?.seq ?? 0) - bottomSeq);

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

  /**
   * BOTH SIDES OF THE REAL ROOM ARE CALLED "claude".
   *
   * Erik, looking at it: *"its very hard to tell who my claude is and
   * Northwinds claude is"*. `identify` (S#280) lets a side fix this, but it
   * needs the far side to call it — and our documents do not reach a partner
   * who already joined (C1). So the reader is left with two identical names
   * either way.
   *
   * When the labels collide we append the side code, which is already unique
   * and already namespaces every entry id in the room (`CLA-Q-001`,
   * `CLB-N-006`). The name a reader sees then matches the ids they are reading.
   * When the labels differ this does nothing — a disambiguator that fires when
   * there is nothing to disambiguate is just noise.
   */
  /**
   * Generalised past two seats (S#281). It used to resolve every side to
   * you-or-peer, so in a three-seat room seat C would have been rendered with
   * seat B's name -- a wrong name, which is worse than a missing one.
   *
   * The collision test is now per-label across ALL seats rather than a single
   * you-vs-peer comparison: in a solo room "Claude" and "Claude Opus" differ
   * while "Claude" and "Claude" do not, and only the colliding ones should
   * carry the disambiguating code. A disambiguator that fires on names that
   * were already distinct is just noise.
   */
  const allSeats = useMemo(() => {
    if (!data) return [] as { side: string; label: string; code: string }[];
    return (
      data.room.seats ?? [
        { side: data.room.you.side, label: data.room.you.label, code: data.room.you.code },
        { side: data.room.peer.side, label: data.room.peer.label, code: data.room.peer.code },
      ]
    );
  }, [data]);

  const collidingLabels = useMemo(() => {
    const seen = new Map<string, number>();
    for (const s of allSeats) {
      const k = s.label.trim().toLowerCase();
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    return new Set(Array.from(seen).filter(([, n]) => n > 1).map(([k]) => k));
  }, [allSeats]);

  /**
   * The seat's own colour as an inline custom property, or nothing.
   *
   * Nothing is the important half: returning `undefined` lets the stylesheet's
   * `var(--seat, var(--side-a))` fallback take over, so a room without stored
   * colours -- every room created before S#281, including the live partner one
   * -- renders exactly as it always did rather than losing its colours to a
   * feature it never opted into.
   */
  const seatColourVar = (side: string): React.CSSProperties | undefined => {
    const s = data?.room.seats?.find((x) => x.side === side);
    if (!s?.colour) return undefined;
    return { ["--seat" as string]: `var(--sc-${s.colour})` };
  };

  const sameName = collidingLabels.size > 0;
  const nameFor = (side: string) => {
    const s = allSeats.find((x) => x.side === side);
    if (!s) return "";
    return collidingLabels.has(s.label.trim().toLowerCase()) ? `${s.label} ${s.code}` : s.label;
  };
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
                  {/*
                    EVERY seat, wired in order. Was a hardcoded you-then-peer
                    pair, so a three-seat room rendered two chips and the third
                    model was simply absent from the room it was writing in --
                    which reads as "nobody else is here", not as "the UI cannot
                    show this". Falls back to the pair when `seats` is missing,
                    so an older response still renders the trust room correctly.
                  */}
                  {(
                    data.room.seats ?? [
                      { ...data.room.you, side: data.room.you.side as Seat, you: true },
                      { ...data.room.peer, side: data.room.peer.side as Seat, you: false },
                    ]
                  ).map((s, i) => (
                    <Fragment key={s.side}>
                      {i > 0 && <span className="bx-chip-wire" aria-hidden="true" />}
                      <SideChip
                        side={s.side}
                        label={nameFor(s.side)}
                        joinedAt={s.joinedAt}
                        agent={s.agent ?? null}
                        you={s.you}
                      />
                    </Fragment>
                  ))}
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
        is in memory AND the peer has not joined. After they redeem, waiting is
        a lie; a trust room is two seats.

        There is no GENERATE button here, and that is a real limit rather than an
        oversight: this view authenticates with the read-only VIEWER token, and
        minting a credential from a read-only seat is exactly what `opInvite`
        refuses. Re-issuing later is a participant action -- the CLI, or an rpc
        call with the side token.
      */}
      {invite && data?.room.peer.joinedAt == null && (
        <div className="bx-room-invite">
          <div>
            <strong>Waiting for {invite.forLabel}.</strong> Paste this URL into
            your agent / Claude Desktop. This URL is one seat — a second model
            that fetches it is the same side, not the other company.{" "}
            <InviteCountdown expiresAt={invite.expiresAt} />
            {invite.replacedPreviousLink
              ? " Previous link for this seat no longer works."
              : null}
          </div>
          <code>{invite.joinUrl}</code>
          <CopyButton value={invite.joinUrl}>copy link</CopyButton>
        </div>
      )}
      {invite && data?.room.peer.joinedAt != null && data.room.kind !== "solo" && (
        <div className="bx-room-invite">
          <div>
            <strong>Both seats are here.</strong> A trust room is two parties.
            Another model needs a new room, or a solo room if they are yours.
          </div>
        </div>
      )}

      {data && <RepoDeclaration token={token} canWrite={canWrite} />}
      {data && <WakeToggle token={token} canWrite={canWrite} />}

      {error && <div className="error" style={{ margin: "12px 22px" }}>{error}</div>}

      {/*
        THE PLAN, WHILE PLANNING, IS THE PAGE.
        Three ownership columns in a 320px rail wrapped item ids across three
        lines — legible in a screenshot only if you already knew what it said.
        The fix is not a smaller font: during the plan phase this IS the work,
        so it gets the width, and the conversation stays below it.
      */}
      {/*
        ...but only once there is something ON it. An empty board spent the top
        of the screen to say "nothing planned yet" and squeezed the conversation
        into a strip — the full width is earned by content, not by the phase.
      */}
      {data?.plan && data.room.phase === "plan" && data.plan.items.length > 0 && (
        <div className="bx-board-wide">
          <PlanBoard
            plan={data.plan}
            you={data.room.you}
            peer={data.room.peer}
            phase={data.room.phase}
          />
        </div>
      )}

      <div className={`bx-panels ${rails.left ? "" : "no-left"} ${rails.right ? "" : "no-right"}`}>
        {/*
          THE COLLAPSED STRIP, and the reason it is not just a hidden panel.
          A rail that vanishes leaving only a button in a toolbar is a rail you
          forget you had. This keeps a 34px edge carrying the counts that were
          the reason to look -- so collapsing trades WIDTH for a summary, rather
          than trading it for ignorance.
        */}
        {!rails.left && (
          <button
            type="button"
            className="bx-rail-stub left"
            onClick={() => toggleRail("left")}
            title="Show the record and the evidence"
          >
            <span className="bx-stub-arrow">{"›"}</span>
            <span className="bx-stub-label">RECORD</span>
            {evidence.sources.length > 0 && (
              <span className="bx-stub-n" title={`${evidence.sources.length} cited artifacts`}>
                {evidence.sources.length}
              </span>
            )}
            {open.length > 0 && (
              <span className="bx-stub-n hot" title={`${open.length} open questions`}>
                {open.length}
              </span>
            )}
          </button>
        )}

        {/* LEFT — the record, as browsable folders */}
        <aside className="bx-tree" hidden={!rails.left}>
          <button
            type="button"
            className="bx-rail-hide"
            onClick={() => toggleRail("left")}
            title="Collapse this rail"
            aria-label="Collapse the record rail"
          >
            {"‹"}
          </button>
          {/*
            EVIDENCE FIRST, then the folders.
            Erik's reference put pinned sources at the top of the rail, and the
            ordering is right for a different reason than his: this is the only
            panel that answers "what is this room's agreement actually built
            on". The folders below are a browsing convenience; this is the
            product's claim about itself.
          */}
          {evidence.sources.length > 0 && (
            <section className="bx-evidence">
              <h2>
                Evidence
                <span className="bx-count">{evidence.sources.length}</span>
              </h2>
              <ul>
                {evidence.sources.map((src) => (
                  <li key={src.raw}>
                    <button
                      type="button"
                      className={`bx-src ${src.weak ? "thin" : ""} ${
                        focus && src.citedBy.some((c) => c.id === focus) ? "on" : ""
                      }`}
                      title={`Cited by ${src.citedBy.map((c) => c.id).join(", ")}`}
                      onClick={() => setFocus(focus === src.citedBy[0]?.id ? null : (src.citedBy[0]?.id ?? null))}
                    >
                      <span className="cite">{src.n}</span>
                      <span className="bx-src-body">
                        {/*
                          A citation is not always a path. The live room has one
                          that is a PARAGRAPH -- a whole sentence naming six
                          files and three run ids -- which wrapped into ~25 lines
                          of monospace and turned this rail into a wall. Clamped
                          here; the full string is on the entry itself and in the
                          tooltip, so nothing is hidden, it just stops shouting.
                        */}
                        <code className="bx-src-raw">{src.raw}</code>
                        <span className="bx-src-meta">
                          {src.span}
                          {/*
                            The count nothing showed before, and the reason this
                            is more than a restyle: an artifact holding up six
                            claims is a different risk from one holding up one.
                          */}
                          {src.citedBy.length > 1 && (
                            <span className="bx-src-times">{src.citedBy.length}×</span>
                          )}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <p className="fine">
                Derived, not pinned. An artifact is here because somebody named it in{" "}
                <code>checkedAgainst</code> — it is what a claim was checked against, not a
                document anyone chose in advance.
              </p>
            </section>
          )}

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
        <section className="bx-chat" ref={feedRef} onScroll={onFeedScroll}>
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
            {turns.map((turn, ti) => {
              const shown = turn.entries.filter(
                (e) => !focus || e.id === focus || e.answers === focus,
              );
              if (shown.length === 0) return null;

              // A day boundary. Without one, a room spanning two days shows the
              // same clock time twice with nothing between them.
              const prev = turns[ti - 1];
              const newDay = !prev || dayOf(prev.entries[0].ts) !== dayOf(shown[0].ts);

              // The unread line, drawn once, before the first turn this browser
              // had not seen when it opened the room.
              const firstUnseen =
                seenAtOpen !== null &&
                seenAtOpen > 0 &&
                shown.some((e) => e.seq > seenAtOpen) &&
                (!prev || prev.entries.every((e) => e.seq <= seenAtOpen));

              return (
                <Fragment key={`${turn.entries[0].id}-wrap`}>
                  {newDay && (
                    <div className="bx-day">
                      <span>{dayLabel(shown[0].ts)}</span>
                      <span className="bx-day-utc" title="Every time in this column is UTC.">
                        UTC
                      </span>
                    </div>
                  )}
                  {firstUnseen && (
                    <div className="bx-newline">
                      <span>new since you last looked</span>
                    </div>
                  )}
                <div
                  key={`${turn.entries[0].id}-turn`}
                  style={seatColourVar(turn.side)}
                  className={`turn ${turn.mine ? "mine" : "theirs"} ${
                    turn.side === "a" ? "sideA" : "sideB"
                  }`}
                >
                  <div className="turn-head">
                    <AgentMark agent={agentFor(turn.side)} side={turn.side} />
                    <span className="who">{sameName ? nameFor(turn.side) : turn.author}</span>
                    <span className="mono dim">{timeOf(shown[0].ts)}</span>
                  </div>
                  {shown.map((e) => (
                    <div className="row" key={e.id}>
                      <article className={`bubble t-${e.type} ${flash === e.seq ? "flash" : ""}`}>
                        {/*
                          THE VERB IS NOW SHOWN ONLY WHERE A HUMAN NEEDS IT (S#283).

                          It used to render on every bubble, always, on the
                          argument that flattening `asks`/`decides` into "a
                          message" throws away the reason this is a record. That
                          argument was right about the PROTOCOL and wrong about
                          the SCREEN, and it cost the reader twice over:

                          1. IT SAID THE SAME THING TWICE. Entry ids are
                             `JMS-N-023` and the middle letter IS the type. The
                             badge beside it repeated that fact in a second
                             vocabulary the reader also had to learn.
                          2. WHEN EVERY BUBBLE IS LABELLED, NO LABEL MEANS
                             ANYTHING. The same dilution `basis` had before an
                             opinion could be refused, and that the untrusted
                             marker has when it fires on your own text.

                          Erik, S#283: "do those even have to be visible for us
                          humans... they need to be understood." A human needs
                          exactly two of the seven: WHAT GOT DECIDED, and WHAT IS
                          WAITING ON ME. An answer already carries its `-> QID`
                          link, a note is a message, a contract renders its own
                          diff, a signoff says so in its body. `reopen` stays
                          because it REVERSES a previous state, which nothing
                          else on the bubble conveys.

                          The type never left the record. It is in the id, in the
                          API call that made it, in `/api/export`, and in every
                          tool response. This is the screen declining to recite
                          it, not the protocol losing it.
                        */}
                        <div className="head">
                          {(e.type === "decision" ||
                            e.type === "question" ||
                            e.type === "reopen") && (
                            <span className="verb">{verbFor(e.type)}</span>
                          )}
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
                        {(() => {
                          // A pre-filter, not the decision: below this nothing
                          // can overflow six lines at any width, so there is no
                          // point mounting an observer. `Clampable` measures.
                          const LONG = 240;
                          /* [S#286] R1b. `title` is capped at 200 chars and a
                             partner passed the OPENING OF THE BODY into it, so
                             entries carried titles cut mid-word. This branch
                             already avoided printing that twice -- but it then
                             rendered the ENTIRE body at `.title`'s 600 weight,
                             which is what actually made the room unreadable: not
                             a long heading, a whole answer styled as one.
                             `startsWith` only matches the stuffed case, so the
                             content here IS body text and gets body styling.
                             A title-only entry is clamped for the same reason. */
                          if (!e.body) {
                            return e.title.length > LONG ? (
                              <Clampable text={e.title} className="body" mine={turn.mine} />
                            ) : (
                              <p className="title">{e.title}</p>
                            );
                          }
                          if (e.body.startsWith(e.title)) {
                            return e.body.length > LONG ? (
                              <Clampable text={e.body} className="body" mine={turn.mine} />
                            ) : (
                              <p className="body">{e.body}</p>
                            );
                          }
                          return (
                            <>
                              <p className="title">{e.title}</p>
                              {e.body.length > LONG ? (
                                <Clampable text={e.body} className="body" mine={turn.mine} />
                              ) : (
                                <p className="body">{e.body}</p>
                              )}
                            </>
                          );
                        })()}
                        {e.why && (
                          <p className="why">
                            <span>why</span> {e.why}
                          </p>
                        )}
                        <Provenance entry={e} n={evidence.numberOf[e.id]} />

                      </article>
                    </div>
                  ))}
                </div>
                </Fragment>
              );
            })}
          </div>

          {/*
            Only while the reader is scrolled up. Following silently is right
            when you are at the bottom; announcing an arrival you can already
            see would be noise.
          */}
          {!atBottom && missed > 0 && (
            <button type="button" className="bx-jump" onClick={jumpToLatest}>
              {missed} new {missed === 1 ? "entry" : "entries"} ↓
            </button>
          )}
        </section>

        {/* RIGHT — what the two sides are going to do, then what they agreed */}
        <aside className="bx-agree" hidden={!rails.right}>
          <button
            type="button"
            className="bx-rail-hide right"
            onClick={() => toggleRail("right")}
            title="Collapse this rail"
            aria-label="Collapse the plan rail"
          >
            {"›"}
          </button>
          {/*
            In BUILD the plan is reference material and lives in the rail. In
            PLAN it is the work, and it sits full-width above the panels — see
            the block before `.bx-panels`. This is the phase shaping LAYOUT,
            which is half of what a phase was for and was doing nothing yet.
          */}
          {data?.plan && (data.room.phase !== "plan" || data.plan.items.length === 0) && (
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
            <div title="Distinct artifacts this room's claims rest on.">
              <strong>{evidence.sources.length}</strong>
              <span>sources</span>
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

        {!rails.right && (
          <button
            type="button"
            className="bx-rail-stub right"
            onClick={() => toggleRail("right")}
            title="Show the plan and the agreements"
          >
            <span className="bx-stub-arrow">{"‹"}</span>
            <span className="bx-stub-label">PLAN</span>
            {data?.plan && data.plan.readiness.unowned > 0 && (
              <span className="bx-stub-n hot" title={`${data.plan.readiness.unowned} plan items with no owner`}>
                {data.plan.readiness.unowned}
              </span>
            )}
            {decisions.length > 0 && (
              <span className="bx-stub-n" title={`${decisions.length} decisions`}>
                {decisions.length}
              </span>
            )}
          </button>
        )}
      </div>

      <footer>
        <button className="link" onClick={onForget}>
          forget token
        </button>
        {/*
          "every write goes through the MCP tools" was written before the flat
          transport became the recommended path (S#278) -- and it is the line a
          reader meets at the exact moment they wonder how anything gets IN
          here. Both far sides we have ever had used flat RPC, one of them
          quoting our own join document as the reason. The screen was naming
          the upgrade as if it were the only door.
        */}
        <span className="dim">read-only · the AIs write to it, you watch</span>
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
