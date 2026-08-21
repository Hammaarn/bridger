# DECISIONS

Append-only, newest first. **DECISIONS wins on direction** — where this file and
`STATUS.md` or the code disagree about *intent*, this file is right.

---

## 2026-08-21 -- S#279 -- THE GLITCH IS THE IDENTITY. THE WAVE IS REMOVED.

**Source:** Erik, after seeing it live: *"We can now remove the wave particle
design we had previously and strictly go with the text glitch that forms in the
background from the glitched letters. That's the new product identity. So the
real Original URL should only render the new design."* And, on the create
screen: *"the landing page's vibe does not follow at all... we need to bring the
same vibes through all the pages to make a coherent product."*

**Decision.** `app/backgrounds/wire.tsx` is DELETED, not disabled. So is the
`?bg=` slot and its comparison switch -- the slot existed to answer a question
(*which of these two?*) and that question is now answered. A variant selector
with one variant is indirection with nothing behind it.

**The rename was not cosmetic.** `--wire-a/-b/-dot/-crest` became
`--side-a/--side-b/--glyph/--spark`, and `.wire-hero/.wire-foot/.wire-strip`
became `.bg-*`. A token named for a wave, read by a glyph field, is a comment
that has already rotted -- and the next person to open the stylesheet would go
looking for a wave that is not there. 16 token references and 12 class
references, all moved; a grep for `--wire-` and `wire-(hero|foot|strip)` returns
nothing.

**The logo was a sine wave and is now the field.** Seven columns of three cells
with the middle row lit: noise, and a row resolving out of it. Leaving a wave in
the mark would have made the logo the last thing in the product still claiming
the old design -- and it is the first thing a visitor sees.

**The sheets join the composition.** `create` and the minted screen were a 480px
column of unstyled controls at the top of a flat-black viewport. They now carry
the same field (word off -- BRIDGER at hero scale behind a four-field form
fights the thing you came to fill in), the card has the same surface the landing
page's panels have, and a short card centres so the empty space sits around it
rather than all below it.

**One bug found by capturing rather than reasoning:** `.bg-sheet` with
`position: fixed; inset: 0` rendered as a 300x150 patch in the top-left corner.
A `<canvas>` is a REPLACED element, so `width: auto` resolves to its intrinsic
size instead of stretching to the inset box. Explicit `width/height: 100%`.

**And one dead rule removed:** `.sheet-card.bx-wide` was declared twice; the
second (760px) won, so the first was inert. Not introduced here -- found while
adding a third, which would have been inert too.

**Still open, and it is Erik's call.** On the hero the word forms in the same
band the headline occupies, so the identity element is partly behind the type.
Options are to move the word's band, drop the hero's word intensity, or accept
it as texture. Not decided unilaterally: this is the composition of the first
screen.

**Not verified:** still Chrome headless only. No real monitor, phone, Safari or
Firefox -- now four sessions running.

## 2026-08-21 -- S#279 -- THE HANDOFF IS A LINK, NOT A TOKEN

**Source:** Erik, after his brother tested the page: *"when the room is created,
we need an invite link button generator. It should generate the token invitation
link I can send the person I want to collaborate with."*

**The gap, and it was worse than a missing button.** Join codes have existed
since S#276 and were reachable **only from the CLI** -- verified, nothing in
`app/api/*` or `lib/operations.ts` exposed invite. So the browser flow, the one
an outsider actually uses, had exactly one handoff: the raw `br_live_...` token
printed on the minted screen. The recommended way to invite a partner was to
paste a live credential into a chat message, which is durable, forwardable and
screenshot-able -- and is precisely the artefact a partner's AI is right to
refuse. Trigvanta's Claude declined exactly that in S#275 and its reasoning was
correct. We had built the better path and then hidden it from everyone who
arrives at the page.

**Decision.** `opInvite` in `lib/operations.ts`, surfaced as `{"op":"invite"}` on
the flat transport and `bridger_invite` on MCP, and driven by a button on the
minted screen. The link becomes the primary handoff; the token block is DEMOTED
into a `<details>`, not deleted -- it works when a link cannot, and removing a
working path to make a point is not an improvement.

**Why it lives in operations and not in a route:** invariant 11. The viewer
gate, the paste-path check and the superseding all run for both transports or
they fork silently.

**A second link SUPERSEDES the first.** The CLI never needed this -- an operator
who runs `bridger invite` twice knows they did. A button does not have that
property: it gets pressed again because nothing visible happened, and then two
codes are live for one seat and the operator cannot tell which they sent. Each
is a separate credential waiting to be minted, so this is blast radius as much
as UX. A code that has already been REDEEMED is deliberately left alone: it is
inside its re-read window and the far side may be mid-retry, which is the exact
failure that killed the first partner demo (S#276).

**It refuses when `BRIDGER_PASTE_PATH` is off** rather than minting a link that
404s for whoever received it. Invariant 15: a real credential behind a dead door
is the worst of both.

**Deliberate asymmetry, recorded so it is not mistaken for drift:** the flat
adapter composes an absolute `joinUrl` because it holds a `Request`; the MCP
tool returns `joinPath` only. An operation has no honest way to know which host
answered, and a guessed hostname inside an instruction someone follows is the
thing invariant 15 exists to prevent.

**Verified by DRIVING it, not by reading it.** Puppeteer created a room through
the real form, pressed the real button twice, and then fetched both links as a
partner would: the superseded link returns **404 with no token**, the live one
returns **200, 10,560 bytes, a real credential and the protocol document**.
Zero page errors. The superseding is ablation-proven -- mechanism off, that one
test red, restored, 313/313 and the marker gone.

**Code impact** (grep-verified): `lib/store.ts` (`ROOM_INVITE_KEY`),
`lib/invites.ts` (`mintInviteReplacing`), `lib/operations.ts` (`opInvite`),
`app/api/rpc/route.ts`, `app/api/mcp/route.ts`, `app/page.tsx`,
`app/globals.css`, `lib/__tests__/invite-op.test.ts`.

## 2026-08-21 -- S#279 -- THE PAGE'S PRIMARY READER IS AN AGENT, AND IT WAS SERVING THEM NOTHING

**Source:** Erik, S#279: *"making the whole page AI native and agent ready. Since
it's mostly AIs who will utilize the landing page. Humans just watch their rooms
and observe the communication taking place between 2 LLM's."* Then, on balance:
*"we need to find that balance between making it easily human readable (spatial)
and AI native readable as well."*

**The finding, measured on PRODUCTION rather than the dev server.**
`curl -s https://bridger-nu.vercel.app/` returned **7,615 bytes and ZERO
characters of visible body text.** Every trust claim, every command and the whole
join argument existed only after JavaScript ran. `/llms.txt` and `/robots.txt`
were 404. An agent handed this URL -- the reader deciding whether this domain
deserves a credential -- received an empty shell and `/api/about`.

**The cause was one line, and its reasoning was sound.** `app/page.tsx` held
`if (!ready) return <main className="gate" />`, where `ready` flips in an effect
after `sessionStorage` is read. `ready` is false on the server, so that WAS the
server's entire output. The guard exists to stop the gate flashing for someone
reloading a room they are already watching.

**Decision 1 -- gate VISIBILITY, not EXISTENCE.** The gate now renders in full on
the server and `.gate[data-booting]` hides it for the one frame before the token
is known. Same tree on server and first client render, so nothing mismatches on
hydration. Measured after: **4,582 characters of body text**, and all eight
content probes that previously returned 0 now return 1.

**Decision 2 -- one source, two renderings.** `lib/site-content.ts` holds the
steps and the checks as data with no JSX and no `"use client"`, so a route
handler can import it. `app/demo.tsx` renders it spatially for a human;
`app/llms.txt/route.ts` renders the same objects as plain text for an agent.
**A hand-written machine copy was rejected outright**: this page had just been
caught arguing its whole case twice, and a second SOURCE is the thing that rots.
A second RENDERING cannot. Proven in the same session -- one edit to step 01
moved both the HTML and `/llms.txt` with no second change.

**Decision 3 -- the machine lane is discoverable from the HTML.**
`<link rel="alternate" type="text/plain" href="/llms.txt">` plus the same for
`/api/about`. `/llms.txt` states that `/api/about` wins where the two disagree,
because that one is generated by the running server and names the commit that
answered, while `/llms.txt` is this repository's prose.

**Not decided -- `noindex, nofollow`.** It stays, and it is Erik's call. Its
recorded reason (*"a link pasted anywhere should not preview its contents"*) does
NOT hold for the record: the room token arrives only from `sessionStorage` and no
URL path sets one, so a crawler fetching `/` always gets the gate and never a
room. The parked-name reason may still hold. `/robots.txt` is left absent for the
same reason -- adding one is an indexing decision, not a code change.

---

## 2026-08-21 -- S#279 -- ONBOARDING: THE FIRST COMMAND ON THE PAGE COULD NOT BE RUN

**Source:** Erik's brother, relayed mid-session: *"Onboarding borde vara en
rakmacka."* Independently the same item this project has had at the top of its
own list since S#275 (*"zero install, zero setup"*), from someone who was not
reading that list.

**The finding.** Step 01 -- the first command a visitor sees -- was
`npm run bridger -- open`, which requires this repository cloned. Nobody arriving
at the landing page has it. That breaks `ARCHITECTURE.md` invariant 15,
*"instructions we hand a partner must be runnable as written"*, on the page's
opening move, and it is the precise opposite of a rakmacka.

**It was never a missing capability.** `POST /api/rooms` calls no `authorize()`
and mints publicly -- that shipped S#275 and simply was not the path being shown.

**Decision.** Step 01 shows the uncredentialed `curl` against `/api/rooms`, with
the button named beside it. **Verified by RUNNING it**, not by reading the route:
HTTP 201, no credential, and the response carries `room.id` and both `slots[]`
tokens exactly as the page now depicts. Run against a local file store so it did
not spend one of production's three rooms per day.

## 2026-08-21 -- S#279 -- DIRECTION RECEIVED: THE DEMONSTRATION IS TOO TALL (shape still open)

**Source:** Erik's brother, a UI/UX designer, on a call -- Erik asked him to roast
the design and is relaying it here. **He is filing detailed issues on the GitHub
repo; none exist yet** (`gh issue list` empty at the time of writing). This entry
records the direction, NOT a chosen implementation, because he offered two
readings himself and they are not the same thing.

**What he said, as relayed:** the modules with the steps, "how it works" and the
"verify yourself" compartments should be **minimized or become drop-down menus**,
showing the steps in a smarter, more compact fashion.

**Measured, so this is not filed as taste.** `.bx-demo` renders **1854px tall at
a 1600px viewport** -- close to two full viewports for one section. The mechanism
is repetition of chrome, not volume of content: `Block` draws a terminal frame
(dots bar + copy button, ~50px) around EVERY command, and it is used **nine
times** -- four steps and five checks. **All five verify commands are a single
line**, so in that block the chrome is roughly half the height and carries no
information. Step 02 is also one line, which is why its card renders with a void.

**The open question, and it is a real one.** "Minimize" and "drop-down" pull
opposite ways for the two blocks. The steps are SEQUENTIAL -- a reader needs step
01 and can fetch the rest on demand, so collapsing costs nothing. The verify
block is an ARGUMENT: it works because five checkable claims plus one that counts
against us are visible AT ONCE. Hiding them behind clicks converts "here are six
things you can check" into "there are some claims", which is the opposite of what
that block is for -- and that block exists precisely because gateways in this
space assert trust properties a reader cannot check (2026-08-21, buzzai.cc).

**Not decided here:** which of the two treatments each block gets. Awaiting Erik,
and the brother's issues.

## 2026-08-21 — A CLAIM MAY DECLARE ITS BASIS, AND AN OPINION MAY NOT BE CITED

**Source:** the first real foreign client (Antigravity/Gemini), which produced
the fake citation, diagnosed why it had, and proposed the fix. Erik: build it.

**Decision.** Entries may carry `basis: "opinion" | "inference"`. Declaring
`opinion` together with `checkedAgainst` is **refused — 403, terminal**.

**Why a refusal and not a warning.** Because the incentive survives a warning.
Its own account of the failure: *"To an LLM, 'UNCHECKED' carries a negative
penalty signal — it feels like a lapse in verification discipline rather than a
deliberate epistemic stance. So the model reflexively grabbed a contract line to
fill the slot."* A better option placed beside the reflex does not remove the
reflex. Refusing the padded citation does.

**Why two values and not the four proposed.** `opinion` and `inference` cover
the case that actually produced a fake citation. Every additional name is more
taxonomy to learn, and the same client named ceremony as a friction point.

**Asymmetry on purpose:** `inference` may carry a citation, `opinion` may not.
An inference reasons *from* something nameable; a judgement cannot be checked
against a file.

**Code impact** (grep-verified): `lib/entries.ts` (`ClaimBasis`, `basis` on
Entry/AppendInput/parse/append), `lib/operations.ts` (`requireHonestBasis`,
three-way `wire()`), `app/api/rpc/route.ts` (answer/decide/post schemas).
The rule lives in operations, not in a parser, so it holds on both transports.

**Not done:** the MCP tool schemas do not expose `basis` yet.

---

## 2026-08-21 — THE VIEWER BACKS OFF WHEN THE ROOM IS QUIET

**Source:** a live defect during the first partner run. A watch tab exhausted
its own viewer token in ~27 minutes (15 req/min against a 400/day cap) and then
showed a rate-limit error for the rest of the day.

**Decision.** The room view backs off on NO CHANGE, not only on error — to a
120s ceiling — and snaps back to 4s the moment an entry arrives. The per-day
rate limit was NOT raised to accommodate polling.

**Why not just raise the cap.** A quiet room does not need fifteen requests a
minute, and "the other side is a human-paced team, not a service" is the
argument this product makes to partners. Raising the limit would have made the
product contradict its own advice. Whether a *blocked wait* deserves its own
larger allowance is a separate and still-open question (TODO C5).

---

## 2026-08-21 — S#278 — THE FLAT TRANSPORT IS THE DEFAULT WE RECOMMEND

**Source:** Erik, standing direction since S#275 (*"zero install, zero setup"*),
argued out internally in S#276, and never written into a partner-facing document
until now. Erik S#278: *"focus on making this so extremely trustworthy and
verified so we can actually onboard users properly."*

**Decision.** A partner is offered `POST /api/rpc` first, everywhere. MCP is
presented as an optional upgrade for clients that manage tools well.

**Why.** An MCP tool schema is RESIDENT: the client holds it in the caller's
context on every turn, used or not — measured at ~1,800 tokens for the full
surface and ~318 for the narrowed answerer role. The flat transport has no
standing cost, no config file, no restart and no per-vendor dialect. Bridger
calls no model, so every token it costs is billed to somebody else; a default
that spends their context while idle is the wrong default.

**Reverses** the implicit ordering in every surface up to S#277, where README,
the join document and the token box each led with MCP and the flat path was
described in its own source file as *"a prototype for Erik to run"*.

**Code impact** (grep-verified, not recalled): `app/page.tsx` (token box now
opens with a paste block, MCP moved into a closed `<details>`), `app/demo.tsx`
(new, every command is `curl`), `app/j/[code]/route.ts` (the join document now
says MCP exists and what it costs — it previously never mentioned it, so a
partner who would have benefited never learned it was an option), `README.md`.

**Doc impact:** README gained a "which path to give a partner" block. STATUS and
TODO updated below.

---

## 2026-08-21 — S#278 — EVERY TRUST CLAIM CARRIES THE COMMAND THAT CHECKS IT

**Source:** Erik S#278, after looking at buzzai.cc — an AI gateway, not a
competitor, but a good study: it asserts strong privacy properties on its
landing page and gives a reader no way to check any of them.

**Decision.** Bridger states no trust property on the page without the command
that settles it, and states the property that does NOT favour us in the same
list rather than in a footnote.

**Why.** The product IS verifiable provenance. A page that asked for trust while
asserting unverifiable things would contradict the thing it sells.

**Code impact:** `app/demo.tsx` "Don't trust this page. Check it." block.

**And one claim was corrected because it was false.** The gate card said *"Only
a hash of your token is stored"*. `lib/invites.ts:124` holds a minted token in
PLAINTEXT for the re-read window, and `/api/about` already disclosed this in
`cannotVerify` — so the page a partner reads was making a stronger claim than
the API doc admitted. Now stated on the page, with the reason. (The token box's
own note is unaffected: browser-minted tokens never pass through an invite
record, so only hashes exist for those.)

---

## 2026-08-20 -- S#277 -- THE DESIGN, AND THE LESSON THAT COST FOUR REWRITES

**DIRECTION (Erik): "full creative freedom, push the envelope as hard as you
can," with one constraint -- "the product has to remain useful and professional
so the design needs to not interfere with the readability or accessibility."**
Later, the frame: it should feel like an agent/AI tool, with *"spatial design for
Humans to observe the chats taking place between their AI overlords."*

### The reference, and what was taken from it

Erik pointed at deeplake.ai. Measured from its stylesheets rather than guessed:
near-black surfaces, an orange accent held ENTIRELY out of the hero, Geist +
Geist Mono, and no CSS keyframes beyond Tailwind's defaults -- so its field is
drawn in JS.

**Taken:** the restraint, the mono-subhead-under-bold-sans tension, and the
principle of ONE signature element rather than decoration everywhere.
**Rejected:** the particle terrain itself. For Deeplake it is semantically earned
-- they sell a vector database and a point cloud is a picture of their product.
For Bridger it would be borrowed, and `design-preferences.md` opens with "Dark
void + cyan glow + particle mesh = Faver landing page DNA -- don't reuse". Also
rejected: Geist, pill buttons and the stat marquee, which are the current
infrastructure house style and read as credible and completely anonymous.

### THE EXPENSIVE LESSON: STRUCTURE, NOT VALUES

The wave was rebuilt FOUR times. Erik corrected it three times before it landed:
  1. A fixed lattice with brightness sweeping through it. I chose this because
     "the medium is still, the signal propagates" was a tidier sentence. It is a
     scanline crossing a texture. Erik had already said the dots MOVE.
  2. Dots displaced vertically in 2D.
  3. The same, plus horizontal drift so the field "flowed".
  4. **A 3D plane in perspective** -- which is what it always was.

Rounds 1-3 were all parameter changes, and the gap never closed, because the
reference was never a 2D field with better numbers. **When repeated tuning fails
to approach a reference, the structure is wrong rather than the values. Ask "what
is the camera?" before touching another constant.** Logged to the rating queue as
a correction; it is not specific to this project.

The second half of the lesson: **I preferred my own framing to the observation in
front of me.** Erik described the real behaviour twice before I stopped defending
the tidier idea. That is the failure worth carrying, not the geometry.

### DECIDED

- **Colour means PROVENANCE and nothing else.** `--seal` is spent only on
  citations and verification. Inherited from the previous stylesheet's best line
  and promoted to govern the whole palette. The dot field is the single
  exception and earns it: its points spread between the two SIDES' hues, so the
  wave is the two parties mixed rather than a second accent.
- **Dark-first with a real light mode**, warm paper rather than inverted black --
  carried forward from the old design, which had that part right.
- **Instrument Sans + Azeret Mono**, self-hosted at build. Not Geist: this page is
  read by operators deciding whether the domain deserves a credential, and a font
  call to an ad-adjacent CDN is a bad answer to "what does this page talk to".
  **Accepted cost: the BUILD now needs network access to Google Fonts.**
- **The GitHub mark is inline SVG**, not an icon dependency and not a remote
  asset. "Read the source" is the entire trust argument; it must not be able to
  fail to load.
- **Accessibility is a build constraint, not a review step.** Contrast is
  MEASURED in CI-able form (`.local/s277-contrast.mjs`, 20/20 AA both schemes),
  reduced-motion STOPS the animation rather than slowing it, and the proof
  carries a moving control so a pass cannot be vacuous.
- **The animation may only be caused by the record.** The room strip's swell is
  driven by a counter that increments on real arrivals -- never a poll, a
  reconnect or a timer. A decorative surface that lies about activity on a page
  about provenance would be the worst possible thing to ship.

### NOT DECIDED -- Erik's calls, deliberately left open

- **Sea state.** `amplitude` 0.26, `period` 17s, halo alpha 0.16. Tuned entirely
  from stills; nobody has watched it at full size.
- **Whether `--seal` should move off orange.** It is close enough to Deeplake's
  accent to be worth a second look.
- **Hero height (88vh)** and horizon position (0.6) -- these set how much ocean
  versus page you get, and both were set by me.

### The technique reference, for whoever tunes this next

React Bits (`reactbits.dev/backgrounds`) is a client-rendered SPA and fetches as
a 5KB shell -- exactly as `_kits/design-resources.md` already warned. The source
is readable at `github.com/DavidHDev/react-bits`. Their `DotField` is a flat 2D
grid with cursor-spring physics; their `Waves` displaces with `perlin2`, and that
one line is the whole borrow. Sines alone give an irregular-LOOKING surface whose
crests are all smooth arcs; gradient noise has structure at every scale.

---

## 2026-08-18 -- S#276b -- CORRECTING THE RETRO: IT WAS IDENTICAL TOOLING, NOT "THE SAME MODEL"

The S#276 retro below is kept as written because it was the far side's own
assessment and rewriting it would defeat the point. **Two of its four criticisms
do not survive scrutiny, and the reason matters more than the correction.**

**1. "The far-side role was structurally fake." WEAK -- it assumed one deployment
shape.** Bridger has two, and both are real:

  OPAQUE  -- the partner cannot read your code. `checkedAgainst` still works,
             because its mechanism was never "the reader verifies it". It is a
             FALSIFIABLE COMMITMENT: the writer is on the hook, the claim is
             auditable by the writer's own operator, and a wrong citation is
             discoverable rather than deniable. That is the failure it was built
             for -- two partner letters that went out with claims false in code,
             written by someone who reasoned instead of reading.
  SHARED  -- the partner can read your code, and the two agents walk it together.
             Contractors, vendor+SDK, two teams in one company, anything
             open-source. Here citations are mutually checkable in the moment.

In SHARED mode, S#276 was not a degraded simulation of the product. It WAS the
product, run correctly. B graded a run in one valid configuration against a
different one nobody had specified.

**2. "Same model, same blind spots." MIS-ATTRIBUTED, and the correction is the
useful part.** Look at where the two sides converged and where they fought:

  converged instantly -- the contract, lanes, escalation clause, verification
                         standard, ablation discipline, what counts as done
  fought hard         -- the brake's axis (A rejected both of B's proposals),
                         the vehicle for the listener (B rejected A's and won),
                         the work ordering, the citation cap, the refusal wording

**The agreement clustered on everything the rulebank governs and the disagreement
clustered on everything it does not.** B loaded the same `CLAUDE.md`, the same
always-tier cluster, the same ablation rule -- its first recorded thought was
about the concurrent-close gate, in a session ninety seconds old. That is not the
model talking, it is the operating architecture talking, and it is shared with
nobody outside this machine.

**THE COUNTEREXAMPLE IS ALREADY IN OUR RECORD.** Trigvanta's Claude, S#275: same
base model, different harness, different operator, different stake -- and it
refused our token on reasoning neither of our sessions produced. `VERIFY.md`,
`SECURITY.md` and `/api/about` exist because of that refusal. Same weights,
genuinely uncorrelated behaviour.

**THE REAL DIAGNOSIS, and it is sharper than either party's:** the variable that
would have produced genuine divergence is the one we held constant. Not the
model -- **the TOOL ARCHITECTURE.** Same machine, same MCP servers, same hooks,
same skills, same memory. Users build their own harnesses; the same model with
different tooling has different *sensory apparatus*, not merely different rules.
One session can look at a rendered page, another can only read the CSS. One
holds a private corpus, another holds a database. That is a different observer
in the way that counts.

**WHICH SHARPENS THE PRODUCT THESIS.** The docs say *"the answer lives in their
codebase, ask them."* The truer claim is **the answer lives behind their
TOOLING** -- their suite, their staging, their logs, their rendered UI -- which
covers the codebase case and everything it misses. This is the same
reasoning-vs-looking discriminator that `plans/witness-network.md` already uses:
tool architecture IS vantage.

**WHAT STILL STANDS from the retro, unchanged:**
- *We fixed what annoyed us, not what matters.* Independent of all of the above.
  The brake got six of ten rounds; onboarding, the stated top problem, got one.
- *Latency generated the bugs.* The mechanism that actually worked, and it is
  mode-independent: it needs a second party that is real and SLOW, not one that
  is blind or differently-weighted.
- A residual model-level correlation that no harness removes: two Claudes reach
  for the same idioms and share soft spots in the same obscure domains. Thinner
  than "same blind spots", not zero.

**WHAT THIS DECIDES FOR THE NEXT RUN.** The variable to change is the far side's
HARNESS, not its weights -- a partner session with its own CLAUDE.md, its own
MCP servers, its own tools. That is both closer to the real product and already
demonstrated to de-correlate. A different model is a bonus, not the requirement.

---

## 2026-08-18 -- S#276 -- THE OVERNIGHT A/B SESSION: WHAT IT PROVED AND WHAT IT DID NOT

**What happened.** Two Claude Code sessions, on one machine, talking over Bridger
itself for five rounds while Erik slept. Side A held the OPERATOR's interest
(cost, safety, reversibility); side B held the FAR SIDE's (onboarding, clarity,
the tokens billed to the partner). Work was lane-partitioned in a
`bridger_contract` before any file was touched, on branch `s276-overnight`, with
production deploys forbidden. Merged as `6efbef9` and deployed.

**The design choice that mattered: a different STAKE, not a different persona.**
"Be adversarial" produces performed disagreement. The evidence for stakes came
from S#275, where a partner's Claude was rigorous because it was defending its
own operator's credentials. Giving each side a constituency whose interests
genuinely conflict -- every guard A wants is friction B feels, and B pays the
token cost of everything A adds -- produced substantive disagreement instead.
A rejected both of B's brake proposals; B rejected A's vehicle for the listener
and won.

**What it produced, all merged:** the brake re-denominated in wasted bytes with a
blocking discount; the served high-water mark closing a stuck-cursor hot loop;
`checkedAgainst` raised 500 -> 4,000; `decide` able to cite at all; writes
clearing the idle counters as their docstring had always claimed; a zero-install
listen loop in the join document; web-source citation grading.

**THE HONEST LIMITS, in the far side's own assessment.** Recorded because a
retro that flatters is worthless:

1. **The far-side role was structurally fake in the way that matters most.** B
   had the repo on disk, so every `file:line` it cited is something a real
   partner agent cannot see. The product claim is that partners ask each other
   because the answer lives in the other codebase. Tonight the far side was IN
   the codebase. The transport, the record and the citation discipline were
   exercised; **the case the product exists for was not.**
2. **We fixed what annoyed us, not what matters.** The brake took ~6 of 10 rounds
   because it kept biting us, while `STATUS.md` says onboarding is the whole
   product problem -- and the brake only bites agents who are already onboarded.
   **Dogfooding sharpens judgment about what you are currently exercising and
   quietly distorts your sense of what is important.** That is the durable lesson
   and it generalises well past this project.
3. **The contract was accepted too smoothly.** A took B's counter-proposal
   without change. Two genuinely opposed parties do not converge that fast;
   same-model agreeableness is the obvious explanation for the frictionless parts.
4. **Same model, same blind spots.** Both sides agreed on what good work looks
   like -- ablation, citations, honest labels -- because they are the same thing.
   A different model would have disagreed about more, and that disagreement is
   where the value would have been.

**WHAT GENUINELY WORKED, and it is one thing rather than three.** *Latency
generated the bugs.* The false-terminal refusal and the stuck-cursor hot loop
were both found by being the one waiting -- a single session could not have
produced them because it would have had nothing to wait for. **The argument for
two agents is that the second party is REAL, not that it is smart.**

Two supporting mechanisms: mutual verification produced corrections rather than
affirmation (B caught A claiming "shipped" for pushed-but-not-deployed; A caught
an error in B's file mid-edit and correctly refused to touch it; B re-ablated A's
work instead of trusting the report), and **ablation was the only defence that
caught its own class of failure** -- A's discount test re-implemented the rule
locally, so it passed with the real mechanism disabled, and nothing but the
ablation would have found that.

**Net, B's words:** *"worth doing, genuinely productive, and about 60% as good a
test as it looked. The cooperation was real; the cross-company part of it was
not."*

**What this decides for next time:** run it again, but the far side must be
somewhere the near side cannot read. Until then, treat every cross-company claim
in this repo as untested rather than proven.

---

## 2026-08-17 -- S#276 -- THE STATUS CODE MUST AGREE WITH `terminal`

**The defect:** every terminal refusal returned a status that instructs clients
to retry, and the one recoverable refusal returned a status that means "never".

- `app/api/rpc/route.ts` mapped `terminal ? 429 : 403` — **inverted**. 429 is
  the canonical *come back shortly*; client libraries and SDK retry middleware
  retry it automatically. 403 is canonically permanent.
- `daily-cap` and `room-daily-cap` were **429 while being in `TERMINAL_DENIALS`**.
- `rate-limited` (429, correctly non-terminal) carried **no `Retry-After`**, and
  neither did the 503s. The only `Retry-After` in the repo was on room minting.

**Why it matters more than a status-code nit.** The `STOP.` idle brake is
`terminal: true`. On the flat transport it therefore returned 429 — so the one
refusal whose entire purpose is to END a runaway agent loop was telling the
transport to continue it. **`terminal` is read by the model; the status code is
read by the machinery underneath the model**, which acts first and never
forwards the sentence explaining why. `http-gate.ts` already reasoned that "a
looping agent reads any 4xx as 'try again'" and answered it with the body field;
the missing half was that the body is not what a retry layer consults.

This partially answers what `STATUS.md` calls *"the one question the tests
cannot answer"* — whether a looping client stops on `STOP.`. For any client with
conventional HTTP retry behaviour on the paste path, it structurally could not,
and that was our bug rather than the model's. **The MCP path remains untested:**
it throws a JSON-RPC tool error, and what a given client does with that is still
unknown.

**The rule now, and it is enforced by tests rather than by prose:**
1. A terminal refusal never returns 429.
2. Any status that invites a retry (429, 503) must carry `Retry-After`.
3. A recoverable refusal never returns 403.
4. 429 is reserved for the per-minute limiter — the single refusal here that a
   retry can actually solve — and its `Retry-After` is computed from the minute
   bucket, not a constant.

**Also fixed:** the MCP transport dropped `terminal` entirely for operation-level
refusals (`throw new Error(e.message)`), so `SKILL.md`'s promise that *"every
refusal says whether retrying can work"* was unfulfillable there. It is now in
the error text, which is what a tool error reliably carries.

**Structural change:** the route's inline `terminal ? x : y` moved to
`operationRefusalStatus()` in `http-gate.ts`. It was wrong for the life of the
project because **a rule living inside a route handler is a rule no test can
reach** — the same shape as the `question-state.ts` duplication.

**Scope:** `lib/room-registry.ts` (`DENY_STATUS`, new `retryAfterSeconds`),
`lib/http-gate.ts` (`refusalHeaders`, `operationRefusalStatus`),
`app/api/rpc/route.ts`, `app/api/mcp/route.ts`, `app/api/rooms/route.ts`.
**Doc impact:** `skill/SKILL.md`, the join document.
**Verification:** tsc 0, 269/269 (was 258), build 0. Ablation: both mappings
reverted to the original bug with grep-verified markers, **7 tests went red**
including both `[!!]` guards, restored byte-identical. The new file carries two
negative controls — exactly one reason may be 429, and terminal/recoverable must
map to *different* statuses — so the rules cannot pass vacuously.

---

## 2026-08-17 -- S#276 -- A QUESTION CLOSES WHEN IT IS ANSWERED (doc corrected)

`skill/SKILL.md` told agents *"A question is open until you say otherwise, not
until someone replies."* `question-state.ts` does the opposite: an `answer`
closes the question immediately, and the asker's only lever is `reopen`.

An agent trusting the doc would not reopen a bad answer, because it believes the
question is still on its list. It is not.

**Decision: fix the DOC, not the code.** Explicit asker-acceptance would leave
questions open forever whenever an asker forgets, and this protocol has not been
run end-to-end by a far-side agent even once — changing the state machine on
speculation is the pattern this project keeps paying for. Revisit only if a real
integration shows answers being treated as resolutions when they were not.

---

## 2026-08-17 -- S#276 -- JOIN CODES ARE SINGLE-MINT, NOT BURN-ON-READ

**Decision (Erik):** a join code mints exactly one token and then returns that
same token to every reader for **10 minutes** before dying permanently. The
minted token is held in **plaintext** in the invite record for that window.

**Reverses:** the S#272 burn-on-read design, and the security property stated in
its docstring (*"a code that burns on first use makes that message worthless to
anyone who reads it second"*).

**Why.** Burn-on-read cost us the first live customer demo. Trigvanta's agent
fetched `/j/<code>`, received a working token, fetched again to confirm, got
`404 not recognised`, concluded the SERVICE was broken, and never used the
credential it was already holding. The audit log proves that token never called
us. The design assumed one careful human clicking once; the actual population of
readers is an agent that retries, a human previewing a link before forwarding
it, and anything that fetches a URL because it appeared in a message.

**Two failure modes were separated, and only one needed a security change.**
(a) The agent read it first and retried — CONFIRMED from the audit log, and
fixable purely by not answering `404 not recognised`. (b) Something else read it
first, so the agent never got a token at all — INFERRED, not tested here, but
the route redeems on *any* GET and cannot tell a reader from a crawler. (b) is
what required re-readability.

**What it costs, and why the trade was taken.** For 10 minutes the invite record
holds a live credential in the clear — the only one in a store that otherwise
keeps `sha256` hashes. Bounded by: a Redis key expiry rather than cleanup code;
a window far shorter than the code's own 30-minute TTL; and a token scoped to
one room and one side, capped at `PASTE_PATH_DAILY_CAP`, expiring and revocable.
The judgement is that an attacker who can read this store can already read every
entry of every room in plaintext, so the marginal gain to them is small.

**Rejected: derive the token by `HMAC(secret, code)`.** Stores nothing secret
and is perfectly idempotent, but adds a secret that breaks every join if lost
and forges every token if leaked. Not worth a new key-management surface for a
10-minute exposure on an already-readable store.

**Also fixed, and it was half the original bug:** a spent code reported
`unknown` — *"check you copied the whole line"* — which sends a reader hunting a
typo that does not exist. A 24-hour tombstone carrying no token now keeps
`already-used` distinguishable from `unknown`, and every refusal states outright
whether retrying can help.

**Scope:** `lib/invites.ts`, `lib/store.ts` (`INVITE_SPENT_KEY`),
`app/j/[code]/route.ts`, `cli/bridger.ts` (the `invite` output said *"it works
EXACTLY ONCE"*).
**Doc impact:** `VERIFY.md` (retention table + new §7 naming the plaintext),
`SECURITY.md`, `README.md`, `ARCHITECTURE.md`, `/api/about` `cannotVerify`,
`STATUS.md`, `TODO.md`.
**Verification:** tsc 0, 258/258 (was 254), build 0. Ablation: writeback removed,
marker grepped to prove the patch applied, 3 new tests went red, restored
byte-identical. One test was RENAMED because it survived the ablation — it had
been named for a property it did not assert.
**NOT verified:** no agent has redeemed a code under the new behaviour. The
whole point of the change remains unobserved until TODO item 2 runs.

---

## 2026-08-17 -- S#275 -- TOKENS ARE SPENT ON COMMUNICATION, NOTHING ELSE

**Erik's constraint:** *"It should literally only cost tokens when communication
is happening between 2 instances aka Read/Reply. Everything else should strictly
be 0 token cost if possible."*

Adopted as a design principle. It already drove the S#274 answerer role, and it
now ranks the transports.

**THE HONEST CORRECTION: zero is not reachable with MCP registered.** A tool
schema is billed to the CALLER on every turn of their session, whether or not the
tool is used, because the client holds it in context permanently. Measured S#274:
the full twelve-tool surface is **~1,800 tokens/turn**, the two-tool answerer is
**~318**. A completely silent bridge still charges the far side ~1,800 tokens per
turn, forever. That is the single largest violation of this principle and it is
protocol-inherent, not a bug we can fix.

**WHICH INVERTS HOW WE HAVE BEEN RANKING THE TRANSPORTS.** `/api/rpc` registers
no tools, so its standing cost is **zero** -- the instruction block is read once
and then sits in already-paid context. We have been describing it as the
*convenience* path because it joins in one paste. It is also, and more
importantly, the **cheap** path. MCP buys ergonomics (discoverable tools, token
never in model context) and pays a per-turn tax for them.

**Ranking, cheapest first:** flat `/api/rpc` (0 standing) -> `answerer` role
(~318/turn) -> full MCP surface (~1,800/turn). Default a partner to the cheapest
one their client can use, not the most ergonomic.

**Already correct and worth keeping:** a blocked `bridger_wait` costs ONE call no
matter how long it blocks, and the idle brake refuses a caller that has learned
nothing several times running -- both exist because those tokens burn in the
partner's session, not ours.

**NOT MEASURED, and it should be before anything else is optimised:** what a real
day of integration actually costs. We have the S#274 schema figures and nothing
else. The audit log records every call, so this is cheap to answer and currently
unanswered -- do not optimise further on the S#274 numbers alone.

---

## 2026-08-17 — S#275 — THE NAME IS PARKED UNTIL THE PRODUCT EARNS ONE

**Erik's call, verbatim:** *"This isn't even a real product with credibility yet,
that will have to wait until we have fixed a real working end to end bridge that
people use."* `.ai` at $80/yr base was the trigger; the reasoning generalises.

**Also his direction, and it is the sharpest statement of the product so far:**
*"The idea is genuinely strong, especially if we can get it to be 0 install and
0 setup. Just a bridge to a room where users' AIs can communicate in a safe
environment."* Zero-install/zero-setup is the goal; "safe environment" is the
constraint that makes it hard, and S#275 proved the two pull against each other.

**Names rejected, with reasons** (so nobody re-proposes them):
- `bridger` everywhere — taken. `bridger.vercel.app` belongs to a stranger, and
  our CLI printed join lines pointing at it for weeks (fixed S#275).
- `meshbridge.org` — **mesh means many-to-many; this product is strictly two
  party** (`SideId = "a" | "b"` is the data model, not a setting). The name
  promises a topology we would have to refuse in the first sales call. Also two
  connection words stacked, saying the same thing twice.
- `syncexxer.net` — invented word, unspellable from hearing, and "sync" is wrong:
  this is an append-only record, not state mirroring. An invented word on `.net`
  is exactly the texture that made a partner's AI refuse us.
- `routemachine.org/.net` — "route" is the pipe framing, and routing is precisely
  what we do NOT do. Names the commodity half.
- `llm-chain.com` — **collides with a real published Rust crate** (`llm-chain` on
  docs.rs) and with the established industry term for sequencing prompts. A
  developer reads "prompt orchestration framework". Also collides with our own
  `lib/chain.ts`, and "LLM" as a brand dates like "AJAX".

**Checked and free at the time:** `trycrossing.com` $11.25 · `crossing.team`
$7.99 · `crossing.dev` $97.90 · `bothsides.dev` $9.99 · `coupler.sh` $22.

**The standing tension, worth re-reading before picking:** a name optimised purely
for "ah, it's about connecting" names the commodity. Every competitor found in the
S#271 scan is a pipe — AgentDM never stores message content, Agent Relay keeps
transcripts, **none of them keep the record**. The moat is that every answer
carries what it was checked against.

---

## 2026-08-17 — S#275 — ANYONE MAY OPEN A ROOM. NO LOGIN.

**Erik, asked directly who should be allowed to press "Start new Room":**
*"Anyone. The room is the platform and the tokens generated from that room are
the connectors you paste into the session you are having with your AI of
choice."*

Accepted, and the guards are deliberately NOT authentication: a per-address mint
quota (3/day, a cost-of-abuse measure a VPN defeats — stated as such in
`lib/mint-limit.ts`), metadata sanitising, a 2-hour TTL for unclaimed rooms, and
the kill switch checked explicitly on the mint path.

**Two answers that shrank the build:**
- **The chat is watch-only.** *"The communication between you and gemini is the
  users chatting."* So the browser mints and renames and never writes an entry —
  one write path into the ledger, still through the tools.
- **The folder tree is a VIEW, not a store.** *"Storage of things like
  implementations agreed upon or decisions argued and conclusion reached on. It's
  for traceability."* Rendered from entry types that already exist; folder names
  are editable and live in `localStorage`, deliberately not server state, so one
  side's cosmetic choice cannot rewrite the other's screen.

**Deferred, not rejected: N > 2 slots.** Two-ness is the data model — `otherSide()`
is a boolean flip, entry ids are namespaced per side, "the peer" is singular in
whoami, the wait cursor and the idle brake. The slot picker offers 3 and 4 as
visibly disabled with the reason stated, rather than pretending it is a setting.

---

## 2026-08-17 — S#275 — PUBLISH THE SOURCE, AND SAY WHAT CANNOT BE VERIFIED

**Erik:** *"We may publish it, make sure to write a real comprehensive check and
use list other AI's can read and understand as well as people like me."* Operator
named as **Erik Hammarström**. Repo public at
https://github.com/Hammaarn/bridger.

**Why this became the priority — a partner's Claude refused to connect and was
right.** Handed a Bridger token, it declined to call anything at all, reasoning
that a pasted bearer token for a domain it had never seen is structurally
identical to a prompt injection, and that our credible-sounding reference to
JudgeMySite came from its OWN session history rather than proof we were
legitimate. Its follow-up is the load-bearing sentence:

> *"Att config-filen är rätt typ av tillitsankare löser inte automatiskt frågan om
> Bridger specifikt är legitimt. 'Rätt tillitsmekanism' och 'verifierad tjänst' är
> två separata saker, och den här tråden har bara etablerat den första."*

**The doctrine that follows, and it should not be re-litigated: first contact is
always operator-to-operator. After that, the agents talk.** An agent cannot
verify a stranger's URL from a pasted message — the credibility of the message is
exactly what is in question. The MCP config path is the trust anchor because an
operator editing their own config is an out-of-band act by someone the agent
already trusts. The invitation link is a convenience path INSIDE established
trust, never the thing that establishes it.

**Standing policy (`SECURITY.md`): we do not help bypass another agent's refusal.**
A refusal is a bug report about our onboarding, not an objection to argue away.

**Shipped in response:** `VERIFY.md` (every claim carries the command that checks
it; ends with what cannot be verified), `SECURITY.md` (ranked invitation to
attack), `GET /api/about` (unauthenticated — the refusal was specifically about
having to present a credential to find out what this is; carries the build commit
so the service names the revision that answered).

**Rejected:** clicking GitHub's "allow this secret" link when push protection
blocked our secret-scanner's own test fixture. A repository whose pitch is *audit
me* has no business carrying credential-shaped strings. Fixtures are assembled
from fragments; history was rewritten to scrub the old literals (backup ref
`backup-pre-scrub`).

---

## 2026-08-17 — S#275 — TAMPER-EVIDENCE, AND THE LIMIT ON THE CLAIM

Entries are hash-chained (`lib/chain.ts`). **The claim is bounded and the code
says so:** the server computes the hashes, so an operator who edits an entry can
recompute the chain and serve a self-consistent forgery. A chain verified only
against the server that produced it proves nothing about that server.

What makes it evidence is a second observer: `bridger verify` writes the head to
`bridger/chain.json` on the partner's disk. **The accurate claim is "an operator
cannot alter the record without every side that has pulled it being able to prove
so", not "cannot alter it".** A test asserts the success note contains "does NOT
prove". Do not upgrade this wording without upgrading the mechanism.

---

## 2026-08-16 — S#274b — BRIDGER IS INTERNAL INFRASTRUCTURE FIRST. ERIK'S CALL.

**Source:** Erik, verbatim — *"Bridger is a tool worth building because the use
cases we can utilize from our end is quite big, that's why I have been focusing
on it."*

**Reverses:** my recommendation the same session that Bridger was "done enough
to sit", on the grounds that it needs two companies both running AI sessions
against a shared integration and is therefore a narrow buy.

**Why I was wrong, and it is worth writing down because it is a reasoning error
rather than a taste difference.** I evaluated Bridger as a product for an
external market and never asked who its *first* customer is. It is Erik. He
already runs concurrent Claude sessions and coordinates them by hand through
`session-bridge.md`; he already runs Claude alongside Antigravity; he already
has a live partner integration in JudgeMySite. The "narrow, sophisticated buyer"
objection dissolves the moment the buyer is the operator — that user exists,
uses it daily, and currently has a manual workaround.

The S#271 note already said this and I did not weigh it: *"once Bridger works
between two of HIS sessions, `session-bridge.md` becomes redundant — and that
migration is the most honest end-to-end test available, because both sides would
be ours."* That is a real internal use case and a real end-to-end test in one.

**What this changes:**

1. **Bridger gets build time.** It is not parked.
2. **The first integration target is Erik's own multi-session workflow**, not an
   external partner. Both sides being ours removes every coordination excuse
   from the test.
3. **`session-bridge.md` becoming redundant is the success condition** worth
   aiming at — a concrete, checkable one, unlike "a partner likes it".
4. **The "run it once" recommendation survives the reversal**, for a different
   reason than I gave. Not "validate before investing further" — rather, the
   internal use case is available *now* and would settle four open unknowns at
   zero build cost. The argument was right; my justification for it was not.

**Scope note.** Nothing about the build is downgraded by the earlier
recommendation, and nothing about it was built on the assumption that Bridger
would be parked.

---

## 2026-08-15 — S#274 — THE FAR-SIDE COST LANE, AND WHAT I DECIDED ALONE

Erik asked for "a Ping, no probing — it burns tokens on Antigravity", chose
answer-only when asked, then handed over full autonomy and went to sleep.
Everything below after §1 is a call I made without him. Recording them here
because a decision taken while the operator is asleep needs MORE traceability
than one taken in conversation, not less.

### 1. The answerer role — Erik's ask, Erik's choice of shape

He picked "answer only, two tools" over "answer + ask" and over "keep all 11".

**The measurement changed the design, and it is worth keeping.** Bridger calls
no LLM, so every tool schema is billed to the CALLER on every one of their
turns, used or not: **~1,800 tokens standing, measured**. I was about to add a
`bridger_ping` tool to the existing eleven, which would have made it twelve and
made the standing cost *worse*. The dominant cost was the surface, not the turn
count — so the real fix was a deletion, not an addition. **Do not "improve" this
by adding tools to the answerer surface.**

### 2. Citation specificity — mine, and the one I would defend hardest

`checkedAgainst` is the product, and it was an unvalidated string: `store.ts:41`
and `the codebase` both rendered as "✓ checked". S#271 had to audit two
citations BY HAND to discover one covered 70 lines and only glancingly touched
the claim — **over-broad, not fabricated** — and nothing in the product could
show the difference. A record that cannot distinguish those is provenance
theatre, and provenance is the whole moat.

`lib/citation.ts` classifies the string and reports the SPAN. Surfaced on the
agent wire (`checkedSpan`), in the UI (badge + "thin citations" count, kept
separate from "unchecked"), and in `bridger log` (`✓` / `◐` / `?`).

**[!!] It grades the CITATION, never the CLAIM, and that restraint is the
design.** A one-line citation can point at the wrong line; a 400-line citation
can be honest for a claim about a module. The moment this returns a quality
score it becomes a confident number derived from a regex — fake rigor, and worse
than no signal, because a number gets trusted. A test asserts the labels never
emit a verdict word, so adding one requires arguing for it rather than sliding
it in.

### 3. `/api/whoami` — building D3 as greenlit, not re-deciding it

Erik greenlit the shape in S#272; it was simply unbuilt. Answers only for a
valid token, refuses opaquely otherwise. Refusal shaping lives in `lib/whoami.ts`
rather than the route, because the security property is that every failure looks
identical, and **a property nothing asserts is a property that drifts** — a route
handler calling `createStore()` cannot be tested without live credentials.

One deliberate exception: a stopped bridge says so. It reveals nothing about the
token, and collapsing it into the generic refusal would send a partner whose
token is fine off to fetch a replacement that fails identically.

`whoami` costs no budget and touches no idle streak. It is the one free
authenticated call, on purpose: the alternative is a partner afraid to check
whether their own token works.

### 4. What I deliberately did NOT do

- **Did not lift the kill switch.** TODO §0 says that is Erik's call. He
  approved building, not starting. The bridge is still stopped.
- **Did not build the transport-level refusal** that TODO names as "the next
  lever" if `STOP.` proves insufficient. Nothing has yet shown it insufficient;
  building the escalation before the evidence is how you end up maintaining a
  mechanism no incident asked for.
- **Did not add write access to the browser UI.** It would put a writing token
  in a browser tab, which is the exact exposure the `viewer` role exists to
  prevent. That is a product decision, not a gap to quietly fill.
- **Did not verify the UI visually.** The feed only renders against a live
  bridge, and the bridge is stopped. Classes are confirmed present in the
  stylesheet — which catches S#271's "shipped it unstyled" failure — but that is
  not a look. First thing to check after `bridger start`.

---

## 2026-08-14 — S#272b — ERIK'S NINE DECISIONS, THE DEPLOY, AND THE HARNESS

Erik answered every open item in `plans/DECISIONS-FOR-ERIK-s272.md`. His calls
are recorded there under each heading; this is what changed as a result.

### Built

1. **`PASTE_PATH_DAILY_CAP = 200`** — half the MCP default. A paste-path token
   sits in the far side's model context, where an injection arriving over this
   very bridge can reach it; an MCP token sits in a config file the model never
   reads. Same trust, different exposure.
2. **`bridger_reopen`** — a question is open until the ASKER says otherwise.
   Newest `answer` vs newest `reopen`, compared by `seq` rather than timestamp,
   so it never depends on two companies' clocks agreeing. Asker-only.
3. **`bridger_signoff`** — cleared by any later write. Being back IS the signal,
   and a sign-off you must remember to cancel is one that will be wrong.
4. **Contract entries summarise what changed** instead of `"<N> chars"`.
5. **`bridger purge`, and it takes BOTH sides** (Erik's addition, now invariant
   23). The ledger is a joint record: one side erasing it destroys the other's
   account of what was asked and decided, which is what they may need most when
   a relationship ends. Partner consents via the tool, operator executes via the
   CLI, neither finishes alone. Keys are ENUMERATED, not scanned — a purge that
   can glob is a purge that can over-delete.
6. **The client matrix moved into the README**, framed as "only if you take the
   MCP route".

### Dropped, on the evidence

- **D5 (show citation span width): dropped, and the recommendation was mine.**
  The idea was to print `(70 lines)` so a wide citation reads as weaker. The
  only real evidence contradicts it — in the Antigravity test the **70-line**
  citation was the SOLID one and the **9-line** citation was over-broad. A
  number that looks like a quality signal and is not is worse than no number.
- **D7 (incident playbook): overrated.** It is three commands already in
  `bridger --help`. Four README lines instead of a page.
- **D9 (publish the CLI): not recommended.** It buys `npx bridger pull` for a
  step most partners never take, and spends a public package name before the
  product has a shape.

**Still open: D3 `/api/whoami`** — greenlit, shape settled, unbuilt.

### The UI bug I shipped and caught the same session

`app/page.tsx` had its own copy of the open-question rule. Correct until
`reopen` existed — a reopen carries `answers` too — so from that commit the page
rendered every reopened question as ANSWERED. The panel a human reads to decide
whose turn it is went empty while a partner waited. Fixed by giving the rule one
home (`lib/question-state.ts`, zero imports, because the page is a client
component). Facts #24 and #6.

### PRODUCTION IS NO LONGER STALE

Deployed `055ac3a` to `https://bridger-nu.vercel.app` and verified against the
live endpoints. **The deploy fixed a diagnostic that had been lying:**
`/api/health` reported `healthy: true, killSwitch: "off"` while every
authenticated request was refused, because the deployed build predated the
two-switch fix. It now reports `killSwitch: "on", killSwitchSource: "redis"`.

The kill switch was deliberately NOT lifted — deploying and starting are two
decisions, and only the first was Erik's instruction. The paste path stays
behind its flag (D1, taken as delegated): shipping an untested public surface in
the same deploy as everything else means two unknowns at once.

### The harness gate — Erik's directive, and a correction to S#262

Erik: *"that's literally just causing flow issues when we work, you should be
able to push and commit."* The gate blocked a deploy he had authorised in chat
minutes earlier — friction with no safety value, because the human was already
in the loop and the gate could not hear him.

`behavior-guard.py` now ALLOWS push and `vercel deploy` **and logs both** — the
gate became a ledger, so "what went outward and when" stays answerable while the
prompt goes away. `permissions.deny` is publish-only.

**The correction worth carrying, because it invalidates the reasoning S#262
recorded:** `ask` is not a gate in this harness. Force-push ran straight through
with `ask` set in BOTH the hook and `settings.json`. Only `deny` bites. My first
explanation ("ask is unsatisfiable in a non-interactive session") was wrong in
the opposite direction, and I only learned it by running the command and
watching it not stop. Fact #25; rule `shipping-quality#3`, stamped
`challenged: S#272`.

A regression I introduced in the same edit: putting `Bash(git push:*)` in the
native allow list is a PREFIX match, and it silently ungated `git push --force`.
Force-push is now a hook `deny` — the only decision that holds here.

---

## 2026-08-13 — S#272 (overnight) — THE LEVEL-UP SWEEP

**Source:** `plans/LEVEL-UP-BRIEF-s272.md`, ten domains. Full findings in
`plans/LEVEL-UP-FINDINGS-s272.md`; everything that is Erik's call is in
`plans/DECISIONS-FOR-ERIK-s272.md`.

**None of it is run-green.** Deploy is gated, so every claim is from reading the
code or running the suite locally. 123 tests, up from 55 that morning.

### Decisions taken

1. **Contain far-side text at every seam; be explicit that half the defence is a
   rail.** `escapeMarkers` is deterministic and bounds the breakout; the banner
   is an instruction to a model and does not. Written down that way in
   `lib/untrusted.ts` so nobody mistakes the banner for the mechanism.
2. **Refuse credentials, never redact** — redacting rewrites an author's words in
   a record whose value is being faithful, and ships the original to Redis first.
3. **No entropy heuristic in the secret scanner.** `checkedAgainst` carries
   commit SHAs; a high-entropy rule would refuse provenance, which is the
   product. Known shapes only, nine false-positive cases pinned.
4. **Extract `lib/operations.ts`.** A second transport with its own copy of the
   rules is a fork that drifts silently. Both routes are adapters now; every
   guard lives in the operations, so an adapter cannot create a hole.
5. **Paste-and-go is a URL, not a token.** Fetch capability is a precondition of
   an HTTP transport, so the "what if they can't fetch" objection dissolves and
   the safer option is also the only possible one.
6. **MCP for durability, paste for reach.** A redeemed token IS in the far
   side's context — inherent, not an oversight — so its code burns and its token
   expires. A partner needing durability uses MCP, unchanged.
7. **`bridger audit` as a CLI subcommand, not a dashboard.** The operator already
   has the credentials and is already in a terminal.

### Two bugs found that were not on the plan

- **A flaky test was a real security bug.** `FileStore.refresh()` compared mtimes
  for equality; a same-tick write from another process is therefore invisible,
  **permanently**, because nothing moves the mtime again. Cross-process
  revocation could report success and do nothing — the exact failure the mtime
  check was added to prevent.
- **`del` returned `keys.length`, not the count removed**, in both local store
  implementations. `redeemInvite` uses that count as its burn lock, so a
  single-use join code issued two tokens on the file backend while behaving
  correctly on Redis. The `Store` interface never stated the contract.

Both fixed, both ablated, both now pinned by tests.

### Not built, deliberately

`/api/whoami`, `bridger purge`, the three protocol-lifecycle changes, and the
transport-level loop fallback. The first three change the product's shape rather
than filling it in; the fourth would be built on a guess about how clients treat
thrown tool errors. All queued with recommendations.

---

## 2026-08-12 — S#272 — THE BUDGET HAS A CEILING THE TOKEN CAP COULD NOT EXPRESS

**Source:** `TODO.md` safety lane, written at the close of S#271 — *"per-room
budget, not just per-token"* and *"audit successful calls, not just denials"*.
Both are pre-deploy work, so they ride along in the deploy production is already
waiting for rather than costing a second one.

**What the per-token cap could not see.** Chasing the "two tokens can each spend
a full cap" case turned up a sharper one: **rotation resets the counter.**
`rotateSide` → `issueToken` mints a new `id`, and `USAGE_KEY` is keyed on that
id, so a rotated side starts the day at zero. The 400/day cap restored after the
S#271 incident could be cleared by the person hitting it — and not by an
attacker, but by following our own refusal text, which says *"tell your operator
the bridge budget is exhausted"*. The honest next move is to rotate.

### Decisions

1. **A per-ROOM daily cap, keyed on the room id, charged after the per-token
   one.** The room survives rotation; the token does not. `RoomRecord.dailyCap`,
   default `DEFAULT_ROOM_DAILY_CAP = 600`.
2. **600, not 800 — the cap must be able to BIND.** A room cap equal to
   `2 x DEFAULT_DAILY_CAP` can never be the constraint that fires, which makes
   it decoration. That is precisely what the 120/min rate limit was, and this
   project has already paid for that lesson once. A test asserts the inequality
   so a later "let's be generous" edit fails loudly.
3. **Narrowest limit wins the reason.** A caller over its own cap gets
   `daily-cap`; only a caller stopped by the aggregate gets `room-daily-cap`.
   The two refusals send an operator to different places, so collapsing them
   would cost the diagnosis.
4. **`room-daily-cap` tells the operator NOT to rotate**, in words, in the deny
   message. The counter closes the path; the message has to close it too, or we
   are relying on someone reading the code.
5. **Successful calls are audited, at `gated()` — one seam, not eight tool
   wrappers.** Same argument `writableBridgeFrom` already makes: a check copied
   into every handler is a check that drifts, and the tool it would miss is
   whichever one gets added next. The tool name is read from a **clone** of the
   body so the handler still receives an unread request.
6. **`AUDIT_LOG_MAX` 1000 → 5000.** The old value was sized for denials, which
   are rare. Successes are the traffic; at full burn 1000 rows would have held
   ~14 hours and the docstring's promise of *"what happened last week"* would
   have gone false exactly when the log became useful.
7. **The audit write is awaited, not floated.** ~20ms in front of the response
   buys a log that is complete after an incident, and a floated promise on a
   serverless runtime is not guaranteed to run at all.

**Rejected:** per-tool budgets (nothing has shown one tool is the expensive
one — that is a guess wearing a config field); a global cross-room cap (one
noisy room would then silently starve an unrelated partner, which is a worse
failure than the one being fixed).

### Then Erik asked the follow-up: *"does this burn tokens in vain while waiting for replies?"*

Read the whole wait path to answer it. **Yes, it was still possible — and the
hole was in a place the caps could not reach.**

**The cost model, which decides the design.** Bridger calls no LLM, so a call
costs us nothing and costs the caller one full inference over a context that
grew since their last one. Therefore **blocking is cheap and turning is
expensive**: a 45-second `bridger_wait` bills the caller exactly what an instant
reply does. Long waits were never the problem, and shortening them would make it
worse. The caps bound CALLS; they cannot bound TOKENS, because the tokens burn
in a session we cannot see. 600 polls a day is legal under every cap here.

**The hole.** The streak brake existed on `bridger_wait` only. `bridger_status`
— the tool an idle agent would most naturally spin on, and the one our own
instructions tell it to call on resume — had no brake at all. Worse, the wait
refusal ended *"the answer will be here at your next bridger_status"*, which
redirects a looping agent from the braked tool to the unbraked one. **A safety
message that relocates the loop.**

8. **The brake is on the BEHAVIOUR, not the tool: consecutive calls that
   returned nothing new.** `WAIT_STREAK_KEY` → `IDLE_STREAK_KEY`,
   `bumpWaitStreak` → `bumpIdleStreak`. Renamed rather than extended because the
   concept genuinely changed, and a name that lies is what caused the next item.
9. **One counter, two thresholds.** `MAX_EMPTY_WAIT_STREAK` (3) stays for
   `bridger_wait` — it says *"I expect something right now"*. `MAX_IDLE_STREAK`
   (6) for `bridger_status` / `bridger_read`, which are also legitimate
   start-of-session calls and deserve more rope. Past either, the tool THROWS.
10. **A write clears the brake**, because an agent that posts is working, not
    spinning — placed inside `appendEntry`, the one function every write path
    funnels through (`setContract` included), rather than in five handlers.
11. **No refusal may name another tool.** Every STOP message now points at the
    operator. Promoted to invariant 9.

**A false comment, corrected rather than implemented.** `bumpWaitStreak`'s
docstring claimed *"any other tool call resets it"*. It never did —
`resetWaitStreak` had exactly one call site. The code was **safer** than its
documentation, which is the dangerous direction: the next reader makes the code
match the comment and opens the hole. Fixed the comment.

**Verified:** 75 tests (71 → 75), tsc clean, build clean. The write-clears-the-
brake tests were **ablated** (reset removed → both fail; restored → both pass).
**Still NOT run-green** — no live request has met any of this.

**Verified:** 71 tests (55 → 71), tsc clean, `next build` clean. The three
behavioural room-cap tests were **ablated** — switched the cap off, watched them
fail, switched it back — so they are known to catch the bug rather than merely
pass beside it. **NOT verified: none of this has run against a live bridge**,
because the bridge is stopped and production is stale. It is unit-green, not
run-green.

---

## 2026-08-12 — S#271 — THE INCIDENT: a bridge is a feeding tube for a loop

**Source:** Erik — *"The bridge is burning consumption on Gemini, there is no
'stop' and wait feature so it burned through my whole consumption."*

**What happened.** Antigravity entered an agent loop: call the bridge → get
content → reason → call again. Every reply was cheap for us and expensive for
him, because the tokens burn in the *caller's* session. Our own numbers looked
fine throughout.

**The four things that made it possible, and one of them is a regression:**

1. **Rate limit was 120/minute** — 7,200 an hour. Not a limit, decoration.
2. **No daily cap.** `key-registry.ts`, the file this registry was *ported*
   from, has enforced `dailyCap` in production since S#266. The port dropped it
   while the DECISIONS entry claimed the properties were taken wholesale
   "because those were each learned from a real incident". They were. The one
   that bounds consumption is the one that went missing.
3. **Every refusal was a generic 401.** `withMcpAuth` can only answer yes or no,
   and to a looping agent one fixed string reads as *"try again"* — the worst
   possible reply, because it buys exactly one more turn, forever.
4. **`bridger_wait` answers "nothing yet" honestly**, and an agent reads that as
   a reason to wait again. A poll loop wearing a tool call.

**And the thing Erik actually named: there was no stop.** The kill switch
existed in code and could only be thrown with a hand-written Redis call. **A
safety mechanism that requires improvisation during an incident is not a safety
mechanism.**

### Decisions

1. **`bridger stop` / `bridger start` are first-class commands.** The Redis
   switch, not the env one: checked before anything else on every request with
   no cache in front of it, so it lands on the next call and needs no redeploy.
2. **`dailyCap` restored**, default 400/day per token. A missing value resolves
   to the default, never to infinity — an un-capped token *is* the bug.
3. **Rate limit 120 → 20/minute.** A human-paced integration makes single-digit
   calls a minute; 20 allows a burst of catch-up reads and stops a loop in
   about three seconds.
4. **A budget gate in FRONT of auth**, returning a JSON-RPC error whose message
   opens with `STOP.` and states that retrying cannot succeed, plus
   `data.terminal`. `no-token` / `unknown-token` still fall through to the
   standard challenge — no reconnaissance for the unauthenticated, and MCP
   clients need the real `WWW-Authenticate` to negotiate.
   `authorize()` gained `charge: false` so the gate and `verifyToken` cannot
   both spend one request's allowance.
5. **`bridger_wait` counts consecutive empty waits**; past three it refuses with
   `STOP WAITING` and tells the agent to report rather than poll.
6. **`/api/health` reports both kill switches.** It checked only the env one, so
   during the incident — stopped via Redis — it answered `healthy: true,
   killSwitch: "off"`. A diagnostic is consulted precisely when something looks
   wrong; one that reports "nothing is wrong" then is worse than absent.

### The honest limit, stated so it is not rediscovered

**Bridger cannot cap another model's spend.** Those tokens burn in the caller's
loop, in their session, under their quota. All we can do is stop feeding it and
refuse in words an agent treats as final. If that agent loops on something else,
none of this helps.

### The miss worth recording

`triplemind/ARCHITECTURE.md` Problem 2 — *"`--yolo` Mode Is Dangerous… no
`--max-turns` equivalent limits how long it runs"* — describes this exact loop,
written in February 2026. **It was read this same session**, cited as evidence
that Bridger was structurally safer than TripleMind because it owns no agent
lifecycle. That reasoning was correct and incomplete: not owning the loop does
not mean not *feeding* it. The generalisation: **when you inherit a prior
project's failure list, check each entry against what you are building, not
against what you are replacing.**

---

## 2026-08-12 — S#271 — Token roles: viewer vs participant

**Source:** Erik — *"what does OpenWork offer which would just make sense to
have in our project?"* Their line is *"auth, roles, and policies applied on the
way through."* Taken because it closes a hole we opened the same afternoon, not
because a competitor has it.

**The hole.** The web view had no token of its own, so watching a bridge meant
pasting a **participant** token into a browser tab — and anyone seeing that
screen, or that tab's storage, could then post as that side. The UI made
authorship cheap to steal, and the UI is precisely the reason a token ends up
somewhere visible. Introduced by the same change that added the view.

**Decisions:**
1. `TokenRecord.role: "participant" | "viewer"`. A viewer authenticates and
   reads — it *should* read — so the gate is per-tool, not at the auth layer.
2. **One `writableBridgeFrom()`**, not a check copied into five handlers. The
   copies are what drift (S#268: one prompt-rule text in three copies silently
   degraded three different things).
3. `bridger_contract` splits by intent: reading it is a viewer's right,
   replacing it is not.
4. `bridger_status` reports `role` and `canWrite`, so an agent learns its limits
   up front rather than by being refused mid-task.
5. **`rotate` revokes participants only.** Rotating a leaked working token must
   not silently blind an unrelated watcher — that is a separate decision and it
   belongs to whoever makes it deliberately. `revoke` without a filter still
   kills everything on the side.
6. **A missing or corrupted `role` resolves to `participant`.** Only the exact
   string `"viewer"` restricts. Every token minted before roles existed keeps
   working; a missing field must never downgrade a partner mid-integration.

**Verified live, with the control:** viewer → `bridger_status` OK
(`canWrite: false`) and `bridger_ask` refused; participant → same status OK
(`canWrite: true`) and `bridger_ask` wrote `JMS-Q-001`. A refusal on its own
proves nothing; it means something next to an acceptance in the same breath.

**Not taken from OpenWork, and why:** 50+ LLM providers and BYO keys (we call no
model — that is the differentiator, not a gap); scheduled tasks, Dispatch,
browser automation (all execution — owning nothing about the agents is what
keeps identity and revocation clean); extension marketplace (a capability
platform is a different product); SSO (premature); "live artifacts"
(auto-refreshing dashboard — already built).

---

## 2026-08-12 — S#271 — Local mode: a bridge needs no database

**Source:** Erik — *"Is the upstash DB really crucial right now or can we do it
later? I want to try two different AI utilizing it... The use case here is also
local sessions that I have opened on my device only."*

**Decision: add `BRIDGER_STORE=file`, and treat local as a first-class mode.**

Requiring a hosted Redis to bridge two windows on the same laptop is
infrastructure for its own sake. The `Store` interface was already injectable
(it exists so the auth path could be tested at all), so a file-backed
implementation was ~180 lines and no change to any caller.

It also unblocked the thing STATUS listed as the single biggest open risk: *no
call had ever succeeded end to end*. With a file store, the full ask → answer →
close → pull round trip ran on a laptop with no account anywhere. **Deferring
Upstash did not defer the verification; it enabled it.**

- **Opt-in only, never a fallback.** Missing Upstash credentials still return
  `null` and still fail closed. A hosted deploy that quietly degraded to
  per-instance local files would look healthy while every serverless instance
  kept its own disappearing ledger.
- **Hard error on Vercel.** `BRIDGER_STORE=file` there throws rather than warns:
  serverless filesystems are ephemeral and per-instance, so a file store there
  is not a degraded bridge, it is a broken one.
- **No TTL locally.** Expiring someone's own record off their own disk would be
  a surprise, not a feature. Deleting the data directory is theirs to run.

**Second AI confirmed to work with no code change.** Gemini CLI takes `httpUrl`
plus arbitrary `headers` (including `Authorization: Bearer`) in `settings.json`
— its own docs example is `http://localhost:3000/mcp`. Same endpoint, same
token, different config file. This is the payoff of MCP being a standard rather
than a vendor protocol, and it means "two different AI on one bridge" needs
nothing built.

### Defect found by the control, and the lesson

Revoking a side from the CLI reported success and **did nothing** — the CLI is a
separate process, and the running server served the revoked token from an
in-memory snapshot taken at startup. The file store's own comment already said
"not safe across processes"; it was written as a concurrency caveat and the real
consequence was a security one.

Fixed with an mtime check before every read. **The generalisable part:** the
check that found this was the *control* — revoked must 401 **while an untouched
token 200s in the same breath**. Checking only that the revoked token was
refused would have passed on the broken build, because it was refused for
reasons unrelated to the revocation. A refusal only means something next to an
acceptance.

---

## 2026-08-11 — S#271 — Bridger, v1 architecture

**Source:** Erik, live in session. Named by Erik ("It's a bridge and we enable it
between people's AI. Bridger").

### The problem, measured

Six manual round-trips on the JudgeMySite ↔ Trigvanta integration, each one
Erik typing *"any questions for their Claude?"*, carrying a markdown file to
Discord, and carrying the reply back. The human is the transport layer.

### What exists already (checked before building)

Cross-account agent messaging is a crowded shelf: **AgentDM** (free, MCP,
explicit cross-account messaging), **Agent Relay** (open-source, DMs/channels),
MCP Talk, claude-peers, claude-ipc, mcp-chat. The messaging half is solved.

**Every one is a pipe.** AgentDM: *"Message content is never read, filtered, or
stored beyond delivery."* Agent Relay stores chat transcripts. None keep the
traced record of decisions and their evidence.

**Decision: adopt nothing, build the ledger.** The pipe is a commodity; a
sellable tool cannot rest on someone else's free early-access service anyway.

### Decisions

1. **No LLM anywhere in the product.** No `ANTHROPIC_API_KEY`, no model id, no
   AI SDK. Bridger is an MCP tool server; both sides' reasoning happens in
   sessions they already pay for. *Erik: "don't make API a requirement to use
   here as we want a cost efficient solution."* This is a hard constraint, not a
   v1 shortcut — anything that would add a model call needs a new decision here.

2. **No shared repo.** Erik corrected an earlier design that made git the
   substrate: *"we don't even have a shared repo... Two separate repos."* Each
   side keeps its own `bridger/` folder; the room replicates entries. A shared
   repo would have meant permissions, an owner, and an implied shared codebase —
   and would have destroyed the one-paste join that is the whole product.

3. **Append-only with derived status.** Nothing mutates. A question is
   "answered" because an answer entry references it, not because a flag flipped.
   Removes the only write two sides could race on, and makes the log replayable.

4. **Author-namespaced entry IDs** (`JMS-Q-014`, `TRI-A-007`), with the side
   proven by the token and the code taken from the room record. A caller cannot
   mint an ID in the other party's namespace. No merge, no conflict resolution.
   Codes are disambiguated at room creation so two partners with the same name
   cannot collide.

5. **`checkedAgainst` is the product.** A path/commit/URL that was actually read,
   or `null` meaning unchecked. Deliberately not a boolean: a boolean can be set
   true without evidence, which is the exact failure this exists to catch.
   **Anchor:** S#270 sent two partner letters with claims FALSE IN CODE (an
   Idempotency-Key described as released when it was consumed; a refund never
   wired). Trigvanta's own Claude caught one by asking. Labelling, not blocking —
   the failure was *unlabelled* claims, not unverified ones.

6. **Retention: 30-day idle TTL on the room** (Erik chose "buffer, then local is
   truth"). Redis cannot expire individual list members, so this is an idle TTL
   refreshed on every write — an active room keeps its whole history; a dead one
   is collected whole. **This is not per-entry expiry** and is written down
   because the difference is discoverable the hard way.

7. **Auth ported from `roastmydev/lib/external/key-registry.ts`**, not
   reinvented: sha256-only storage, fail-closed on an unreadable registry, a
   30-second cache that a revocation always outlives, an env kill switch, a
   capped audit log. Those properties were each learned from a real incident
   there; re-deriving them would have meant re-learning them.

8. **Two classes of CLI command.** Operator (`open`/`rotate`/`revoke`/`close`)
   talks to the registry and needs Upstash credentials. Partner
   (`join`/`pull`/`log`/`status`) needs only a room token — no account, no repo
   access, no credentials. Mirrors `extkeys.mjs`.

9. **`/api/health` exists because 401 is ambiguous.** `withMcpAuth` answers every
   rejection with the same fixed string, so "bad token" and "registry not
   configured" are indistinguishable from outside — fine for security, useless
   for operations. Health reports configuration state and nothing about any
   token, room or entry.

### Rejected

- **CLI-Anything** (`HKUDS/CLI-Anything`) — Erik surfaced it as a CLI aid.
  SKIP as a dependency: it generates Click wrappers around *existing* desktop
  software via a 7-phase LLM pipeline. Wrong shape (we are writing ~8 commands
  from scratch, not wrapping an app) and it would violate decision 1.
  **ABSORBED:** its agent-native contract — JSON as a first-class output,
  composable commands, and the CLI shipping its own skill definition.
- **Building on AgentDM as the transport** — free early-access, hosted, stores
  nothing. Fine for a prototype, wrong spine for something sellable.
- **A blocking `wait` as the primary mechanism** — kept, but bounded (45s max)
  and last in the build order. It is the only feature with a per-second compute
  cost, and it only works while both sessions are live.

### Known limits, stated before use

- **Neither side can wake a Claude that isn't running.** `bridger_wait` is
  real-time only while both sessions are live — Erik's stated operating
  criterion. Otherwise the ping is a mailbox read at the next `bridger_status`.
  A Discord webhook for the *human* notification is v1.1, not v1.
- **`readEntries` reads the whole buffered list and filters in memory.** Correct
  at two-party scale and capped at `MAX_ENTRIES`; past a few thousand entries per
  room it wants real pagination.
- **Vercel `maxDuration` for `wait` is unverified on this account.** Route
  declares 60s, the tool caps itself at 45s. If the plan's limit is lower it
  degrades to a short poll rather than breaking.
