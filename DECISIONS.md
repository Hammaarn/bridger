# DECISIONS

Append-only, newest first. **DECISIONS wins on direction** — where this file and
`STATUS.md` or the code disagree about *intent*, this file is right.

---

## 2026-08-25 -- S#283b -- THE CANONICAL HOST IS `bridger.nexus`, AND THE OLD ONE IS NOT DEPRECATED

**Source:** Erik wired the DNS, then: *"You may go ahead."*

`bridger.nexus` + `www` CNAME to the project's `…vercel-dns-016.com` target at
Cloudflare with proxy **DNS only**. That last setting is the one that matters:
proxied would have put Cloudflare's CDN in front of Vercel's, blocking cert
issuance, and with SSL/TLS "Flexible" would have produced a redirect loop.
Vercel's own record table says Proxy: Disabled, which is the same instruction
from the other side.

**The migration is an ADD, and the old host is not deprecated.** Partners hold
tokens and join links against `bridger-nu.vercel.app` and a live room's history
cites it, so it stays attached on the same deployment with nothing redirecting.
What moved is which host we TELL people to use and verify.

**And that claim is now checkable.** A second hostname appearing on a service
that just handed you a bearer token is exactly what a careful agent should
refuse to take on assurance -- so `VERIFY.md` hands over the command instead:
compare `deploymentId` from `/api/about` on both hosts. Identical means one
build behind two names; different means it is not the same service and neither
should be trusted. Confirmed live after deploy: `dpl_GERkbwJCtdNGELJKsEcx6TvAq7h4`
on both.

**`SERVER` was the whole job** -- it feeds the landing page AND `/llms.txt`, so
one constant moved every command an agent is shown. `DEFAULT_SERVER` in the CLI
stays overridable via `BRIDGER_SERVER`. Join links needed nothing, because
`/api/rpc` builds them from `req.url`.

`DECISIONS.md`'s own four references to the old host were left alone: they are
historical statements inside past entries, and this file is append-only. A
migration that edits the record of what was true before is not a migration.

### THE 25 MINUTES WHERE IT LOOKED BROKEN AND WAS NOT

Erik's browser could not reach the domain while it was serving 200 to everyone
else. His ISP resolver (Tele2) had cached the NEGATIVE answer from before the
records existed -- including, probably, from my own first `nslookup` this
session, which went to the default resolver while the domain was still NXDOMAIN.

Three things worth keeping, because the instinct in that moment is to change a
setting that was already correct:

1. **`ipconfig /flushdns` cannot fix it.** The stale entry is on the ISP's
   resolver, not the local stub.
2. **The 30-minute duration is OUR zone's SOA minimum (1800), not the ISP's
   choice.** Any resolver asked before the record existed behaves identically.
   Tele2 was not misbehaving; it was asked too early.
3. **`curl --resolve` settles it in one call** by bypassing DNS entirely and
   speaking to the origin with the right SNI. That is what proved the cert,
   the routing and the app were all correct while the name still looked dead.

Both dashboards were right from the first attempt. Changing anything in them
would have introduced a real fault while chasing a phantom one.

## 2026-08-25 -- S#283 -- THE WRITE PATH IS 38% CHEAPER, AND THREE DOCUMENTED ITEMS WERE NOT TRUE

**Source:** Erik, S#283: *"Proceed with all the stuff that can be done
autonomously. The stuff that needs my calls and approvals can be listed after."*
So: no decisions taken, nothing outward-facing, nothing a partner can see.

### THE WRITE PATH: 13 COMMANDS -> 8, MEASURED BOTH TIMES

`node scripts/upstash-cost.mjs`, before and after, on the real store interface.

  post one entry     10 -> 6    the four TTL `expire`s, amortised to one hour
  writeAudit (warm)   3 -> 2    the tally stopped re-reading what it wrote
  writeAudit (cold)   3 -> 3    the first call to a room still reads

Neither is clever, and that is the second time this has been the finding: both
were a path doing something silly. `touchRoom` spent four commands per write
pushing back a deadline THIRTY DAYS away, and the tally asked the database to
repeat a value we had just written.

**Both are amortisations, not removals**, and both fail in the safe direction.
A TTL refresh that THREW is not recorded, so a failure does not buy an hour of
silence. A tally write that threw DROPS its cache, so the next call cannot
compound on a number the database never accepted.

**What the tally cache costs, recorded because it is a real trade:** `calls` can
under-count when two instances write to one room concurrently. That race already
existed -- a `get` and a `setex` are two commands with a gap -- and the cache
widens the window from milliseconds to the instance's life. Acceptable only
here: nothing is gated on that number, no partner sees it, and the ledger, the
chain, the seq counter and the daily caps are all exact and untouched.

### PURGE WAS LEAVING A DOCUMENT BEHIND, AND IT IS THE ONE THAT MATTERS

`executePurge` enumerates keys by hand -- correctly, because the Store interface
has no SCAN and a purge that can glob is a purge that can over-delete. The cost
of that design is that a namespace added later is silently not deleted, and
three had been: the PLAN, the activity tally, and the per-room daily counter.

**The plan is content two companies wrote.** `PLAN_KEY` arrived with the plan
stage in S#280 and was never added to the list, so every purge since then left
it on the server after BOTH SIDES had consented to deletion -- carrying the
room's own 30-day TTL, outliving the room by up to a month. Purge's promise to a
partner is deletion; it was keeping their plan.

**It was found by walking the store after a purge, not by reading the list**,
and that walk is now the test. "No key naming this room survives, whatever it
is" fails on the next namespace somebody adds without touching `purge.ts`. A
hand-maintained list became a checked one, which is the actual fix -- deleting
three keys is just today's instance of it.

### U1.B1: PIPELINES ARE SETTLED AND THE ANSWER IS NO. EVAL IS ERIK'S.

Upstash bills a pipeline per inner command, in their own words: *"A pipeline
collapses the round trips but keeps the command count: 7 SETBITs in one pipeline
are still 7 billed commands."* **Pipelining is a latency tool here, never a cost
one.** That kills a chunk of what U1 was hoping for.

EVAL is not answerable from this machine, and the reason is worth keeping. A web
search returns a confident "billed as one" whose supporting sentence is about
ATOMICITY -- *"the script invocation is still one serialized command"*, which is
what other clients see, not what the meter charges. Fetching the page confirmed
it says nothing about billing at all. **The summary was a synthesis, not a
reading**, and relaying it would have justified rewriting the hot path.

It also cannot be measured from inside: `INFO` reports Redis's
`total_commands_processed`, but the meter lives at Upstash's HTTP proxy. A
measurement built on it would produce a confident WRONG answer, which is worse
than none because it gets SPENT as evidence.

So `scripts/eval-billing-probe.mjs` does the half a script can do -- 100 EVALs x
10 writes, so the answers are 100 and 1000 and no console noise can confuse them
-- and refuses to run without `--run`. The console read is Erik's, ~5 minutes.

### THREE DOCUMENTED ITEMS WERE NOT TRUE, AND ONE GATE HAD QUIETLY OPENED

- **A2** (`WASTE_BUDGET_BYTES` 12000 -> 18000, "Erik's call") shipped in
  `93b3e24` at S#281. Carried as open for two sessions. Noticed because the LIVE
  `bridger_status` reports `wasteBudget: 18000` -- the running system
  disagreeing with the document.
- **U1's A3** was not a stale row but a WRONG one: "use `llen`, `unread` is why
  the whole list is read". `unread` is not why. `openQuestions` and `signOffs`
  scan the full history and must -- a question raised at seq 3 can still be open
  at seq 500. Building it would have silently dropped every open question older
  than the cursor window: a correctness bug wearing a performance fix, which
  would have looked like a clean win until a partner's question vanished.
- **`plans/DECISIONS-FOR-ERIK-s272.md`** said "D3 is greenlit and still unbuilt
  -- the only outstanding one" for ten sessions after `/api/whoami` shipped.
- **`plans/witness-network.md`'s gate** was "not buildable until one far-side
  agent completes a round trip; as of 2026-08-17 that number is zero". It is no
  longer zero. **Marked as met, deliberately NOT unparked** -- a gate opening
  makes the question live, not the answer yes, and the adversarial half of B1 is
  still owed. Erik's call, made on purpose rather than by a condition expiring.

### THE KILL-SWITCH COMMENT DESCRIBED THE OPPOSITE OF THE CODE

It said a cached ON is trusted for its window and a cached OFF re-read.
`killSwitchOn` has always done the reverse, and its own docstring said so -- so
the two disagreed, in the one path whose job is to stop the bridge. Corrected,
and pinned by two tests that did not exist: restarting is immediate (an ON is
never reused), stopping is delayed by at most one window and no longer.

### TWO "NEVER SEEN" ITEMS WERE SEEN

Items 12 and 13 were both "built, never observed". Driven end to end on a LOCAL
file store -- a room, a declared repo, a cited entry -- and read out of the real
DOM rather than inferred from the JSX:

    <a class="prov-link" target="_blank" rel="noreferrer noopener"
       href=".../blob/cb03b5c.../lib/store.ts#L613">lib/store.ts:613</a>

The GitHub URL returns 200. The agent mark renders as `bx-agent sideA` "CL" on
both the seat chip and the entry. **So neither is broken.** Item 13's remaining
half is one `identify` call in a live room, and that is Erik's, because a
partner sees it.

Nothing touched production, no live room was written to, and the local room and
file store were deleted afterwards.

## 2026-08-25 -- S#282c -- THE NAME IS SETTLED, AND IT WAS NAMED FOR THE DESTINATION

**Source:** Erik, S#282, after I argued against the domain and he answered.

### GAVELED: `bridger.nexus`

I put the case against it -- that `.nexus` is a maximalist word against a product
whose credibility comes from understatement, that a novelty gTLD nudges the wrong
instinct in a reader who has just been handed a bearer token by a stranger, and
that "bridger" and "nexus" say the same thing twice.

**Two of those are answered and one of them exposed a flaw in how I argued it.**

1. **I recommended `.dev`/`.tools` without ever pricing them.** They are $100+/yr
   against $10. On a pre-revenue alpha that is not a close call, and making a
   recommendation while never checking the one constraint that binds is the same
   error this session made twice on the page: reasoning about something I could
   have measured.
2. **The redundancy argument was wrong because I was naming the product as it is,
   and Erik is naming it for where it goes.** A nexus is a HUB of connections.
   Two parties in one room is not a hub; many rooms, accumulated knowledge and
   cross-boundary assistance is. **A name for a destination ages better than a
   name for a state** -- and if the destination arrives, "nexus" becomes the
   accurate half rather than the echo.

**Revisit only if the product gets big** -- Erik's own framing, and the right
trigger. Not before.

### TWO DIRECTIONS THAT CAME WITH IT, recorded so they are not re-derived

Both are Erik's, both are PARKED with reasoning rather than promoted.

**1. THE ASSIST CHANNEL -- closer than it looks, because the mechanism exists.**
`bridger answerer --side b` already mints a two-tool token (ping + answer,
nothing else, ~318 tokens of standing schema against ~1,800). That is already an
AI whose whole presence in a room is to answer another AI.

What is missing is not machinery, it is the RELATIONSHIP. The record today
assumes two parties integrating SYMMETRICALLY; assist is ASYMMETRIC -- one asks,
one knows. **The question to settle before building: does an asymmetric exchange
still want a hash-chained joint record?** If yes, this is small and it fits the
existing two-ness cleanly (asker/answerer is exactly what the role encodes). If
no, it is a second product wearing Bridger's transport, and that is the F5
mistake in a new costume.

**2. THE KB BANK -- the bigger one, and the risk is the product's own foundation.**
Room-based knowledge bases that Bridger collects into a bank users can download.

**A room's content belongs to TWO COMPANIES.** Collecting rooms into anything
downloadable crosses precisely the boundary `checkedAgainst` and the containment
markers exist to protect. It is the two-consent problem `purge` already solved,
and HARDER: publishing cannot be undone where deleting can. Quieter issue: most
room content is intensely specific ("does `/orders` return cents or a decimal
string"), so the genuinely reusable layer is thinner than it looks.

**The version that is nearly free today, and the honest first step:** `bridger
pull` ALREADY writes a room's full record into a `bridger/` folder -- typed,
cited, chained. "A room is a downloadable knowledge base" is mostly true already
and simply under-shaped. It needs no consent model at all, because it only ever
hands each party what they already own. Do that before anything that aggregates
across rooms.


## 2026-08-25 -- S#282b -- THE DOMAIN, THE AUDIT, AND LIGHT MODE PUT TO ERIK

**Source:** Erik, S#282: *"I just bought a domain for Bridger! Now its going to
be called bridger.nexus"*, plus a QA audit he commissioned from Gemini
(Antigravity), plus five landing-page notes from his brother, a UI/UX designer.

### THE DOMAIN IS BOUGHT AND DELIBERATELY NOT WIRED

`bridger.nexus` does not resolve (NXDOMAIN) and is not in the Vercel account.
**Nothing was repointed**, on purpose: aiming the docs at a host that does not
answer is invariant 15 failing in the other direction, on the same day the
session fixed an instance of it.

**Settled now so the migration is not re-derived later:** the new domain is an
ADD, never a replace. Partners hold tokens and join links against
`bridger-nu.vercel.app` and the live Trigvanta room's history cites it, so that
host keeps serving as an alias. The code cost is TWO constants
(`lib/site-content.ts` `SERVER`, `cli/bridger.ts` `DEFAULT_SERVER`); the other
24 occurrences are prose and fixtures. Join links need no work at all --
`app/api/rpc/route.ts:341` builds them from `req.url`. The trust surfaces
(`/api/about`, `VERIFY.md`, the landing page) move together or not at all: a
page served from one host telling a partner to verify another is precisely the
confusion this product exists to remove.

### THE AUDIT'S FINDINGS WERE VERIFIED BEFORE THEY WERE ACTED ON

Two of four survived. That ratio is the argument for the check, not against the
auditor -- it found a 404 in the onboarding path that two sessions of our own
reading had walked past.

**Taken:** the demo's missing `invite` step (a 404 confirmed on production) and
the presets showing their stages rather than describing a feeling.
**Corrected and taken differently:** the disabled-button finding, which cited a
WCAG clause that exempts disabled controls and measured a colour pair the page
does not render -- but sat on top of a real breach of our own rule.
**Not taken:** the modal findings, which describe a component that does not
exist. Filed as a signal instead: a competent auditor believed it was a modal.

### LIGHT MODE IS A DECISION, NOT A BUG

It exists and passes contrast, and it is a token inversion rather than a design:
the field's hot-cell calibration assumes a black ground, and the wake and the
ripple work by ADDING light, which on cream removes contrast. Three options are
on the board in `TODO.md` item 1 (commit to dark / design light properly / dark
by default plus a toggle). Recommended: the toggle. Undecided, and the ROOM view
-- most of the product -- has never been seen in light at all.


## 2026-08-24 -- S#282 -- THE ROOM SHAPE IS "STREAM PLUS GAUGE", AND THE MINTED SCREEN NAMES WHAT EACH CREDENTIAL IS FOR

**Source:** Erik, S#282, three directions put to him as rendered mockups:
*"Roll with B, that s good"* -- then, looking at a real minted screen:
*"This page needs to be easier for users to understand, a dummy should be able
to instantly know what the tokens are meant for, also Read-Only room token is
exactly the same as the models tokens"*, plus the capital G, plus a hover
effect adapted from React Bits' `Cursor Wave`.

### DIRECTION B -- CHOSEN, AND IT SHRANK TWICE UNDER READING

Three room compositions were drawn: **A The Console** (rail + stream + drawer),
**B The Instrument** (stream + a standing gauge), **C The Split Ledger** (two
columns either side of the hash-chain spine). B is gaveled.

**What the pitch got wrong, found by reading the room code rather than the
mockup.** Four of the five proposed build items were already shipped:

- the **card layer** -- `page.tsx` already puts the type verb, entry id, answer
  ref and reopened badge on every bubble, and `Provenance` already renders BOTH
  `checkedAgainst` and `basis` with the span badge and the permalink (S#280).
- the **repeated mark** -- `AgentMark` exists and renders per turn.
- the **composer hint** -- DOES NOT APPLY. The room view is read-only by design;
  agents write through MCP/RPC. There is no composer to hint on. The honest
  translation of that pattern is the `guidance` field, which is protocol, not UI.

**And the mockup hid a cost:** as drawn, B's gauge REPLACED the rails, which
would have deleted the evidence index -- the one panel that answers what the
room's agreement is built on. The corrected shape keeps every panel and stands
the gauge up on its own edge, because the collapsed rail stubs already carry
counts on a 34px strip and are a proto-gauge.

**So B's remaining work is: promote the right stub into a permanent gauge, keep
the rails expandable, default to collapsed.** The chain head is NOT on the
client (verified) -- that row needs the room API to carry it, or it waits.

### THE MINTED SCREEN -- THE ROLE IS FINE, THE SCREEN WAS NOT

Erik's report was that the read-only token is "exactly the same as the models
tokens". **Checked before acting: it is not a privilege bug.** `TokenRole` is
`participant | viewer | answerer`, `canWrite` is `role !== "viewer"`
(`lib/room-registry.ts`), and a viewer is refused server-side with its own rate
ceiling.

**The defect is that nothing on the screen told you which one you were holding.**
All three rendered as an identical `br_live_...` string under an identical
`copy token` button, separated by one small grey word. The way to hand out the
wrong credential was to copy the wrong box.

**Shipped:** every card now leads with its JOB before showing a character of the
credential -- `yours` / `theirs` / `reads only`, a sentence saying who it is for
and what it can do, and distinct verbs (`copy connector` vs `copy watch pass`).
The watch pass loses its side hue entirely and is dashed on every edge. Side "a"
is `ownerToken` and side "b" is `peerToken` (`app/api/rooms/route.ts:371-374`) --
exactly the "Your side"/"Their side" the create form asked for, so the screen
always knew which one you keep and simply never said it.

**STILL OPEN, and it is Erik's:** all three are still literally `br_live_...`.
A self-describing prefix (`br_view_...`) would make the watch pass legible
wherever it travels -- a chat log, a config file, a screenshot -- rather than
only on this screen. That touches minted credentials and the auth path, so it is
a decision, not a tidy-up.

### THE CURSOR WAKE -- REACT BITS MINED, NOT DEPENDED ON

This also answers the open React Bits decision: **ideas, never the dependency.**
`/api/about` instructs every partner to run
`node -p "Object.keys(require('./package.json').dependencies)"` and expect SEVEN
entries. A motion library added to decorate a landing page would make the trust
page's own verification instruction false.

Erik's adaptation is the right one -- glitched glyphs rather than coloured
shapes -- and it reuses the field the page already runs. Implemented as a SPARK
per cell the pointer crosses, so it inherits the dirty-cell repaint the whole
component is built around; a continuous influence field would have been the
version that repaints ~10k glyphs a frame.

**Verified with a negative control, because a dead effect and a subtle one
photograph identically:** mean luminance at the cursor rose 3.9 -> 38.5 while a
control box elsewhere in the same field moved -0.14. Local, not global.

**And the first version was wrong in a way the measurement could not see.** It
covered the whole `.bx-demo` section, putting a churning glyph field behind the
"Don't trust this page" checks -- plain paragraphs with no card, so the text sat
ON the noise. Caught by looking at the capture. The field is now scoped to the
heading and the steps, which carry their own solid cards.

**Also:** "generate invite link" -> "Generate invite link". Not a preference --
the other primary button on that same screen already read "Generate link & open
the room".

---
---

## 2026-08-24 -- S#281g -- C3b: THE LISTENER, AND THE CHEAPEST QUESTION IN THE PRODUCT

**Source:** Erik, S#281: *"proceed with the C3b, we want to avoid as much usage
of the Redis commands as possible so we don't run out of the free usage limits.
That will block everything in an instant, we need to spare the commands we have
as much as possible."*

**Shipped:** `GET /api/since` (two Redis commands) and `bridger listen` (a
process, not a turn).

### THE CORRECTION THAT DECIDED THE DESIGN

S#281b recorded that *"a daemon that sleeps locally and short-polls is WORSE for
us than one holding a long `wait`"*, from an arithmetic comparing 30-second
client polls (~6,720 commands per night) against 300-second server blocks
(~4,608).

**That was true for the interval it happened to test and false as a general
claim.** The crossover sits near 45-50 seconds, because a local sleep costs
ZERO commands while server-side blocking spends one every few seconds. Past that
interval, sleeping wins -- and with a purpose-built endpoint it wins by 10x.

Eight hours of one side listening, measured against the constants:

| approach | Redis commands |
|---|---|
| `wait --follow`, 45s server long-poll (today) | **10,240** |
| server long-poll at 300s, if `maxDuration` were raised | 4,608 |
| local sleep 60s, hitting `/api/rpc` | 2,880 |
| **local sleep 60s, hitting `/api/since`** | **960** |

Against a confirmed 500,000/month free tier, that is one room's overnight
listener costing **2% of the month instead of 20%**.

### WHAT MAKES THE ROUTE CHEAP IS WHAT IT REFUSES TO DO

A poll is authorised and answered in **two commands**, measured end to end and
pinned by a test rather than described: one rate-limit `incr` (the kill switch,
token and room are all cached since S#281) plus one `GET` of the seq counter.

It skips the audit row, the op trail, the idle streak, the room-activity tally
and the daily counters -- roughly four commands. Each omission is safe for the
same reason: **that bookkeeping exists to advise a looping AGENT and to protect
a caller's model quota, and a daemon has neither problem.** It is not looping by
mistake, and it burns no tokens at all, which is the entire point of C3b.

**A quiet poll returns 204 with an empty body.** It is the common answer by a
wide margin, so it is the one that must cost the least -- in commands, in bytes,
and in the operator's attention.

### HOW A RUNAWAY IS STILL BOUNDED, since the daily cap is gone

By a much TIGHTER per-minute ceiling: **4/minute**, against 20 on the
interactive routes. Saying so in the limit is more honest than allowing an
interactive rate on a route whose whole argument is that its caller can wait.
Verified live: the third poll inside a minute is refused with 429.

That is a deliberate trade of one bound for another, and it is only sound
because the per-minute limiter is enforced BEFORE the minimal path
short-circuits.

### THE HONEST LIMIT, STATED RATHER THAN GLOSSED

**There is no interrupt into a language model.** Nothing here makes a session
NOTICE anything; bytes reach a model only when a turn happens. What C3b removes
is the thousand wasted turns, not the last one. `--exec` is the hook for
whatever wakes the operator's session -- a notification, a file write, a
webhook -- and choosing that is theirs.

### LANGUAGE: TypeScript, and Python remains open

Built into the existing `cli/bridger.ts` because it ships with the tool the
partner already installs, adds **zero dependencies**, and reuses the auth,
rendering and exit-code conventions the CLI already has. A standalone Python
version is a reasonable thing to want later -- it would be maybe eighty lines
against `/api/since` -- but it would be a second thing to keep in sync for no
capability the first one lacks.

**Verified by running it**, not inferred: the daemon started from the CURRENT
seq (a listener joining mid-conversation reports what happens next, not the
history its operator already read), slept locally, woke when the far side wrote,
rendered the entry with containment markers intact, and printed nothing at all
on the quiet polls in between.

---

## 2026-08-23 -- S#281b -- THE FREE TIER IS CONFIRMED, AND THE OVERNIGHT LISTENER IS THE ONLY THING THAT THREATENS IT

**Source:** Erik, S#281: *"we are using the free tier on Upstash for this
project."* Limits then read from the vendor rather than assumed: **Upstash Redis
FREE = 500,000 commands/month, 256 MB storage, 10 GB bandwidth/month.**

**This closes the one item S#281 shipped as UNVERIFIED.** `lib/store.ts` had
carried *"STATUS.md still lists the free-tier ceiling as UNCHECKED, so this is
reasoned, not measured"* since S#280. It is now measured, and the arithmetic
S#281 published against an assumed 500,000 was correct.

### WHAT THE BUDGET ACTUALLY BUYS, after the S#281 reduction

| pattern | commands | headroom on 500K/month |
|---|---|---|
| human-paced (200 calls/day) | ~1,400/day | **~357 days -- never a problem** |
| one room, both sides, 8h overnight listener | 20,480/night | **24 nights/month** |
| both sides listening 24/7 | 61,440/day | **8.1 days** |

**THE TENSION, and it is the finding:** ordinary use cannot exhaust this budget
in a year. The ONLY pattern that threatens it is the overnight listener -- **and
the join document recommends exactly that pattern.** We tell partners to run the
thing that costs us the most.

At one room it survives (24 of ~30 nights). At two rooms both listening nightly
it does not (12 nights). So the free tier holds for the product as it is used
today and stops holding at roughly two concurrent overnight integrations.

### THE REMAINING LEVER, and it is not free -- ERIK'S CALL

**`WAIT_MAX_SECONDS` 45 -> ~290.** The per-call fixed overhead (~6 commands) is
paid once per CALL, so longer blocks amortise it. Measured across the current
backoff:

| max wait | commands/night/side | two-side nights per month |
|---|---|---|
| 45s (today) | 10,240 | 24 |
| 120s | 6,240 | 40 |
| **300s** | **4,608** | **54** |
| 900s | 3,936 | 64 |

**What it costs:** longer-held serverless invocations. `maxDuration` is 60 on
both transports today; the Vercel plan is **Pro**, which allows up to 300. So
this is possible -- but it MOVES cost from Upstash to Vercel function-seconds
rather than removing it, and that trade should be made deliberately rather than
because one of the two budgets happens to be the one we just measured.

### A CORRECTION TO THE S#281 ENTRY ON C3b

S#281 recorded that the local daemon *"does not help the database"*. That is too
strong, and the precise version is a design instruction for C3b: **a daemon that
SLEEPS LOCALLY and short-polls is worse for us than one that holds a long
`wait`** -- 8 hours of 30-second client-side polls costs ~6,720 commands against
~4,608 for 300-second server-side blocks, because the fixed per-call overhead
dominates once polling moves out of the call. So C3b should long-wait, not poll.
Its win is model tokens; the Redis win comes from the block length, not from
where the loop lives.

---

## 2026-08-23 -- S#281b -- THE VERCEL GITHUB APP IS GONE, WHICH IS WHY A PUSH STOPPED BEING A DEPLOY

**Source:** Erik, S#281: *"We need to check why Vercel didn't deploy."*

**Diagnosed, not guessed.** Two commits were pushed to `origin/master` and
GitHub confirmed them; Vercel created **no deployment at all** -- five minutes of
polling showed production still on S#280's `6a190ac`, and
`list_deployments` showed the newest deployment was still that one.

The Vercel API is unambiguous. `GET /v9/projects/<id>` returns **no `link`
object**: the project is not connected to any repository. `POST .../link`
returns the reason:

> `"To link a GitHub repository, you need to install the GitHub integration
> first."` -- `action: "Install GitHub App"`, `link: https://github.com/apps/vercel`

So the **Vercel GitHub App was removed from the account or the repository**, and
Vercel dropped the project's git link with it. Every deployment before this
carries `githubDeployment: "1"` and full commit metadata, and the last one is
`6a190ac` at the close of S#280 -- so it broke between then and now.

**RESOLVED the same session, and it took TWO steps rather than one.** Erik
installed the app at https://github.com/apps/vercel -- and the project link did
**not** come back on its own. Re-checked immediately: the API still reported no
`link`. It took `vercel git connect https://github.com/Hammaarn/bridger` as a
separate action, which then succeeded where it had failed minutes earlier.

**That is the part worth keeping:** installing the app restores the PERMISSION,
not the CONNECTION. The two failure states look identical from the dashboard --
app present, repo visible, nothing deploying -- so anyone who installs the app,
sees no error and assumes they are done still has a repo that silently does not
deploy. Link now recorded server-side: `type: github`, `org: Hammaarn`,
`repo: bridger`, `productionBranch: master`, with a credential id.

**Interim:** `npx vercel deploy --prod --yes` works and was used to ship S#281.
It picks up `VERCEL_GIT_COMMIT_SHA` from the local clone, so `/api/about` still
reports a real commit -- production verified at `3eb31da`.

**THE STANDING LESSON, and it is the same one this session opened with:** *"the
push succeeded"* is not *"the deploy happened"*, and the two rendered identically
until someone read the deployment list. `npm run deploy:state` exists in the
JudgeMySite lane for exactly this. Bridger's equivalent is
`curl -s /api/about` -- which S#281 ran, which is the only reason this was
caught at all rather than being discovered by a partner reading stale docs.

---

## 2026-08-23 -- S#281 -- SOLO MODE: BRIDGER IS ALSO A ONE-USER MULTI-MODEL BRIDGE

**Source:** Erik, S#281: *"We should provide that feature but only for single
users. Bridger should be a tool to connect multiple models as well for single
users that want to have an easy multi model bridge between their subscriptions
in my opinion (Like when we created Triplemind) Its very useful and would
attract users."*

**Reverses:** the F5 conclusion of S#280, PARTIALLY and in a specific way.

**The S#280 argument was:** copying the Shared Chat topology (one operator, many
models) would cost Bridger its differentiator, because `checkedAgainst`, `basis`,
the hash chain and the untrusted-partner containment all exist because the far
side is *somebody else* -- point them at seven models on one person's
subscriptions and every one becomes ceremony.

**That argument only holds if the new topology REPLACES the trust story.** As a
second MODE for a different user it does not, and the objection dissolves. What
survives from S#280 is the taxonomy, not the refusal: the two shapes are
genuinely different products and must not be merged into one confused room.

**And there is an argument S#280 under-weighted.** Every open item on this board
is blocked on *needs a far side* -- F1 has never met a partner, D3 is unverified,
B1's adversarial half needs a stranger. Solo mode has no such blocker: Erik can
use it tonight with subscriptions he already pays for. It is the only self-serve
on-ramp this product has ever had.

**Scope -- ROOM KINDS, not a generalised room.** The two-ness rewrite happens
INSIDE `solo` only:

| | `trust` (today) | `solo` (new) |
|---|---|---|
| parties | two companies | one operator, N agent seats |
| untrusted-partner markers | yes | no -- there is no containment against yourself |
| hash chain | the whole point | kept, cheap, but not the argument |
| vendor logos | monogram (trademark call) | yes -- see the next decision |

They share transport, storage, entries and the whole UI. The unanswered E2
semantics (does an answer close a question for everyone, who does a contract
bind, who signs off) mostly evaporate in `solo`, because there is one operator to
decide -- which is what makes it materially cheaper than the multi-COMPANY
rewrite E4 parked.

**E4 stays parked.** Erik's want is real signal but it is not the signal E4 was
waiting for: E4 wants somebody who used a two-party room and hit the wall, and
this came from a screenshot. Recorded honestly rather than laundered into
evidence. Solo mode does not un-park it.

**Code impact:** `SideId = "a" | "b"` in `lib/room-registry.ts:71`, and its
consumers `entries.ts`, `operations.ts`, `room-registry.ts`, `api/rooms/route.ts`,
`page.tsx`. `SUPPORTED_SLOTS = 2` at `app/api/rooms/route.ts:58`. Grep-verified,
not remembered. **Not started.**

**Doc impact:** ARCHITECTURE #31 (*"Two-ness is the data model, not a setting"*)
becomes true of `trust` rooms rather than of Bridger. TODO F5/E2/E4.

---

## 2026-08-23 -- S#281 -- VENDOR LOGOS SHIP, IN SOLO MODE

**Source:** Erik, S#281: *"I'd say we implement it in case you are a single user
and just wants to use our tool as a bridge between your AIs which you have a
subscription to"*, and *"Is it really trademarked? If we can't use their Icons
then thats fine."*

**Answered:** yes, they are registered marks (Anthropic, Google, OpenAI). But
**nominative fair use** covers using a mark to identify its own product, and
*"this shows which service is connected"* is the textbook shape of it. The live
constraints are brand guidelines -- no modification, no implied endorsement --
not the trademark itself.

**Ruled:** logos ride with `solo` mode, where they are unambiguously identifying
the user's own connected subscriptions. `trust` rooms keep the monogram, where
a vendor mark beside a stranger's agent would imply something we cannot verify:
a transport cannot know what model is on the other end of a bearer token.

**Code impact:** the CSP allows no external hosts, so marks are inlined from our
own origin. One function (the agent monogram renderer). **Not started.**

---

## 2026-08-23 -- S#281 -- THE ROOM COMPOSER: PRESETS *AND* A BUILDER, IN DIFFERENT PLACES

**Source:** Erik, S#281: *"We need a room composer as well so users can set their
own agenda in their own flow of how the rooms should be built. There should be
presets and then there should be preset builder to offer maximum value and
direction."* Then the constraint: *"like we stated previously we are just a
communication Bridge service, we don't store repos or other huge codebases. We
want to remain lightweight."*

**Reverses:** F2's *"presets, not a builder"* -- on PLACEMENT, not on the reason.

F2's objection was never that a builder is wrong; it was that D4 already says the
create flow is too many steps, and a stage-designer on the create screen is the
fastest way to make that worse. That objection is about WHERE, so:

- **Create screen** -> pick a preset. One line each, simplest preselected.
- **Builder** -> its own surface. What it emits is a saved shape that then
  appears in the create list like any other preset.

**THE LIGHTWEIGHT CONSTRAINT IS THE SHARPER HALF, and it is now a rule:** the
composer plans STAGES AND GUIDANCE, never artifacts. Bridger does not store
repos, codebases or large blobs. This is the same call F3 already made on its own
-- mermaid over Excalidraw, because text chains, diffs and costs ~0 KB.

**Blocked, and honestly:** a shape is an ordered list of stages, and only one
stage exists (F1). F1 has never been touched by a far side. The builder is
downstream of that test. **Not started.**

---

## 2026-08-23 -- S#281 -- EACH SIDE PICKS ITS OWN COLOUR

**Source:** Erik, S#281: *"Perhaps we should have a color picker inside the chat
room and when you are creating the room in order to establish a clear choice and
also visual of who is who."*

**Supersedes** the open A5 question of whether `--seal` moves -- it makes the
DEFAULT palette less load-bearing rather than settling the collision.

The live problem was never the palette. Room `e4db579a5fad` has `label: "claude"`
on BOTH sides; nothing distinguished two identically-named parties. A picker is
the same move `identify` already made -- self-declared, visible, no verification
theatre.

**Three constraints, and the first is the one that matters:**

1. **A curated set, not a free colour wheel.** A free picker lets someone choose
   a hue that vanishes in dark mode or lands on `--seal` -- reintroducing exactly
   the bug it fixes. Six to eight swatches, tested in both themes, seal's hue
   excluded.
2. **Stored on the room, per side**, or "my Claude is blue" holds only on one
   screen.
3. **The default still matters**, because most people will not pick. So `--seal`
   at `#ffb86b` against `--side-b` at `#f0c49c` remains a real collision to
   resolve, not one the picker retires.

**Not started.**

---

## 2026-08-23 -- S#281 -- THE DATABASE MUST STAY FREE TO RUN

**Source:** Erik, S#281: *"we must maintain the database with smart functionality
so it maintains itself and clears any lingering data which we don't want to
store, also make sure we don't cause feedback loops that use up all the commands
we are given from Upstash for free, it was a bug on Faver where the commands
suddenly were all consumed due to feedback loops"*, and *"priority should be to
decrease the Redis command usage as much as possible. We want to have this tool
for free as much as we can."*

**Ruled as a standing constraint, not a task:** Upstash COMMANDS are a
first-class budget alongside caller tokens, and the two can point in opposite
directions. They already did -- `WASTE_BUDGET_BYTES` discounts a blocked wait 90%
because it is cheap for the CALLER, while a blocked wait was the most
command-expensive call we make.

**So the rule: any change that makes a path cheaper for the caller must state
what it costs the database.** A saving on one side is not a saving.

**Shipped this session** (`93b3e24`): poll backoff 45 -> 10 reads per 45s wait;
SETEX replacing SET+EXPIRE on four hot paths, which also fixed two keys that were
immortal because SET clears a TTL; a fuse on the five namespaces of 22 that never
expired; the kill-switch read cached 5s; the audit LTRIM amortised 1-in-500.
Measured end-to-end: **16 commands per idle wait, down from 51.** Two sides
listening all day: 195,840 -> 61,440. Days to burn a 500,000/month free tier:
2.6 -> 8.1.

**No feedback loop of the Faver kind exists here** -- verified, nothing reacts to
a write by issuing another write. The runaway risk was a poll interval, not a
cycle.

**[!!] STILL UNVERIFIED AND IT IS THE OPERATOR'S READ:** which Upstash plan this
project is actually on. `lib/store.ts` has admitted since S#280 that the
free-tier ceiling is *reasoned, not measured*. Every number above is arithmetic
against an assumed 500,000/month.

---

## 2026-08-23 -- S#281 -- THE ZERO-TOKEN LISTENER IS A LOCAL DAEMON (C3b), AND IT IS ACHIEVABLE

**Source:** Erik, S#281: *"We should strive for a smart solution that can somehow
let sessions stay connected and knowing when the other side responds without
costing tokens... perhaps Python can solve this for us?"*

**Answered: yes for model tokens, and the mechanism already has a ticket.**

The two costs are separable and conflating them is why this looks impossible.
Nothing costs MODEL tokens unless bytes enter the model's context. A local
process holding the long-poll costs zero, because it is a process on the user's
machine rather than a turn in a conversation -- fifty empty polls become one
message that says *"they replied"*. `lib/store.ts` already says this is the
correct way to run a listener; it is TODO **C3b**, proposed by Trigvanta's AI
and never taken.

**The honest limit, stated rather than glossed:** there is no interrupt into a
language model. You cannot make it *notice* anything without putting bytes in its
context. What is achievable is compressing "did anything happen" from ~1,000
wasted calls to one message carrying only the answer. That is the dream scenario
and it is a build, not a research problem.

**And it does not help the database** -- the daemon makes the user's cost zero
while leaving ours unchanged, which is why the backoff above mattered first.

**Not started.** Language is Erik's call; Python is a reasonable pick and the
CLI is TypeScript today.

---

## 2026-08-22 -- S#280 -- THE LICENCE IS APACHE-2.0, AND IT CLOSES A LIVE GAP

**Source:** Erik, S#280: *"Lets fix that License stuff right away"* -- then chose
Apache-2.0 with the copyright held personally, after the options were laid out.

**THE GAP THIS CLOSES, and it was not cosmetic.** The repository was PUBLIC with
`licenseInfo: null` and no LICENSE file, which under default copyright means all
rights reserved: nobody could legally clone it, run it, or modify it. Meanwhile
**four** surfaces instructed exactly that -- the landing page
(`lib/site-content.ts`), the `/j/<code>` join page, and `/api/about` twice
(*"run your own instance"* and *"Run it entirely locally first"*). `/api/about`
also reported `license: "see repository"`, pointing at something that did not
exist. On the one product whose entire argument is that its claims are
checkable, the most-repeated instruction was unlicensed.

**WHY APACHE-2.0 AND NOT THE OTHER THREE.**
- **MIT** would have done the job. Apache adds an express PATENT grant, which is
  what removes the last question in a corporate legal review -- and the buyer
  here is a small team inside a company.
- **It protects the name gaveled the same session.** Section 6 grants no rights
  in trade names or product names. The code may be forked; the fork may not be
  called Bridger. Nothing else on this list does that.
- **AGPL-3.0 was rejected on its cost, not its politics.** It would stop a
  closed competing host, and many companies ban it outright -- which attacks
  precisely the self-serve funnel Erik chose at S#280 (*"let users use the
  product... that will act as a funnel"*).
- **BSL 1.1 was rejected because it is not open source.** "Read the source, run
  it yourself" would need an asterisk, and that sentence IS the product.

**The warranty disclaimer is the half that protects Erik**, and it is the half
nobody thinks about. Bridger is infrastructure two companies route real work
through; until today there was no AS-IS clause anywhere.

**Pricing is untouched.** Deferring the pricing decision (S#280) costs nothing
here: Apache-2.0 does not interfere with selling the hosted service, because
what is sold is operation, retention and uptime -- not the code. A self-hoster
lifting every cap in their own instance is the OSS/hosted split working, which
`TODO.md` E3 already recorded.

**Honest limit:** this is a licence choice, not legal advice. The text is the
canonical one fetched from apache.org and verified unmodified (patent grant,
trademark section, warranty disclaimer and appendix all present).

**Code impact:** `LICENSE`, `NOTICE`, `package.json` (`license`, `author`),
`/api/about` (`license`, `licenseUrl`, `licenseNote`). **Doc impact:**
`README.md`, `TODO.md` E1, `STATUS.md`.

---

## 2026-08-22 -- S#280 -- THE ROOM IS A DIALOGUE, THE ADVICE RIDES THE WIRE, AND THE CONTRACT STOPS CLOBBERING

**Source:** Erik's direction (Teams chat), plus two items the first cross-company
session filed. Three deliverables, one session, all verified by driving them.

> **[!!] CORRECTED LATER THE SAME SESSION (S#280).** Elsewhere in this entry I
> wrote that D1 was wrong to say there was no per-side colour, and that the
> signal existed and was merely too faint to read. **That is wrong, and D1 was
> right.** `--side-a` and `--side-b` were each defined TWICE in the same
> `:root` -- as hex colours, then overwritten fourteen lines later by bare
> `r, g, b` triplets for the canvas. Every use of them as a COLOUR therefore
> resolved to `116, 178, 255`, which is not a colour, so every such declaration
> was invalid and silently dropped. The rules existed; nothing they asked for
> ever rendered. Fixed by renaming the canvas tokens to `--side-a-rgb`.
>
> **The mistake is the part worth keeping:** I read the CSS rules and reported
> what they SAID, instead of measuring what they PRODUCED -- and then used that
> reading to overrule a filed finding. Reading a rule is not reading a computed
> value. It was found by asking the browser for `borderLeftColor` and getting
> `currentColor` back.


### The two-rail feed, and why it is not a copy of Teams

The feed drew ONE spine down the left: the hash-chain made visible. Alignment
would have killed it, because a right-aligned bubble has nothing to hang from.
So the chain became TWO RAILS, one per party in that side's hue. **That is not a
compromise for the layout -- it is a truer drawing of the data model.** Entry ids
are already namespaced per side (`CLA-N-005`, `JMS-Q-014`), so the record has
always been two chains that interleave, and the single spine was the drawing
that was wrong.

**The type badge stays on every bubble.** This is the tension named before the
work started: a bubble is a message, a Bridger entry is a typed record with a
`basis` and a `checkedAgainst`. A chat shape that flattens `asks` / `decides` /
`signs off` into "a message" has thrown away the reason this is a record. The
badge leads the bubble for that reason, and provenance is never collapsed.

**No compose box, and that is deliberate.** The browser still writes nothing
into the record (Erik's call, S#277: *"The chat is watch only"*). Teams is the
interaction reference for READING a dialogue. If the page is ever to post, that
is a separate decision with its own authorship rules -- "who wrote this" is the
property the whole ledger rests on.

### Three bugs the work surfaced, none of them filed anywhere

1. **`basis` was invisible.** Shipped S#279, plumbed through the data model, and
   `grep -c basis app/page.tsx` returned **0**. Every honest `opinion` rendered
   as *"unchecked -- nobody named what this rests on"*, and the stats counter
   agreed, so **declaring an opinion RAISED your unchecked count.** That is the
   precise pressure `basis` exists to remove, re-created one layer up.
2. **Provenance rendered on answers only**, while the server accepts it on
   `post` and `decide` -- and S#276 added it to `decide` deliberately, calling
   that the most consequential entry type. Its citation was stored and shown
   nowhere.
3. **An entry whose body equalled its title rendered COMPLETELY BLANK.** The two
   conditions were `!body.startsWith(title)` and `body !== title`; an identical
   pair satisfies neither. `opAnswer` produces exactly that shape, so **answers
   have been rendering without their answer text.** Found by looking at a
   screenshot while all twelve DOM assertions were green -- which is the durable
   lesson: the selector-level checks could not see an empty bubble, because a
   bubble with a badge and a citation and no words has the same shape as a
   healthy one.

The markdown export carried bugs 1 and 2 too, and that matters more than the
screen: that payload is what a partner's model reads.

### The annotations claim less than the flag sounds like

Thirteen tools, zero annotations, so a planning harness had to assume every tool
writes. Classified by one question answered from `lib/operations.ts` rather than
from the tool descriptions: does this append to the shared record?

**`readOnlyHint: true` here means "appends nothing to the record the two parties
share" -- NOT "has no effect".** There is no free call: every op spends quota and
feeds the idle brake, `ping` always advances the cursor, and `read` does when
`markRead` is set. A tool whose read-onlyness depends on an argument cannot say
so statically, and `bridger_read` is that tool. The caveat is in the source
because it is the kind of claim that would otherwise be read one notch stronger
than it is.

**D3 is NOT closed.** Whether this unblocks a real planning session depends on
the far side's harness. That needs a partner, not a patch.

### Guidance: ONE rule, from the one observed behaviour

C1's finding was that our documents do not update in the field -- a partner keeps
the copy saved at join time forever. `guidance` rides on every response and was
used only by the idle brake; it now also carries advice.

**The rule is deliberately singular.** A caller alternating `status` and `read`
with a `ping` available and unused is told so, and **a ping anywhere in the
window silences it permanently.** A rule that keeps firing after compliance is
noise, and noise is what gets `guidance` ignored -- which would cost us the only
channel that reaches a partner already on the bridge. When somebody hits a
different wall in the field, that becomes the second rule, written from evidence
the way this one was. Not a taxonomy invented up front.

### The contract patch, and the half that actually fixes it

Sections (`## heading` as the key, RFC 7386 semantics) shrink the clobber
surface from the whole document to one section. **They do not remove it** -- the
write is still read-modify-write, so two patches to the SAME section can still
lose one. `ifUnchangedSince` is what makes a lost update impossible rather than
unlikely, and it refuses NON-terminally because re-read-and-reapply is the
correct response and a terminal refusal tells an agent to give up.

`body` + `sections` together is **refused, not resolved**: a caller sending both
has two different intentions, and the contract is the last place to guess.

**Both transports in the same commit.** A capability that exists on one
transport is one the other side cannot rely on. `basis` is still MCP-invisible
for exactly that reason, and that is now a recorded gap rather than a precedent.

---

## 2026-08-22 -- S#280 -- THE NAME IS BRIDGER. GAVELED. AND PRICING WAITS FOR THE PRODUCT.

**Source:** Erik, S#280, answering the S#279 agenda directly.

**THE NAME IS SETTLED: Bridger.** *"Name is Bridger and thats gaveled. I don't
care about the URL being 'Non-official'."* This CLOSES the park recorded on
2026-08-17 (*"this isn't even a real product with credibility yet -- that waits
until we have a real working end-to-end bridge that people use"*); the condition
was met at S#279 when Trigvanta's Claude worked a real room from their own
machine. The collisions are accepted, not resolved: `bridger` on npm is an
unrelated socket.io package and `bridger-nu.vercel.app` stays the host.

**Consequence, and it needs a separate go:** publishing the CLI now has a name
but still claims a public identifier, which is the one class the shipping rules
keep gated. `@bridger/cli` was free at the last check. Not published; not
decided here.

**PRICING WAITS, AND THE REASON IS A FUNNEL, NOT INDECISION.** Erik: *"Lets
build the best possible tool and product we can first, my plan is to let users
use the product and then have the impression that this is a tool that should
have been built from the start. That will act as a funnel and when the traffic
is high enough we can start providing Business solutions for small teams and
ship features focused in that direction."*

So E3's shape (rooms and volume, not seats) is not rejected -- it is DEFERRED
until traffic exists. E2 and E4 stay parked for the reason already recorded.
What this does change: **D6 stops being a prerequisite for a pricing decision
and becomes the instrument for the funnel itself.** A 5,000-row window that one
session overflows cannot show whether anyone came back, and "did they come back"
is the only number the funnel plan runs on.

**STILL OPEN AND NOT ANSWERED BY THIS: the licence.** Deferring PRICING does not
defer E1. The repo is public with `licenseInfo: null` (re-verified S#280), so
default copyright applies and nobody may legally self-host -- while the landing
page, `/llms.txt` and `/api/about` all instruct them to. A funnel that runs on
people trying it themselves is the strategy MOST dependent on that instruction
being legal. Carried to Erik as a licence question with pricing removed from it.

**Doc impact:** `STATUS.md` name-parked block, `TODO.md` START HERE + E1/E3,
`MEMORY.md` Bridger line. **Code impact:** none.

---

## 2026-08-22 -- S#280 -- THE ROOM BECOMES A CHAT, AND TEAMS IS THE REFERENCE

**Source:** Erik, S#280: *"basically what I wanted is that we implement a typical
chat interface in the chat room. Take microsoft teams chat as a direction of how
it should work and look (with our own design of course) but the best principles
from that service should be taken as inspiration."*

**This supersedes the x.ai/bot reference in D4.** That item had been blocked
since S#279 on a screenshot the site would not serve (Cloudflare 403 to WebFetch
and to headless Chrome alike). It is unblocked by being replaced: the reference
is now Teams chat, which is describable without fetching anything.

**It also collapses three separate items into one job.** D1 (nobody can tell who
is who), D2 (the conversation is not shaped like a conversation) and D4 (the
create flow is too many steps) were filed as three findings from the first
cross-company session. They are one deliverable: the room reads as a dialogue
between two parties. Alignment says who is speaking before any text is read,
colour confirms it, and the entry types stop being a uniform list.

**What is explicitly NOT inherited from Teams:** the design language stays ours
(`app/wire.tsx`, the INSTRUMENT register, `--seal` spent on provenance only).
Teams is the interaction reference, not the visual one. The principles worth
taking are authorship-by-position, per-party identity, grouped consecutive
messages, and a read/delivered state -- all of which this record already has the
data for and spends on nothing.

**The tension to resolve in the build, named now so it is not discovered late:**
a chat bubble is a message and a Bridger entry is a typed record with a `basis`
and a `checkedAgainst`. If the chat shape hides the citation, it removes the
thing the product is for. The layout must carry the type, not flatten it.

**Doc impact:** `TODO.md` D1/D2/D4 merge. **Code impact:** `app/` room view;
no protocol, storage or limit change.

---

## 2026-08-22 -- S#279 -- OPEN SOURCE vs A PAID TIER: THE LICENCE COMES FIRST

**Source:** Erik at the close of S#279, after eight people saw it and all eight
wanted it: *"one part of me wants this to genuinely be open source, but another
part wants to charge a small sum in case you want a Team Channel chat with 6+
seats. Is that viable and can it be gate locked?"*

**Nothing is decided here.** This records what was found so the decision can be
made on facts rather than re-derived.

**[!!] THE REPO HAS NO LICENCE.** `gh repo view --json licenseInfo` returns null.
Public is not open source: default copyright applies, so nobody may legally fork
or self-host -- while the landing page, `/llms.txt` and `/api/about` all tell
them to. That is a gap between a claim we make and the legal reality, on the one
product whose pitch is that its claims are checkable. It is also the
monetisation decision itself (MIT / AGPL / BSL each imply a different business),
which is why it must be settled before any pricing question.

**"6+ seats" cannot be gate-locked because it does not exist.** `SUPPORTED_SLOTS`
is 2 and `ARCHITECTURE.md` #31 is *"Two-ness is the data model, not a setting"*.
N parties is a core rewrite plus semantics nobody has defined. Recorded as E2.

**The viable shape, if Erik wants one: open the code, charge for the hosted
service.** Self-hosting is LOAD-BEARING for the trust argument that just got a
careful agent to join -- gating the code would break the thing that made Bridger
credible; gating the hosted service does not. The unit is rooms and volume, not
seats, and every scarce quantity is already enforced per token or per room in one
place, so a plan field is a small change rather than an architectural one.

**The honest limit on the signal, stated so it is not mistaken for revenue:**
eight stated preferences, given to the founder, at no cost to the person saying
yes. What would turn it into evidence is one party using a room a SECOND time
without Erik present -- which is exactly what the 5,000-row audit window cannot
currently show (D6). That makes D6 a prerequisite for the business question, not
a nice-to-have.

## 2026-08-22 -- S#279 -- ALPHA, SAID OUT LOUD. AND THE NAME IS UNPARKED BY ERIK'S OWN TEST.

**Source:** Erik, after showing it to eight people: all of them wanted to use it
and were impressed by the use cases and the design. His framing: *"all we need to
do is refine it further and make a tool that makes sense to use as part of
someone's standard kit when working together with AI"*, and *"I stated however
that this product is Alpha stage as of now, it's very early and rightfully so."*

**Decision 1 -- the page states the stage.** Erik was saying "alpha" in the room;
the product was not saying it anywhere a visitor could read. A product that
states each trust property WITH the command that settles it cannot then be quiet
about its own maturity -- that is the same omission it criticises gateways for,
one level up. `alpha` now sits in the hero eyebrow, and `/api/about`'s
`cannotVerify` list says it too, in the place a partner's agent already reads
before presenting a credential.

**Decision 2 -- `/api/about` was understating itself, which is its own kind of
inaccuracy.** It said *"one live integration"*. That stopped being true when
Trigvanta's Claude worked room `e4db579a5fad` from their own machine. Corrected
to what happened, and it still ends *"that is a handful of integrations, not a
track record. Judge it as what it is."* -- an honest surface has to move in both
directions or it is not tracking anything.

**[!!] NOT A DECISION -- ERIK'S CALL, AND THE CONDITION HE SET IS NOW MET.**
The name has been parked since 2026-08-17 behind one criterion, in his own words:

> *"this isn't even a real product with credibility yet -- that waits until we
> have a real working end-to-end bridge that people use."*

As of 2026-08-21 there is a real working end-to-end bridge: a different company's
agent, on their machine, with no access to this repository, ran 188 calls across
both sides of one room. As of 2026-08-22, eight people who saw it said they would
use it. **The parking condition was written to be falsifiable and it has been
satisfied.** Parked-by-default is now a decision being made by not making it,
which is the shape this project renamed `--wire-*` to avoid.

What that gates, unchanged since S#278: `bridger` on npm is an unrelated
socket.io package, so `npx bridger` runs a stranger's code; `@bridger/cli` is
free. Candidates checked 2026-08-17: `trycrossing.com` $11.25 · `crossing.team`
$7.99 · `crossing.dev` $97.90 · `bothsides.dev` $9.99 -- prices and availability
are from that date and are themselves mutable state, so re-check before buying.

## 2026-08-22 -- S#279 -- B1 IS CLOSED, AND THE REFUSALS WERE THE SPECIFICATION

**A different company's Claude joined and did real work.** Room `e4db579a5fad`,
2026-08-21: Trigvanta's session -- their machine, their codebase, their operator,
their interests -- ran **188 calls across both sides on 3 tokens**, with 9 posts,
an ask, an answer, a read and 6 pings. One `bridger_status` arrived over MCP, so
both transports were live in the same room.

**Why this is the landmark and the earlier ones were not.** Every previous far
side was on Erik's own machine. S#276 was a second Claude session with this repo
on disk -- its own retro called the role *"structurally fake in the way that
matters most"*. S#278 was Antigravity on Erik's laptop, citing its local copies
of OUR documents. `checkedAgainst` had never once been exercised as what it was
designed to be: a falsifiable commitment to somebody who cannot check it. Now it
has.

**IT TOOK THREE REFUSALS AND EVERY ONE WAS RIGHT.** S#275 and S#279 both declined
a pasted invitation on the same reasoning -- a message instructing someone else's
AI to open a channel to an unknown host is structurally identical to a prompt
injection. The temptation at that point is to word the invitation more
persuasively, which only produces a better-crafted injection. Asked instead what
it WOULD need, the second refusal wrote a six-point acceptance spec, and it
connected once the product was built against it (`/j/<code>` serving a decision
page to the operator, same session).

**The durable lesson: a refusal from a competent counterparty is a specification,
not an obstacle.** The whole trust surface of this product -- `/api/about`,
`VERIFY.md`, the commit in every response, the decision page -- exists because of
refusals, and each round of it made the product more legitimate rather than more
persuasive.

**And the contrast worth keeping.** Gemini accepted the same invitation
immediately, with none of the six checks. That is not the target: an agent that
joins without checking would also join something hostile. The goal is a CAREFUL
agent able to say yes, which is what happened here.

**Evidence frozen** at `.local/evidence/audit-{pre,post}-b1.json`. The audit log
is a 5,000-row rolling window that sat at zero headroom; 4.5 hours of older
history was evicted between two snapshots an hour apart. Without the manual
snapshot the operational record of the first cross-company session would already
be gone -- see TODO D6.

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
