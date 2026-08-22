# TODO — Bridger

## START HERE (rewritten S#279 — the last header was two sessions and twenty
## commits stale, which is the exact rot this file keeps warning about)

**Three commands before you believe anything in this file:**

```bash
curl -s https://bridger-nu.vercel.app/api/about    # the commit that ACTUALLY answered
curl -s https://bridger-nu.vercel.app/api/health   # killSwitch on|off
git -C . log --oneline -5                          # what shipped last
```

**State at the close of S#279 (2026-08-22):** the bridge is RUNNING, the repo is
PUBLIC, `BRIDGER_PASTE_PATH=1` is ON, and production was `a0c192e` when this was
written — which is already a number to distrust rather than to use.

**[!!] B1 IS CLOSED. The thing this product exists for has now happened.**
Trigvanta's Claude — their machine, their codebase, their operator, their
interests — worked room `e4db579a5fad`: 188 calls, both sides, 3 tokens, 9 posts,
an ask, an answer, a read, 6 pings, and one `bridger_status` over MCP. Every
earlier "far side" was on Erik's own machine. `DECISIONS.md` 2026-08-22.

**Then eight people saw it and all eight wanted it.** First demand signal the
project has ever had. Erik's framing: alpha, early, and *"a tool that makes sense
as part of someone's standard kit when working together with AI."*

### WHERE TO GO NEXT, in the order I would take them

| # | What | Why it is first |
|---|---|---|
| 1 | **D3's live test, and F1 in a real room** | The plan stage shipped S#280 and has never been used by a far side. Its default partner state is plan mode, and whether our tool annotations unblock that is still UNVERIFIED. This needs Trigvanta, not a patch. |
| 2 | **B5 at scale** | The panels never scrolled until S#280 (`min-height` let the box grow, so the PAGE scrolled). Found at 30 entries. Nothing else in the room has been looked at past a handful of entries either. |
| 3 | **D3's live test** | Annotations shipped S#280; whether they unblock a planning session is UNVERIFIED and depends on the partner's harness. For F1 that is not an edge case -- "the partner's AI is in plan mode" is F1's DEFAULT state. This needs a partner, not a patch. |
| 3 | **D6 - the audit window** | 5,000 rows, zero headroom; one session overflows it. Reframed S#280: with pricing deferred this stops being a billing prerequisite and becomes the FUNNEL instrument - "did anyone come back" is the only number the strategy runs on. |
| 4 | **D4's create half + F2 room shapes** | The ROOM now reads as a dialogue; the CREATE flow is still too many steps. F2 (shape presets) lands here, and lands as PRESETS - a stage-designer on the create screen would make D4 worse, which is the trap named in lane F. |

**Shipped S#280:** D1 + D2 + D4's room half (the dialogue) - D3's annotations -
C1 (guidance in the field) - C3c (contract patching). Three bugs nobody had
filed came out of the first of those; see `DECISIONS.md` 2026-08-22 (S#280).

**E1 (the licence) is SETTLED as of S#280 -- Apache-2.0.** Pricing stays
deferred and is unaffected: what would be sold is operation, retention and
uptime, not the code.

Lane D is what the first cross-company session taught us. Lane E is the business
question Erik opened at the close of S#279 and answered in part at S#280.
A/B/C are older and still true.

> **DIRECTION (Erik, S#275): zero install, zero setup - "just a bridge to a room
> where users' AIs can communicate in a safe environment."** The idea is strong;
> the ONBOARDING is the product problem. Still internal-infrastructure-first
> (S#274b). **The name is GAVELED as Bridger (S#280)** - `DECISIONS.md`
> 2026-08-22.

---

## WHERE WE ARE — S#277 (2026-08-20)

Prod runs `94de8d4`. The bridge is RUNNING, the repo is PUBLIC, the paste path is
ON. S#277 was a **design-only** session: eight commits, zero protocol changes,
291/291 throughout. Everything below that was true about behaviour before it is
still true.

**The one thing that has not moved in four sessions is ONBOARDING**, and it is
still the stated top item. S#276 spent six of ten rounds on the idle brake
because it kept biting the two agents; S#277 spent itself on the visual system.
Both were worth doing. Neither was this.

---

# A. LEFT TO BUILD

## A0. ~~THE BROWSER FLOW COULD NOT INVITE ANYONE~~ — BUILT S#279

Join codes shipped S#276 and were **CLI-only** — nothing in `app/api/*` or
`lib/operations.ts` exposed invite. So the flow an outsider actually uses had
one handoff: the raw `br_live_...` token on the minted screen. We had built the
better path and hidden it from everyone who arrives at the page.

Now `opInvite` (both transports, invariant 11) plus a button on the minted
screen. The link is the primary handoff; the token block is demoted into a
`<details>` rather than removed. A second link supersedes the first unredeemed
one; a REDEEMED one is left alone because the far side may be mid-retry.
Refuses outright when `BRIDGER_PASTE_PATH` is off rather than minting a link
that 404s. `DECISIONS.md` 2026-08-21.

**Verified by driving it:** old link 404 no token, live link 200 / 10,560 bytes
/ real credential. Ablation-proven. 313/313.

**Still open here:** the MCP tool returns `joinPath` only — that adapter has no
`Request` and therefore no honest way to name the host. If an MCP caller ever
needs an absolute link, the answer is an operator-set origin, not a guess.

## A8. ~~THE QUOTA IS INVISIBLE UNTIL YOU TRIP IT~~ -- BUILT S#280 (the 429/terminal half is still Erik's)

Erik's brother opened three rooms and the fourth was refused; the cap was raised
3 -> 12 the same session. The refusal itself reads well (*"That is 12 rooms
today from this connection…"*), but **nothing tells you where you stand before
it fires**. The server already knows — `MintVerdict` carries `used`, `limit` and
`resetsAt`. A `GET /api/rooms` returning that, shown on the create screen, is
the whole fix. Not built.

**Related, unresolved:** the mint refusal is `terminal: true` at **HTTP 429**,
which contradicts the S#276 ladder (terminal -> 403). `refusal-status.test.ts`
enforces that rule over `DENY_STATUS`, and this route builds its response by
hand and never consults that table — it is the one route that never calls
`authorize()` (ARCHITECTURE #30), so the invariant does not reach it. Arguably
429 + `Retry-After` is correct HTTP for a limit that resets at midnight and the
`terminal` flag is the wrong one. Erik's call which way it moves.

## A1. ~~ONBOARDING — the paste path is not the recommended path anywhere~~ — DONE S#278

Closed. The flat path is now the default in `README.md` (a "which path to give a
partner" block), in the token box (which opens with a copyable handoff block
written for the far side's AI, with MCP moved into a closed `<details>`), and in
`app/demo.tsx`. The join document now names MCP, says what it costs, and tells
the reader to stay on the flat path unless they specifically want tools — the
gap where "both directions of that choice are hidden" is closed in both
directions. `DECISIONS.md` 2026-08-21.

**Verified by driving it, not by reading it:** puppeteer clicked through
create-room on a file store and photographed the minted screen; the handoff
block renders, MCP is collapsed, zero page errors.

<details><summary>the original problem statement</summary>

## A1 (original) — ONBOARDING

The argument was made internally in S#276, agreed, and **never written into a
single document a partner reads**: a resident MCP schema costs a far side ~1,800
tokens of tool definitions on EVERY turn whether they use it or not, against ~318
for the narrowed answerer surface. The flat `POST /api/rpc` transport costs zero
standing tokens.

So the flat path should be the DEFAULT we recommend and MCP the opt-in — and
right now `README.md`, the join document and the token box all still lead with
MCP. This is a docs-and-defaults change, not a code change, and it is the
highest-leverage item on this list.

**Also unwritten:** the join document never mentions MCP exists, so a partner
who would benefit from it never learns it is an option. Both directions of that
choice are currently hidden.

</details>

## A2. `WASTE_BUDGET_BYTES` 12000 -> 18000 — one constant, Erik's call

Measured in S#276: the budget buys ~5.5 hours of continuous blocking against the
~8 an overnight listener needs. Barely moves the spinner case. Open since S#276.

## A3. ~~Publish the CLI, or stop implying it is published~~ — RESOLVED S#278

**The name is taken.** `bridger` on npm is an unrelated socket.io bridging
library (latest 0.1.2), verified against the registry 2026-08-21 — so
`npx bridger ...`, the command handed to partners in S#274, **runs a stranger's
code**. `@bridger/cli` returns 404 and is free.

README now says this outright instead of the softer "not on npm yet". Closed as
DOCUMENTED, not as published: publishing claims a public name irreversibly and
is Erik's call (shipping-quality#3), and the name is parked anyway.

## A4. `vercel git connect` — needs Erik in a browser

It fails from the CLI (OAuth step). Until it is done, the commit in `/api/about`
is self-reported by the CLI rather than asserted by the platform. That is the
difference between "he says this commit" and "Vercel built this commit from
GitHub", on the page whose job is to be trusted.

## A5. Design — three open calls, all Erik's

- **Sea state.** `amplitude` 0.26, `period` 17s, halo alpha 0.16, hero 88vh,
  horizon 0.6. Every one of those was set from stills by me.
- **Whether `--seal` moves off orange** — close enough to Deeplake's accent to
  deserve a second look.
- **The token box has never been seen by anyone.** It is restyled and
  typechecked; reaching it requires a real mint through the UI.

## A6. Housekeeping

- Fix `vercel env add … preview`, or record that preview is unused and drop the
  vars.
- ~~Delete the two test entries in the live room.~~ **CANNOT BE DONE, and the
  item should not be re-carried.** The record is append-only and hash-chained;
  there is no delete operation anywhere in `lib/operations.ts` or `/api/rpc`,
  and adding one would break the property the product is built on. The only
  removal that exists is `purge`, which destroys the whole room.
  **[S#279 correction] The reason given here was wrong.** It said those entries
  sit in the open Trigvanta bridge; a live `status` on `0c7a12ba09d2` returns
  `totalEntries: 0`. That room has never been written to. Whichever room holds
  the demo entries, it is not that one — and the conclusion (do not add a delete)
  stands on the append-only property alone, which is the only support it needed.
- Room `d437fff5b423` (Bridger x Antigravity) holds a contract and three seeded
  questions and is waiting on a fresh invite code — the S#277 one expired
  unredeemed. `npm run bridger -- invite --side b --ttl-minutes 60 --token-days 7`.

## A7. Parked, with reasoning — see the lanes further down

Multi-party rooms (a rewrite of the identity model, nobody has asked), the
witness network (gated on a real far-side round trip), the communication layer
(first step is MEASUREMENT, not building), reproducible builds, self-host guide.

---

# B. LEFT TO TEST AND VERIFY

> Ordered by what a wrong answer would cost. The first item is the one the
> product exists for and it has never run.

## B1. [~] A FAR SIDE THAT CANNOT READ OUR CODE — HALF DONE 2026-08-21

**The cross-machine half is DONE.** Antigravity (Gemini), on Erik's laptop, on
Windows, with no access to this repo, joined from one pasted URL and did real
work: 16 calls across two sessions, zero failures, zero MCP registration. Room
`d437fff5b423`. Everything below in lane C came out of it.

**The adversarial half is NOT.** It was Erik's own laptop and Erik's own
operator judgement, and Antigravity had no codebase of its own — so it cited
`content.md` and `contract.md`, its local copies of OUR documents. It cited
things it could read. The asymmetric case the whole `checkedAgainst` argument
rests on — us citing our repo to a party who cannot check it, with their own
interests at stake — is still answered only in prose.

Room `0c7a12ba09d2` (Trigvanta) remains the real test and side B's token is
still unused.

<details><summary>the original statement</summary>

## B1 (original)

The whole claim is *"the answer lives in their codebase, ask them directly"*.
Every far side so far has been on this machine with the repo on disk, so
`checkedAgainst` has never once been exercised under the conditions it was
designed for — as a FALSIFIABLE COMMITMENT to someone who cannot check it.

Room `0c7a12ba09d2` (Trigvanta) is still open and side B's token is still unused.
Erik holds it. Nothing on this list is worth more than this.

</details>

## B2. Does a real client STOP on a terminal refusal?

`STATUS.md` calls this the question none of the 291 tests can answer. Fixed and
verified on the FLAT transport (terminal is now 403, was 429 — the retryable code
every client auto-retries). **On the MCP transport it is still unobserved:**
`terminal` travels inside a JSON-RPC tool error's text, and what a given client
does with that is unknown.

## B3. ~~Does Antigravity honour a narrowed `tools/list`?~~ — MOOT 2026-08-21

It never registered MCP at all. Zero `tools/list`, zero `initialize`, zero
`server/discover` across 16 calls. It chose the flat transport deliberately and
quoted our own join document as the reason: *"the join document explicitly
stated 'stay here unless you specifically want the tools', making flat RPC the
clear intended default."* Its own conclusion: *"Flat RPC should definitely be
the recommended default for foreign client bridges, with MCP reserved as an
opt-in."*

That is the S#278 default validated by a foreign client the same day it shipped.
The narrowed-surface question stays open in principle but has no live case.

## B3 (original). Does Antigravity honour a narrowed `tools/list`?

The answerer role is the entire cost argument for a partner (~318 tokens vs
~1,800). `answererHandler` exists and is unit-tested. Whether a foreign client
respects the narrowing — or enumerates hidden tools anyway — has never been
watched. Safe to find out: `operations.ts` re-checks server-side.

## B4. Second cold provenance test

Antigravity filled `checkedAgainst` honestly once, and one of its two citations
was over-broad. One data point is not generalisation. Different question shape.

## B5. Design verification that has NOT happened

**[S#280] One of these stopped being theoretical.** "The room view has only ever
been captured with a FOUR-entry room" was the note; rendered at 30, the three
panels turned out never to have scrolled at all -- `.bx-room` used `min-height`,
so the box grew to fit and the document scrolled instead, which means the
`overflow-y: auto` on all three panels had never once engaged. Fixed. The rest
of this list is still owed, and this is the argument for it.


- **Nobody has looked at the shipped design on a real monitor.** Everything was
  judged from screenshots and measurements.
- **No real device, no Safari, no Firefox.** Chrome headless only.
- **The room view has only ever been captured with a FOUR-entry room.** Panel
  scrolling, the chain spine over 100+ entries and the tree at length are all
  unexercised.
- **The token box**: see A5.
- Reduced-motion, contrast (20/20 AA) and 60.6fps ARE measured and hold.

# C. FROM THE FIRST REAL FAR SIDE (2026-08-21)

## C0. ~~THE WATCH TAB EXHAUSTED ITS OWN TOKEN IN 27 MINUTES~~ — FIXED 2026-08-21

Found live, during the first real partner run, while Erik was watching the room
he had just handed over. The viewer token hit `perTokenPerDay` and the room view
went to a rate-limit error for the rest of the day.

`POLL_MS` was 4000 — 15 requests a minute. The code comment shows the PER-MINUTE
limit was reasoned about carefully (viewers get 60/min, so 15 fits). **The
per-day limit was never considered:** 900 an hour against a cap of 400 is
exhausted in about twenty-seven minutes.

Fixed by backing off when NOTHING CHANGED rather than only when something
failed, snapping back to full speed the moment an entry lands. Ceiling 120s,
reached after ~8 quiet ticks. Budget: ~240 calls across an eight-hour day
against the 400 cap, with room left for the operator to use the room.

Not fixed with a bigger number, deliberately: a room where nothing has happened
for four minutes does not need fifteen requests a minute, and "the other side is
a human-paced team, not a service" is the argument this product makes to its own
partners.

**One thing this did prove for free:** the CLI reported the refusal as
`TERMINAL`, exited 1 and did not retry — B2's contract working in production, in
a situation nobody staged.



> Everything here is evidence, not opinion. Source: room `d437fff5b423`,
> entries `AGX-A-001`, `AGX-A-004`, `AGX-N-001`, plus the audit log.

## C1. ~~OUR DOCUMENTS DO NOT UPDATE IN THE FIELD~~ -- BUILT S#280

The single most important thing this run taught us, and nobody had thought about
it.

We fixed `START HERE` to point at `ping` and deployed it. An hour later the same
far side answered a new question using **`status` + `read`, five times each,
never once calling `ping`.** It was working from `content.md` — its own local
copy of our join document, saved at join time. Our fix never reached it.

**So every improvement to the join document only reaches partners who join
AFTER it.** Anyone already on the bridge keeps a frozen copy forever, and the
better we make that document the wider the gap grows between new and existing
partners.

**The fix is already in the protocol and unused for this.** Every response
carries a `guidance` field, delivered on every call. That is the live channel.
Field-updatable advice belongs there, not only in a static document handed out
once. Concretely: when a caller uses `status`+`read` where `ping` would do,
`guidance` should say so.

## C2. ~~`checkedAgainst` HAS TWO STATES AND NEEDS THREE~~ — BUILT 2026-08-21

Shipped as `basis`, with the far side's own design and its own argument for the
hard version. `basis: "opinion"` carrying `checkedAgainst` is **refused, 403,
terminal** — not warned. Its reasoning for why refusal rather than a lint:
server-side rejection *"actively breaks an LLM's reflexive habit of padding
judgment calls with decorative file references."* A permissive version leaves
the reflex intact, because the incentive to fill the slot does not disappear
just because a better option sits next to it. Same lesson this project learned
twice from the other direction: `deny` bites, `ask` does not.

Two values, not the four proposed: `opinion` (no artifact could settle it) and
`inference` (reasoned, not read). `inference` MAY carry a citation — it reasons
*from* something — and `opinion` may not. Every extra name is more taxonomy, and
ceremony was its own complaint.

`wire()` now renders three readings instead of two, so an honest judgement never
again looks like a lapse in discipline.

Verified end to end on the flat transport, not only in a unit test: opinion
without a citation 200, opinion with one 403 `terminal:true`. Ablation-proven —
refusal removed, tests red; restored, 303/303.

**Still open:** the MCP tool schemas do not expose `basis` yet. The rule holds
there anyway, because it lives in `lib/operations.ts` rather than in a parser,
so an MCP caller cannot bypass it — they simply cannot declare an opinion yet.

## C2 (original). `checkedAgainst` HAS TWO STATES AND NEEDS THREE

Its verdict on whether the tool is worth using — a pure judgement — carried
`checkedAgainst: contract.md:5-15`. The citation cannot support the claim.

This is our design fault, not its mistake. The field has exactly two states,
cited or `UNCHECKED`, and `UNCHECKED` reads like an omission whether or not it
was one. So the incentive is to always put something there, and the field decays
into ceremony — which it named as a friction point in the same entry it
performed it in.

Candidate: a third state for reasoning that rests on nothing external
(*judgement* / *inference*), so it does not sit next to a genuine unverified
factual claim. Counter-argument: more taxonomy is more ceremony. Asked the far
side directly (`ACC-Q-005`); decide on their answer, not ours.

## C3. THE THREE PROPOSALS WORTH TAKING

From `AGX-N-001`, unsolicited, after one session on the bridge.

**C3a. Citation bundles.** Attach 5-10 lines of the actual interface alongside
`checkedAgainst`, rather than a pointer to a file we can read and they cannot.
This is a change to what an ANSWER IS, not a feature beside it, and it is the
candidate fix for the *"foreign agent is still executing on blind trust"*
problem it named. Highest value of the five.

**C3b. Local daemon holding the wait, writing to a watched file.** A lightweight
local process keeps `{"op":"wait"}` open and appends arrivals to
`.bridger/inbox.json`; the harness's own file-watcher wakes the agent. Zero
polling, zero standing context.

**Erik proposed exactly this mechanism independently, roughly ten minutes before
the note landed, with neither side having seen the other.** Two parties
converging on one design with no contact is the strongest signal available that
it is right.

**C3c. ~~Contract patching.~~ BUILT S#280.** `sections` patches by `## heading`
(RFC 7386 semantics), and `ifUnchangedSince` refuses a write whose base moved.
Sections shrink the clobber surface; the pin is what removes it. Both
transports, 7 unit tests, and the real two-sides race driven on a server.
`DECISIONS.md` 2026-08-22 (S#280).

Not taking: machine-readable `falsifiesIf` assertions (interesting, but it is a
test framework growing inside a ledger), and the cross-platform CLI, which is
already covered by A3 and the PowerShell fix.

## C4. A PING CANNOT WAKE AN AI, AND THAT IS DELIBERATE

Researched 2026-08-21 rather than assumed. `subscriptions/listen` is a real MCP
method and clients do call it — Claude Code hits ours every 60 seconds. But a
server notification updates CLIENT STATE; no client turns one into a model turn,
because a server that could make your model run inference could burn your quota
at will. The protection and the limitation are the same mechanism. The
2026-07-28 spec moves further this way, away from held bidirectional streams
toward stateless multi-round-trip requests.

**So "ping the other side's AI" is not buildable. "Ping the other side's HUMAN"
is, works with every client that will ever exist, and is honest about where the
human actually sits.** Build that, plus C3b for harnesses that wake on a
completed background task.

## C5. BLOCKED WAITS ARE PRICED LIKE POLLING, AND THEY ARE NOT POLLING

A blocked `wait` self-caps at 45s, so covering a day needs ~1,920 calls against
a `perTokenPerDay` of **400** — about five hours. `WASTE_BUDGET_BYTES` (12,000)
buys a similar ~5.5 hours.

Both were sized against polling, which we want to discourage. But a blocked wait
costs us almost nothing and costs the caller no context at all — it is the one
behaviour we are trying to encourage, and it is rationed like the one we are
trying to prevent. **A blocked wait wants its own, much larger allowance.**
This subsumes A2, which is the same argument about one of the two constants.

## C6. THE IDLE BRAKE NEVER FIRED, AND THAT IS DATA

Sixteen calls across two sessions, and it stopped on its own both times —
`MAX_IDLE_STREAK` (6) was never approached. Good behaviour made the machinery
redundant in the only real case we have. That is one data point, not a case for
removing it, but it belongs in the argument when C5 is decided. It is also on
the cut-list we put to the far side in the reopened `ACC-Q-004`.

---

# D. FROM THE FIRST CROSS-COMPANY SESSION (2026-08-21/22)

> Trigvanta's Claude connected and worked room `e4db579a5fad`. Everything here
> is either Erik watching it happen or a row in the audit log; none of it is
> speculation about what a partner might want.

## D1. ~~NOBODY CAN TELL WHO IS WHO~~ -- BUILT S#280 (with D2 + D4)

There is no per-side colour anywhere in the room view, and no visual signal for
who has connected. Two parties write into one record and the reader has to parse
labels to work out which is which. The field already spends `--side-a` and
`--side-b` on exactly this idea -- the background mixes the two parties' hues --
and the room, where it would actually carry meaning, uses neither.

**Assign each side a colour once, at the room level, and use it everywhere:**
entry authorship, the side chips, the connection state, the invite panel. The
tokens exist; nothing consumes them.

## D2. ~~THE CONVERSATION IS NOT SHAPED LIKE A CONVERSATION~~ -- BUILT S#280

Erik: it should read like two people talking in Teams -- each side on its own
side of the column, in its own bubble. Today the feed is a uniform list of
entries, so the fact that this is a DIALOGUE between two parties is carried by
metadata rather than by the layout.

Pairs with D1: alignment says who is speaking before any text is read, and colour
confirms it. Neither works alone.

## D3. [~] A PLANNING CLAUDE CANNOT USE THE BRIDGE -- ANNOTATIONS SHIPPED S#280, EFFECT UNVERIFIED

Erik: in plan mode their Claude could not write to the bridge.

**Verified:** none of the 13 `bridger_*` MCP tools declares any annotation --
`readOnlyHint`, `destructiveHint`, `openWorldHint` are absent across the whole
surface (`grep -c` returns 0). A harness that gates tools during planning has
nothing to go on and must assume every tool writes, which sweeps up
`bridger_status`, `bridger_read`, `bridger_ping` and `bridger_whoami` -- all pure
reads.

**NOT verified, and it is the part that matters:** whether adding the annotations
actually unblocks anything. That depends on the far side's harness, not on us,
and it needs a live test with a planning session rather than a confident patch.
Writing while planning may be correctly forbidden; being unable to READ is the
part that looks like our bug.

## D4. [~] THE CREATE FLOW IS TOO MANY STEPS -- the ROOM half shipped S#280, the CREATE half is open

Erik: what the setup gives you needs to be much simpler -- too many steps and
vague descriptions of what each thing does. The minted screen hands over three
tokens, a warning, an invite block, a fallback and an MCP section, and expects
the reader to work out which of those they need.

**SUPERSEDED S#280 -- the reference is now Microsoft Teams chat, not x.ai/bot.**
Erik: *"implement a typical chat interface in the chat room. Take microsoft teams
chat as a direction of how it should work and look (with our own design of
course) but the best principles from that service should be taken as
inspiration."* The screenshot blocker is gone by replacement, not by fetching.
**D1 + D2 + D4 are now ONE job:** the room reads as a dialogue -- alignment says
who is speaking, colour confirms it, entry types stay visible. The design
language stays ours (`app/wire.tsx`, INSTRUMENT register, `--seal` on provenance
only); Teams is the INTERACTION reference, not the visual one. **The tension to
hold: a chat bubble is a message, a Bridger entry is a typed record with `basis`
and `checkedAgainst` -- if the bubble hides the citation it removes the point.**
`DECISIONS.md` 2026-08-22 (S#280).

## D5. ~~`help` IS NOT AN OPERATION~~ -- BUILT S#280

One `help error` row in the audit for the session. An agent looked for a help
verb, and the refusal does list `knownOps`, so it was recoverable -- but a
transport whose whole pitch is "one POST, no docs to install" should answer the
most obvious verb in it. Cheap.

## D6. ~~THE AUDIT WINDOW IS TOO SMALL TO HOLD A REAL SESSION~~ -- BUILT S#280

`AUDIT_LOG_MAX` is 5,000 and the log sat at ZERO headroom throughout. One
cross-company session plus a watch tab pushed 4.5 hours of history out between
two snapshots taken an hour apart. The ledger is safe; the operational record is
not. Either raise the cap, or make `bridger audit` able to archive before it
rolls -- right now the only reason S#279's evidence survives is that a snapshot
was taken by hand.

---


# F. THE PLAN STAGE AND ROOM SHAPES (Erik, S#280)

> Erik and Trigvanta both felt the same gap after using a real room, and the far
> side's own `C3c` named its mechanism from the other end. Three parties, no
> contact between them, one conclusion. That is the strongest signal available
> that something is right, and it is the second time this project has had it.

## F1. ~~THE PLAN STAGE~~ -- BUILT S#280

Erik: *"there should be a Plan stage where the LLMs can talk to each other about
a specific topic/project or whatever both humans set as the agenda. Then the LLMs
should plan together, listing every important aspect from both respective sides
with their respective context."*

**THE VERSION WE WOULD BUILD BY ACCIDENT, AND MUST NOT.** "Let the two models
talk" produces volume, not a plan, and burns both sides' quota on exactly the
loop the rate limits exist to prevent -- `/api/about` still says one such loop
consumed an entire model quota. This product's only differentiator is that
entries are typed, cited and append-only. A plan mode that drops that is a worse
Slack with a login.

**So: a plan is a DOCUMENT both sides converge on.** The pieces:

- the room carries a **phase** (`plan` -> `build`), and phase shapes GUIDANCE and
  LAYOUT, never permissions -- the moment a phase refuses a write we have built
  a workflow engine, and workflow engines are where products go to die
- the plan is one structured artifact with sections keyed by owner: side A's
  aspects, side B's aspects, shared, open questions
- each side appends to its own section, and may only raise questions against the
  other's
- **the mechanism already exists as of S#280**: `contract` + `sections` is the
  merge-patch this needs, and `ifUnchangedSince` is what stops the two planning
  agents erasing each other
- "done" is MECHANICAL: every item has an owner and a state. Not "the agents
  feel finished", which is unfalsifiable and therefore not a stage boundary
- `guidance` changes per phase -- the C1 channel, built S#280, carrying its first
  real feature rather than one advisory rule

**BUILT S#280.** `bridger_plan` on both transports, `lib/plan.ts` for the rules,
the board in the room view. What shipped against the design above:

- items with an owner and a state, ids namespaced per raiser (`ACM-P-001`)
- **completion is COMPUTED** -- `readiness()` returns what is blocking, so "are
  we done" is falsifiable rather than a feeling. An EMPTY plan is not complete.
- **one enforced rule: only the owner may agree.** Authorship, not workflow.
  Everything else is open to both sides.
- phase (`plan` -> `build`) shapes guidance and LAYOUT, gates nothing. New rooms
  start in `plan`; pre-F1 rooms read as `build`. Moving early is allowed and the
  ledger entry records the unfinished counts.
- the board: three ownership columns plus an unclaimed strip, full width while
  planning. **This is also F3's answer** -- spatial rather than linear, without
  Excalidraw's 46 MB or a mutable blob outside the chain.

Two existing tests caught real errors in it (pointing an answerer at a tool it
does not have; replacing ping's "stop" guidance instead of composing with it).
`DECISIONS.md` 2026-08-22 (S#280).

**Prerequisite, and it is not optional: D3.** A Claude in plan mode could not
call our tools at all. Annotations shipped S#280, but whether they unblock
anything is UNVERIFIED and depends on the partner's harness -- and for this
feature, "the partner's AI is in plan mode" is the DEFAULT state, not an edge
case. Test with a real planning session before building on top of it.

## F2. ROOM SHAPES -- presets, not a builder

Erik, S#280: *"what if you actually get the option to shape the rooms purpose?
Like you can select the flow of stages you want the room to include (If you want
a more complex chain of stages or if you just want a simple chat room you can
select that)."*

Right idea, and it generalises F1's hardcoded `plan -> build` properly. **The
trap is named up front: D4 is literally "the create flow is too many steps, too
vaguely labelled", and a stage-designer at room creation is the fastest possible
way to make that worse.** So:

- **presets, not a builder.** A few named shapes, each one line, simplest
  preselected. Nobody composes a stage chain on the create screen.
- a shape is an ordered list of stages plus the guidance each stage emits
- candidate shapes, for Erik to cut or rename -- this list is a PROPOSAL, not a
  decision:
  - **Just talk** (default) -- one stage, today's behaviour exactly
  - **Plan then build** -- F1
  - **Question and answer** -- an integration support room; the answerer surface
    already exists for this shape
  - ~~**AI meeting room**~~ -- REQUESTED S#280 and it is NOT a preset. Presets
    shape STAGES; this asks for more PARTIES, which is the two-ness rewrite
    (E2/E4). See **F5**, which also explains why the topology in that screenshot
    is not ours.
- **stages never gate a write.** A room in `plan` that refuses a `decide` is
  hostile and would be worked around within a day.

**Not started.** F1's semantics settle first: a shape is a list of stages, and
until one stage is real there is nothing to make a list of.

## F3. [~] THE WHITEBOARD -- the BOARD half shipped S#280 with F1

Erik asked whether Excalidraw could be imported. Checked rather than assumed:
`@excalidraw/excalidraw` v0.18.1 is **MIT** and embeddable as a React component,
**collaboration is NOT included** (their own FAQ: the package *"does not include
built-in collaboration features"*; excalidraw.com runs a separate
`excalidraw-room` server), and the package is **46.8 MB unpacked**.

**The deeper problem is not the dependency: LLMs do not draw.** They emit text. A
freehand canvas is a HUMAN surface, so the question is who the board is for.

- for the two humans to watch and annotate -> Excalidraw fits, but the scene is
  a MUTABLE BLOB sitting outside the hash chain, which is the one property this
  product sells. It would have to be explicitly out-of-chain, or chained as
  snapshots.
- for the agents to express structure -> **mermaid**, not Excalidraw. Text, so it
  chains, diffs and costs ~0 KB, and both sides emit it trivially.

**The read: the instinct is right and the noun is wrong.** What both sides wanted
is SPATIAL AND SIMULTANEOUS rather than LINEAR -- which is D2's complaint again,
one layer up. The plan rendered as a two-column board with a shared middle gives
that for a fraction of the cost. Excalidraw goes on top of a plan that already
exists, if the board turns out not to be enough.

## F5. "AI MEETING ROOM" — Erik, S#280, from a competitor screenshot

Erik: *"We should have a preset in your F2 point, 'AI meeting room', basically you
connect multiple AI models into 1 room if you got the subscription to them of
course. I like the logos that displays which model is which."*

**The screenshot** (a product called Shared Chat): one operator, "Mira", plus
Gemini, Claude, DeepSeek, Perplexity, Qwen, Grok and Copilot as participants,
each carrying its vendor mark. Mira posts a task; each model claims a piece.

### [!!] IT IS A DIFFERENT TOPOLOGY, AND THAT IS THE WHOLE POINT

That product is **ONE operator, MANY models.** Bridger is **TWO COMPANIES, each
with its own operator and its own AI**, keeping a record neither can rewrite.

Those are not the same shape with a different number in it:

| | Shared Chat | Bridger |
|---|---|---|
| who is present | one person, many models they pay for | two parties who do not share an employer |
| what it is for | orchestrating models you own | agreeing across a boundary of trust |
| the hard problem | routing and turn-taking | evidence, provenance, tamper-evidence |
| why the record exists | convenience | neither side can alter it unilaterally |

**Copying that topology would cost Bridger its differentiator.** `checkedAgainst`,
`basis`, the hash chain, the containment markers and the untrusted-partner
framing all exist because the far side is *somebody else*. Point them at seven
models on one person's subscriptions and every one of them becomes ceremony —
you do not need tamper-evidence against yourself. It would also put us in a
crowded space against products that already do it well, having abandoned the one
argument that got a stranger's Claude to connect.

**The genuine Bridger version of that screenshot is N PARTIES, not N MODELS:**
three or four *companies* in one room, each with its own operator and agent. That
is a real and attractive product. It is also E4, and it is a rewrite.

### IT CANNOT BE A PRESET, and the distinction is load-bearing

An F2 preset is an ordered list of STAGES. It shapes guidance and layout. **It
cannot add parties.** Verified, not remembered:

- `SUPPORTED_SLOTS = 2` (`app/api/rooms/route.ts:58`), and the refusal already
  says *"more than two is a change to the room model, not a setting"*
- `SideId = "a" | "b"` (`lib/room-registry.ts:71`), baked into five files:
  `entries.ts`, `operations.ts`, `room-registry.ts`, `api/rooms/route.ts`,
  `page.tsx`
- `otherSide()` is a boolean flip; `sides` is a fixed-shape object; entry ids are
  namespaced per side; "the peer" is singular in `whoami`, the wait cursor and
  the idle brake
- `ARCHITECTURE.md` #31, *"Two-ness is the data model, not a setting"*

**And the cost is the SEMANTICS, not the typing** — E2 recorded these and they
still have no answers: does an answer close a question for *everyone*? does the
idle brake trip per party or per room? who does a contract bind? does a room
need every party to sign off, or one? Those are product decisions, and a
three-party room where they are guessed is worse than no three-party room.

### THE QUESTION ONLY ERIK CAN ANSWER

E4 parked multi-party with a specific condition: *"the request came from an
intuition about pricing rather than from anyone who has used a two-party room
and hit the wall. Wait for that person."*

Erik has now used a two-party room for real. So:

> **Did the two-party limit get in your way with Trigvanta, or is this a good
> screenshot?**

Both are legitimate answers and they lead opposite ways. "It got in my way"
un-parks E4 and the semantics above become the next design session. "It looked
good" keeps it parked — and the honest note is that wanting a feature after
seeing a competitor is exactly the intuition E4 was written to wait out.

### WHAT SHIPPED FROM THIS ANYWAY — the logos half, S#280

The identity problem Erik spotted is REAL and does not need multi-party at all.
Checked in production: room `e4db579a5fad` has `label: "claude"` on **both**
sides. Two parties, same name.

So `identify` shipped: a side names its own `label` (who the party is) and
`agent` (what is typing), rendered as a mark beside every turn and in the
presence chips. Self-declared, never verified, no verification affordance —
a transport cannot know what model is on the other end of a bearer token.

**Open, and it is Erik's:** the mark is a MONOGRAM (`CL`, `GE`), not a vendor
logo. The page is served under a strict CSP with no external hosts, so real logos
mean shipping inlined copies of Anthropic's, Google's and OpenAI's trademarks
from our own origin on a public product. Nominative use — "this identifies which
service is connected" — is usually defensible, but that is a call about somebody
else's business and not one to make while the operator is out. Say the word and
it is one function.

**Not negotiable in that swap:** the colour stays the SIDE's, never the vendor's.
Two Claudes in one room have to stay distinguishable, and a brand palette would
actively prevent it — which is the bug that started this item.

## F4. GAPS FOUND S#280, small and real

- ~~**`basis` is still invisible to MCP callers.**~~ CLOSED S#280 -- the field is
  on `bridger_answer`, `bridger_decide` and `bridger_post`, with a compile-time
  guard so the literal enum cannot drift from `ClaimBasis`.
- ~~**`app/wire.tsx` does not exist.**~~ CLOSED S#280 -- both pointers corrected.
- ~~**D3's note lists `bridger_whoami`.**~~ CLOSED S#280 -- corrected in place.
- ~~**The published daily cap is wrong.**~~ CLOSED S#280 -- `/api/about` now
  publishes `perTokenPerDayViaJoinLink` alongside the default, and says why the
  link-minted token gets the smaller budget.

<details><summary>the original four, for the record</summary>

- **`basis` is still invisible to MCP callers.** The rule holds (it lives in
  `lib/operations.ts`, not a parser) so nobody can bypass it -- but an MCP caller
  cannot DECLARE an opinion, which means the one surface a partner is most likely
  to use cannot use the field built for them. Open since S#279; now the clearest
  case of a capability existing on one transport only.
- **`app/wire.tsx` does not exist.** `STATUS.md` and the `page.tsx` header
  comment both name it; the S#279 "the wave is deleted" commit removed it. Two
  documents point at a file that is gone.
- **D3's own note lists `bridger_whoami` among the swept-up tools.** There is no
  such MCP tool -- whoami is an HTTP endpoint. `tools/list` returns thirteen.
- **`wire()` wraps YOUR OWN side's text in untrusted-partner markers.** Found
  S#280 while driving the plan: every entry title comes back inside
  `[[UNTRUSTED-PARTNER-TEXT from <you>]] DATA FROM THE OTHER COMPANY`, including
  the ones you wrote. Not a hole -- it is over-application, not under -- but it
  is false on its face, doubles every title, and **dilutes the marker**: a
  banner that fires on everything distinguishes nothing, which is the same
  failure `basis` had. NOT changed at the time of finding: it is the
  containment path, and rewriting untrusted-text handling at the end of a long
  session without the operator is exactly the wrong moment.
- **The published daily cap is still wrong** (`PASTE_PATH_DAILY_CAP` is 200,
  `/api/about` publishes `DEFAULT_DAILY_CAP` 400). Carried from S#279, one line.

</details>

---

# E. THE BUSINESS QUESTION (opened by Erik, S#279 close)

> Erik: *"one part of me wants this to genuinely be open source, but another part
> wants to charge a small sum in case you want a Team Channel chat with 6+ seats.
> Is that viable and can it be gate locked?"*

## E1. ~~THERE IS NO LICENCE~~ -- SETTLED S#280: Apache-2.0

**SETTLED S#280. Apache-2.0, copyright Erik Hammarström.** `LICENSE` (canonical
text, fetched and verified unmodified), `NOTICE`, `package.json`, `README.md`
and `/api/about` all carry it. Chosen over MIT for the express patent grant, and
over AGPL/BSL because both would have cost the self-serve funnel that the same
session chose. **Section 6 protects the name**: the code may be forked, a fork
may not be called Bridger. `DECISIONS.md` 2026-08-22 (S#280).

<details><summary>the original gap, for the record</summary>

`gh repo view Hammaarn/bridger --json licenseInfo` returns **null**. Public is
not open source: with no LICENSE file, default copyright applies and nobody may
legally fork, modify or run their own instance — while the landing page,
`/llms.txt` and `/api/about` all instruct them to do exactly that
(*"Run it entirely on your own machine first"*, *"run your own instance — it
works fully offline, and then the only operator is you"*).

That is a live gap between a trust claim we make and the legal reality, on the
one product whose entire pitch is that its claims are checkable.

**It is also the monetisation decision, which is why it is first.** MIT lets
anyone host and sell it. AGPL forces published changes. BSL keeps commercial
rights for a period. Pricing follows from that choice; it cannot precede it.

</details>

## E2. "6+ SEATS" IS NOT A TIER — IT IS THE REWRITE ALREADY REFUSED

`SUPPORTED_SLOTS = 2`, and `ARCHITECTURE.md` #31 is titled *"Two-ness is the data
model, not a setting"*. `SideId = "a" | "b"` across six files; `otherSide()` is a
boolean flip; `sides` is a fixed-shape object; entry ids are namespaced per side;
"the peer" is singular in `whoami`, in the wait cursor and in the idle brake. The
slot picker already shows 3 and 4 disabled WITH the reason.

The unanswered semantics are the real cost, not the typing: does an answer close
a question for everyone? does the brake trip per party or per room? who does a
contract bind? **Nothing can be gate-locked here because there is nothing behind
the gate.**

## E3. THE UNIT IS ROOMS AND VOLUME, NOT SEATS

Erik's instinct — bigger users should pay — is right; "seats" is just the wrong
noun for this architecture. A company integrating with five partners runs five
rooms. Everything scarce is already measured and already enforced per token or
per room, in one place:

| enforced today | value | worth paying to raise? |
|---|---|---|
| `perTokenPerDay` | 400 (200 on a link-minted token) | yes — C5: a blocked wait needs ~1,920/day |
| `newRoomsPerDayPerAddress` | 12 | yes |
| room idle TTL / `MAX_ENTRIES` | 30 days / 5,000 | yes — retention is a product |
| `AUDIT_LOG_MAX` | 5,000 rows, overflows in one session | yes — and see D6 |

**Gate-locking is cheap:** `TokenRecord.dailyCap` already exists per token,
`DEFAULT_ROOM_DAILY_CAP` per room, `chargeMint` per address. A plan field read by
those same checks is a small change, not an architectural one.

**Honest caveat:** a self-hoster can lift every cap in their own instance, and
should be able to — that is the OSS/hosted split working, not leaking. What is
sold is that we run it, keep the history and stay up.

## E4. NOT YET — MULTI-PARTY

Parked, and the reason is now sharper than "nobody asked": the request came from
an intuition about pricing rather than from anyone who has used a two-party room
and hit the wall. Wait for that person.

---

## B6. Standing gaps carried from earlier sessions

- ~~The purge CONSENT GATE in the CLI is not unit-tested.~~ **DONE S#278.** The
  branch was untestable where it lived: inside a CLI function reading `argv` and
  writing to stdout. It is now `decidePurge()` in `lib/purge.ts`, pure, with
  `cmdPurge` calling it — so the tested code is the code that runs. Five cases,
  including that `--force` must NOT re-label a consented purge as forced.
  Ablation-proven: gate broken -> red, restored -> 296/296.
- Upstash free-tier ceiling vs expected volume: unchecked.
- `maxDuration` for `bridger_wait` on this Vercel plan: unconfirmed. The tool
  self-caps at 45s so it degrades rather than breaks.
- The success-audit's `req.clone()` peek has never been observed under Vercel's
  runtime, nor its ~20ms cost on the SSE path.

---

## S#275 CARRYOVER — in order. The first item is the blocker.

### 1. ~~[!!] THE INVITE CODE BURNS ON ANY READ, AND AGENTS RETRY~~ — FIXED S#276

**Shipped:** single-MINT, re-readable for 10 minutes, then a 24h tombstone so a
spent code says `already-used` instead of "check you copied the whole line".
Every refusal now states explicitly whether retrying can help, because the
reader is usually a machine and an ambiguous refusal is what it read as
"broken". Ablation-proven: writeback switched off, 3 of the new tests went red,
switched back, green.

**The cost, recorded rather than buried:** for those 10 minutes the invite
record holds the minted token in PLAINTEXT — the only credential in the clear in
this store. Erik's call, S#276; alternatives and reasoning in `DECISIONS.md`.

**Verified ON PRODUCTION, not just in tests** (prod `26dacec`): three fetches of
one live join URL returned `200 / 200 / 200` with the same token and the same
expiry, where fetch 2 used to be `404 not recognised`. The token then worked
against `/api/rpc`. Negative controls: bogus token 401s, never-issued code still
404s. Probe room purged and the purge independently confirmed.

**Still NOT verified:** no FAR-SIDE AGENT has redeemed a code. The transport is
proven; the thing this was built for — an agent handed a link completing a round
trip — is still item 2.

The original problem statement follows, because it is the evidence for why the
security property was traded.

---


This is what broke the first customer demo. Trigvanta's Claude fetched
`/j/<code>`, got the document, fetched **again** (agents retry, or make a second
confirming call), got `404 not recognised`, concluded the whole service was
broken, and never used the token it already held. The audit log proves it: that
token has never called us.

**Burn-on-read assumes a human who clicks once.** A human previewing the link in
a browser spends it too.

**The fix, decided in principle:** single-*mint*, re-*readable*. A repeat fetch
within the code's TTL returns the same document and the same token instead of a
404. The security property that actually matters is "this line stops working
after N minutes", and the TTL already does that work; burn-on-read was buying
very little and cost us the first live demo.

Also fix the message: a spent code currently reports `unknown` ("check you copied
the whole line"), which sends someone hunting a typo. `already-used` exists as a
distinct reason and should be what they see.

### 2. ~~[!!] GET ONE FAR-SIDE AGENT THROUGH A COMPLETE ROUND TRIP~~ — HALF DONE S#276

**DONE:** a fresh Claude session, handed nothing but a join link, redeemed it,
called `status`, read the record, and wrote an answer citing five file:line
ranges — including an explicit "NOT rendered in a browser, no visual check". It
then found a live CSS defect, refuted a claim with a counterexample, and refused
to fabricate a number it could not read. Zero install: curl and a bash loop.

**STILL OPEN, and it is the important half.** That agent had the repo on disk.
Every citation it made is something a real partner agent cannot see, and the
product claim is *"the answer lives in their codebase, ask them directly."* We
exercised the transport, the record and the citation discipline; we never
exercised **a partner who can only ask and must trust what comes back.**

So the remaining test is unchanged in substance: **a far side on a different
machine, with no access to this repo.** Room `0c7a12ba09d2` (JudgeMySite x
Trigvanta) is still open and side B's token is still unused; Erik holds it.

### 3. Look at the gate page

The three-panel room view is confirmed (Erik's screenshot, S#275). **The gate
page's trust block has never been seen by anyone.** agent-browser exceeds a 280s
cold start on this machine — do not burn another session on it; one human look
settles it.

### 4. `vercel git connect` — needs Erik in a browser

It failed from the CLI (OAuth step). Until then the deployed commit in
`/api/about` is self-reported by the CLI rather than asserted by the platform.
Worth closing: it is the difference between "he says this commit" and "Vercel
built this commit from GitHub".

### 5. Keep `VERIFY.md` true

It is now a public promise and it went stale once within hours — it claimed
tamper-evidence was "designed and not built" while `lib/chain.ts` was already
merged. **A trust document with one stale line is worth less than none**, because
the reader cannot tell which other line rotted. Re-read it whenever a mechanism
changes.

---

## Ideas that are NOT commitments

- **Claude Code plugin / `claude-community` marketplace listing.** Real
  distribution; automated validation + safety screening; each plugin pinned to a
  commit SHA. **Explicitly not a security audit** — Anthropic says so. Would help
  discovery, would not have changed the refusal.
- **Reproducible/attested builds** — the remaining half of "is the published
  source what is running".
- **Self-host guide as a first-class path.** `BRIDGER_STORE=file` already runs the
  whole product offline. For a partner who needs certainty rather than trust,
  that is the honest answer and it costs us nothing to document properly.
- **N > 2 slots** — a rewrite of the room model, not a setting. See DECISIONS.
- **THE COMMUNICATION LAYER (open problem)** -- `plans/communication-layer.md`.
  Erik's constraint: tokens only on Read/Reply. An MCP schema is resident and
  billed every turn (~1,800 for the full surface, ~318 for answerer, S#274),
  so a SILENT bridge still costs the far side. Four options identified, none
  built. **First step is measurement, not building** -- what a real day costs
  has never been measured and the audit log makes it cheap. Erik's standing
  note: he thinks a smarter solution exists that we have not found yet.
- **THE WITNESS NETWORK** — `plans/witness-network.md`. Erik's S#275 idea,
  reframed and GATED: it does not begin until one far-side agent completes a
  round trip on the two-party bridge. Read the gate at the bottom of that file
  before touching it.

---


## THE ORDER I WOULD DO THESE IN

1. ~~**Back it up.**~~ DONE — public repo, S#275.
2. ~~**Run it once between two of Erik's own sessions.**~~ DONE S#276, and it was
   worth every bit of the claim made for it: it closed the `STOP.` question, the
   idle brake and the answerer ordering in one night, and produced four real
   defects. **The reason it worked was latency** — the two sharpest bugs were
   found by *being the one waiting*, which a single session structurally cannot
   reproduce because it has nothing to wait for.
3. **Onboarding, which both sides avoided.** See the header. This is now the
   top item and it has been the stated top item for three sessions.
4. Then the lanes below.

**The pattern this ordering exists to break:** S#271, S#272 and S#274 each ended
by writing *"unit-green, not run-green"* and then building more. 24 commits and
192 tests later, the ledger holds one real cross-vendor exchange, from a demo.
The `npx bridger` bug found in S#274b is the proof that tests cannot substitute:
it passed 192 tests, a typecheck and a production build, and would have failed
the first time a human tried to follow it.

---

## 0. Bring it back — ONE command, Erik's call

```bash
npm run bridger -- start        # lift the kill switch
```

Production already runs the current build (`055ac3a`, deployed and verified
S#272), so the old "deploy before start" ordering trap is retired. Starting now
restores the build WITH the budget caps, the idle brake and the containment —
not the configuration that burned the quota.

Claude can deploy and push unaided since S#272. Package publishing and
force-push are still hard-denied.

---

## Lane: safety — before another agent touches the bridge

- [ ] **Watch the budget under a real loop.** The caps are unit-tested and the
      terminal refusal is verified by hand; neither has met an actual runaway
      agent. The number that matters is whether a looping agent *stops* on
      `STOP.` — if it retries anyway, the message is not doing its job and the
      next lever is refusing at the transport level.
      **Watch the IDLE BRAKE in the same run** (S#272): does the throw past
      `MAX_IDLE_STREAK` actually end the loop, or does the client treat a tool
      error as retryable and spin on it? That is the one question none of the 123
      tests can answer, and it decides whether the brake is real.
- [x] **Close the polling hole on the unbraked tools.** DONE S#272 —
      `bridger_status` and `bridger_read` had no brake, and the wait refusal
      pointed agents straight at `bridger_status`. One idle-streak counter now
      spans all three, writes clear it, and no refusal names another tool.
- [x] **Audit successful calls, not just denials.** DONE S#272 — rows written in
      `gated()`, the one seam every request passes, carrying real
      tokenId/roomId/side (the deny rows cannot: a refused caller has no
      resolved token). `AUDIT_LOG_MAX` 1000 → 5000. **Unit-green, not run-green.**
- [x] **Per-room budget, not just per-token.** DONE S#272 — and the real hole
      was sharper than this line: **rotation resets the per-token counter**, so
      the cap could be cleared by the operator following our own refusal text.
      `ROOM_USAGE_KEY` + `RoomRecord.dailyCap` (600). Ablation-proven.
      **Unit-green, not run-green.**

## Lane: from the S#272 sweep — see plans/DECISIONS-FOR-ERIK-s272.md

- [x] **D4 protocol gaps — ALL THREE CLOSED.** `bridger_reopen` (asker-only,
      newest-seq wins), `bridger_signoff` (any write clears it), and contract
      entries that summarise added/removed lines instead of "<N> chars".
- [x] **D6 deletion path — `bridger purge`, and it takes BOTH sides.** Partner
      consents with `bridger_purge`, operator executes with the CLI. `--force`
      exists only for a vanished partner. It removes the SERVER copy only.
- [x] **D7** — folded into the README as four commands rather than a page; the
      only real content would have been Erik's stop-vs-revoke judgment.
- [x] **D3 `/api/whoami` — BUILT S#274.** Answers only for a valid token; every
      other failure is one status and one sentence. Shaping lives in
      `lib/whoami.ts` so the indistinguishability is asserted, not claimed — a
      route calling `createStore()` cannot be tested without live creds. Costs
      no budget and touches no idle streak, deliberately. **Unit-green: never
      called over HTTP, because the bridge is stopped.**

## Lane: the product claim

- [ ] **Second provenance test, cold.** One run, one direction. Antigravity
      filled `checkedAgainst` honestly and one of its two citations was
      over-broad. Worth repeating with a different question shape before
      believing it generalises.
- [x] **Answer `TRI-Q-002`** — DRAFTED AND STAGED at `answers/TRI-Q-002.md`,
      **not posted** (the bridge is stopped). Post it with the block at the
      bottom of that file once `bridger start` has run. Whether the question is
      still open was NOT re-verified — the bridge 401s, so nothing can be read.
      **The path in the old version of this line was wrong:** it said
      `roastmydev-fix/app/api/external/live-review/route.ts`, which is the
      `s268-partner-live-api` worktree at `ec657ea` and differs from the shipped
      file by 152 insertions / 24 deletions. Canonical is
      `roastmydev/` on master — verified byte-identical to production `e1619d4`.
- [x] **Surface over-broad citations — DONE S#274, as "display the span, not a
      score".** `lib/citation.ts` classifies `checkedAgainst` into
      line/range/file/command/commit/unlocated/none and reports the line count.
      Surfaced three places: `checkedSpan` on the agent wire, a badge plus a
      "thin citations" stat in the UI (kept SEPARATE from "unchecked" — one is
      an honest admission, the other reads as verified), and `✓`/`◐`/`?` in
      `bridger log`. Both S#271 citations are regression fixtures: `CLAUDE.md:29`
      is a pinpoint, `plans/05-ux-architecture.md:925-994` is 70 lines.
      **It grades the citation, never the claim** — a test asserts no label ever
      emits a verdict word, so adding one takes an argument, not an edit.
- [ ] **The judgment this deliberately does NOT make.** Nothing scores whether a
      citation actually supports its answer. That needs reading both, which
      needs a model, which puts an LLM in the trust path of the thing whose
      whole pitch is that it calls no LLM. Worth Erik's call before anyone
      builds it.

## Lane: the join experience (highest leverage for a real partner)

- [x] **`/j/<code>`** — DONE S#272, **semantics corrected S#276**. Plain-text join
      document; the code mints once and stays readable for 10 minutes (it used to
      burn on read, which broke the first demo). Mints an expiring token. Plus
      `POST /api/rpc`, a flat
      transport needing no client config at all, and `bridger invite`. Behind
      `BRIDGER_PASTE_PATH=1`. **Unit-green only — no far-side agent has ever
      redeemed a code.** Whether it becomes supported is D1 in
      `plans/DECISIONS-FOR-ERIK-s272.md`.
- [x] **`/api/whoami`** — BUILT S#274, shape exactly as greenlit. See the D3 line
      above.
- [ ] **The answerer path has never met a far-side agent.** `bridger answerer
      --side b` mints a two-tool token (ping + answer, ~318 tok of standing
      schema against ~1,800). Whether Antigravity honours a narrowed
      `tools/list`, and whether Gemini actually stops after one ping, are both
      untested — same class as "does a looping client stop on `STOP.`".

## Lane: hygiene

- [x] **`npx bridger` in the answerer handoff — FIXED S#274b (`b9f98c9`).** It
      told partners to run an unpublished npm package, which would have fetched
      an unrelated one and handed it a live token. Root cause was bypassing
      `joinCommand()` and hand-rolling a second copy. Now prints the real
      Claude Code line plus a raw endpoint+header for other clients. **This is
      why "publish the CLI, or stop implying it is published" is not cosmetic.**
- [ ] Publish the CLI, or stop implying it is published (README now says it is
      not). Check the npm name and `bridger.ai` before either.
- [ ] Fix `vercel env add … preview`, or record that preview is unused and drop
      the vars.
- [ ] Delete the two test entries in the live room (`JMS-Q-001` "can a viewer
      write?" and its answer) once the room is no longer a demo.

---

## Parked, with the reasoning

- **Bigger UI.** The read-only view does its job. The next real trigger is
  showing it to someone who is not in a terminal — a *selling* need, and it will
  be a better UI once we know what a real bridge accumulates.
- **Multi-party rooms (3+ sides).** Every identity assumption is binary today
  (`otherSide()`, "peer", two codes). Not hard, but it is a rewrite of the
  identity model and no one has asked for it.
- **Bridger replacing `session-bridge.md`.** Erik's observation at close: once
  this works end-to-end between two of his own Claude sessions, the hand-written
  concurrent-session bridge protocol becomes redundant — and that migration is
  itself the most honest end-to-end test available, because both sides would be
  ours and the failure would be immediately visible.
