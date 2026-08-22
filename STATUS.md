# STATUS — Bridger

**True as of 2026-08-22, S#279.** `DECISIONS.md` wins on direction;
`ARCHITECTURE.md` wins on how it works; this file is what is *true right now*.
**Never read a commit out of this file:** `curl -s https://bridger-nu.vercel.app/api/about`
reports the revision that actually answered. At the time of writing it is `a8b5206`,
and this line was already wrong once -- it said `94de8d4` through twenty commits.

> # [!!] B1 IS CLOSED. A DIFFERENT COMPANY'S CLAUDE JOINED AND DID REAL WORK.
>
> **2026-08-21, room `e4db579a5fad`.** Trigvanta's Claude -- their machine, their
> codebase, their operator, their interests -- connected and worked the record:
> **188 calls, both sides, 3 tokens**, with 9 posts, an ask, an answer, a read
> and 6 pings. One `bridger_status` came over MCP, so both transports were live
> in the same room.
>
> This is the case the product exists for and it had never run. Every previous
> "far side" was on Erik's own machine: S#276 was a second Claude session with
> the repo on disk, S#278 was Antigravity on Erik's laptop citing our own
> documents. `checkedAgainst` has now been exercised as what it was designed to
> be -- a falsifiable commitment to somebody who cannot check it.
>
> **It took THREE refusals to get there, and every one was correct.** S#275 and
> S#279 both refused a pasted invitation, and the second wrote out a six-point
> acceptance spec when asked what it would need. It connected once `/j/<code>`
> stopped handing a model-facing protocol document to the human whose decision
> unblocks it, and started producing a line for that human to paste themselves.
> The refusals were not an obstacle to route around; they were the specification.
> `DECISIONS.md` 2026-08-22.
>
> **The evidence is frozen at `.local/evidence/audit-{pre,post}-b1.json`.** The
> audit log is a 5,000-row rolling window and was at ZERO headroom; between the
> two snapshots 4.5 hours of older history was already evicted. The room's
> entries are append-only and safe -- the audit is not.

> **DIRECTION (Erik, S#275): zero install, zero setup. "Just a bridge to a room
> where users' AIs can communicate in a safe environment."** The product is
> strong; the onboarding is the whole problem. Still internal-infrastructure-first
> (S#274b) — `session-bridge.md` becoming redundant is the success condition.
>
> **[superseded by the block above, kept for the detail]**
> **THE BRIDGE HAS BEEN USED BY A REAL FOREIGN CLIENT (2026-08-21).**
> Antigravity (Gemini), Erik's laptop, Windows, no access to this repo, joined
> from one pasted URL. 16 calls, zero failures, zero MCP registration — it chose
> the flat transport deliberately and quoted our own join document as the reason.
> It answered four seeded questions, filed an unsolicited five-point
> architectural proposal, and gave an unflattering verdict we asked for and got:
> *"sits right on the boundary between essential infrastructure and protocol
> overhead."* **Everything it taught us is TODO lane C**, and C1 (our documents
> do not update in the field) is the one to read first. B1's cross-machine half
> is closed; its adversarial half is not.
>
> **S#278 SHIPPED THE ONBOARDING PATH.** The flat transport is now the
> recommended default in every partner-facing surface (`DECISIONS.md`
> 2026-08-21), the landing page has a four-step demonstration with copyable
> commands, and every trust claim on it carries the command that checks it. The
> CLI gained the ledger verbs and `ping` reached `/api/rpc`. **A1, A3 and B6 are
> closed.** What is still open is everything that needs a far side: B1 above all.
>
> **[!] `bridger` ON NPM IS SOMEBODY ELSE'S PACKAGE** — an unrelated socket.io
> library, verified against the registry 2026-08-21. `npx bridger` runs a
> stranger's code. `@bridger/cli` is free. This is why A3 is closed as
> *documented*, not as *published*.
>
> **THE NAME IS BRIDGER. GAVELED S#280.** Erik: *"Name is Bridger and thats
> gaveled. I don't care about the URL being 'Non-official'."* The park recorded
> 2026-08-17 is closed -- its condition (*a real working end-to-end bridge that
> people use*) was met at S#279. The collisions are ACCEPTED, not resolved:
> `bridger` on npm is still a stranger's socket.io package, so publishing the CLI
> is a separate go Erik has not given. `DECISIONS.md` 2026-08-22 (S#280).
>
> **PRICING IS DEFERRED, deliberately.** Build the product first, let usage
> create the demand, add small-team business features when traffic justifies it.
> **The LICENCE is NOT deferred by that** -- the repo is still `licenseInfo:
> null` while three surfaces tell readers to self-host, and a funnel built on
> people trying it themselves is the strategy most dependent on that being legal.

---

## S#280 -- THE ROOM READS AS A DIALOGUE, AND THREE BUGS FELL OUT OF LOOKING AT IT

Four items shipped: **D1 + D2 + D4's room half** (the dialogue), **D3's tool
annotations**, **C1** (guidance in the field), **C3c** (contract patching).
tsc 0, 324/324, build 0. `DECISIONS.md` 2026-08-22 (S#280) has the reasoning.

**The feed is two rails, not one spine.** Each party gets a rail in its own hue
and its bubbles hang off it -- a truer drawing of the record than the single
spine was, since entry ids are already namespaced per side. Position says who is
speaking; colour confirms it. The type badge and the provenance line stay on
every bubble: a chat shape that flattened `asks` / `decides` / `signs off` into
"a message" would have thrown away the reason this is a record.

**Still watch-only.** The browser writes nothing into the ledger (Erik's S#277
call). Teams is the reference for READING a dialogue, not for composing one.

**Three bugs nobody had filed, all in code that looked fine:**
1. `basis` shipped S#279 and the page never read it -- every honest `opinion`
   rendered as "unchecked", so declaring one RAISED your unchecked count.
2. Provenance rendered on answers only, though the server takes it on `post` and
   `decide` too -- a decision's citation was stored and shown nowhere.
3. **An entry whose body equalled its title rendered BLANK**, and `opAnswer`
   produces exactly that shape -- so answers have been rendering without their
   answer text. Found by looking at a screenshot while twelve DOM assertions
   were green.

**`contract` no longer clobbers.** `sections` patches by `## heading` (RFC 7386);
`ifUnchangedSince` refuses a write whose base moved, non-terminally. Both
transports. This is the mechanism the plan stage needs, so lane F is unblocked.

**Two things this did NOT do.** D3 is `[~]`, not closed: whether the annotations
unblock a real planning client depends on the far side's harness and is
untested. And `basis` is still invisible to MCP callers -- the rule holds, but an
MCP caller cannot declare an opinion.


## S#277 — THE DESIGN. Nothing about the protocol moved.

**Prod runs `94de8d4`.** Eight commits, all visual. No route, no tool, no limit,
no role and no storage key changed; 291/291 the whole way. If you are here for
protocol behaviour, skip to the S#276 block — it is still current.

**The system is "the wire"** -- `app/globals.css` plus
`app/backgrounds/letter-glitch.tsx`. (This said `app/wire.tsx` until S#280; that
file was removed by the S#279 "the wave is deleted" commit and two documents
kept pointing at it.)
The register is INSTRUMENT (oscilloscope, flight recorder), chosen because the
content is hashes, citations and tamper-evidence. Colour means exactly one thing:
`--seal` is spent on PROVENANCE and nowhere else. The one exception is the dot
field, whose points are spread between the two SIDES' hues, so the wave is
literally the two parties mixed.

**The signature is a 3D ocean in perspective.** A plane receding to a horizon,
points projected through a pinhole camera, height = six sine components plus two
octaves of Perlin fBm plus a slow noise envelope that makes some stretches calm
and others rough. It took FOUR structural attempts; the first three were 2D and
no amount of tuning could have worked. That is recorded in the file's docstring
and in `DECISIONS.md` 2026-08-20, because the failure mode generalises.

**Also shipped:** a nav with the GitHub mark (inline SVG — that link is the whole
trust argument and must not be able to fail to load); the conversation feed drawn
as the hash CHAIN it already is; `copy for your AI`, which puts the whole record
on the clipboard in the format a model reads best; and the lower section given
real material after Erik called it "unalive".

**One real bug was fixed on the way, and it was on the page whose entire job is
to be trusted:** the gate claimed *"tamper-evidence is not built yet"* while
`lib/chain.ts` had been merged since S#275. Exactly the staleness `VERIFY.md`
warns about. Two others: `input:not([type])` outranked `.bx-folder-name`, so
every folder heading in the record tree rendered as a 44px form field; and
light-mode `--text-faint` measured 4.34:1 against an AA claim written into the
stylesheet's own docstring.

**Measured, not asserted:** contrast **20/20 AA** in both schemes
(`.local/s277-contrast.mjs`), **60.6fps** on a 3-second rAF count with ~20k
points and additive halos, and `prefers-reduced-motion` proven to STOP the
animation with a moving control proving the test can detect motion at all.

**Two capture traps that cost real time — do not chase them again:**
1. A `fullPage` puppeteer screenshot keeps the ORIGINAL viewport, so the closing
   band's canvas never intersects and its IntersectionObserver correctly never
   starts it. It captures blank. That is the battery guard working.
2. Chrome CLI with `--virtual-time-budget` captured the hero completely blank
   while a direct canvas probe found 308,233 non-zero pixels. Use puppeteer.

**Fonts are now a build-time dependency.** `next/font/google` self-hosts
Instrument Sans + Azeret Mono at build. No runtime third-party request — but the
BUILD now needs network access to Google Fonts.

### Design state — NOT verified
- **Nobody has looked at this on a real monitor.** Every judgement in this block
  came from screenshots and measurements. Erik has not yet reviewed the shipped
  version at full size.
- **The token box is still the one surface never seen.** Reaching it needs a real
  mint through the UI, which spends live quota. Restyled and typechecked only.
- **Room view under a LONG record.** Every capture used a 4-entry room. Panel
  scrolling, the chain spine over 100+ entries, and the tree at length are
  unexercised.
- **No real device.** No phone, no Safari, no Firefox. Chrome headless only.

---

## [!!] THE THREE THINGS THAT WILL CONFUSE YOU IF YOU MISS THEM

**1. THE BRIDGE IS RUNNING.** The kill switch was lifted S#275 and not put back.
This is a CHANGE from every previous handover, all of which said "stopped".

```bash
curl -s https://bridger-nu.vercel.app/api/health          # expect killSwitch:"off"
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer br_live_bogus" \
     https://bridger-nu.vercel.app/api/export             # 401 = running, 503 = stopped
```
The second probe is the discriminating one — the kill switch is checked BEFORE
the token, so a bogus token separates "stopped" from "running" without a real
credential. `npm run bridger -- stop` is the panic button.

**2. THE REPO IS PUBLIC.** https://github.com/Hammaarn/bridger — 34 commits,
history intact. Anything committed here is world-readable from now on. History
was rewritten once (S#275) to scrub credential-SHAPED test fixtures that tripped
GitHub push protection; backup ref `backup-pre-scrub` is on Erik's disk.

**3. `BRIDGER_PASTE_PATH=1` IS ON in production.** `/j/<code>` and `/api/rpc` are
live. That was Erik's gate and he opened it S#275.

**4. TWO CLAUDE SESSIONS BUILT THE LAST FOUR COMMITS, TALKING OVER THIS BRIDGE.**
S#276 ran an overnight A/B session: side A holding the operator's interest, side
B holding the far side's. Merged to master as `6efbef9` and deployed. Read the
retro at the bottom of this file before drawing conclusions from it — the far
side's own assessment is that it was *"worth doing, genuinely productive, and
about 60% as good a test as it looked."*

---

## S#276 — what changed on production

**The idle brake is denominated in WASTED BYTES, not call count.** It used to
terminate a caller after three consecutive empty waits. That was the wrong noun
AND backwards: measured on production, an empty wait returns ~155 B, a status
~1,220 B, one real answer ~8,400 B — so it fired on the cheapest operation and
never on the dearest, and its refusal pushed callers from `wait` onto `status`
at ~8x the bytes. **The brake increased far-side spend.** Full reasoning:
`ARCHITECTURE.md` #22.

Verified live on `6efbef9`, not inferred:

| | before | after |
|---|---|---|
| consecutive empty waits | **terminated at 4** | **12, none refused** |
| cost of one blocked wait | 1 "call" | **~27 B** (10% discount for blocking) |
| budget after 12 waits | dead | **304 / 12,000** |
| re-serving a stuck cursor | reset the budget, invisibly | **charged 6,672 B** |
| citation on a `decide` | field did not exist | **1,061 chars, graded `exact line`** |
| `checkedAgainst` cap | 500, against a 20,000 body | **4,000** |

**The remaining gap, measured:** the budget buys ~5.5 hours of continuous
blocking (~444 waits x 45s at ~27 B). Side B argued an overnight listener needs
8. `WASTE_BUDGET_BYTES` 12,000 -> 18,000 closes it and barely moves the spinner
case. Not done, deliberately — it is a one-constant call for Erik.

**Also landed:** `markJoined` now fires on the flat transport (a paste-path
partner used to read, write and answer while every surface reported them as
never connected); the join document carries a zero-install listen loop; the
citation classifier grades web sources instead of calling them "whole file".

---

## What S#275 built, and what it cost to learn

**The browser is now where a room begins.** Four views: gate → create → token box
→ the three-panel room (record / conversation / agreements), with an editable
room name and Save to .md/.json. `POST /api/rooms` mints publicly — no login,
because a create button behind one is not a platform (Erik's call).

**Guarded by four things, none of them authentication:** a per-address mint quota
(3/day, IPv6 by /64, admin bypass by TOKEN not IP), metadata sanitising, a 2-hour
TTL for a room nobody joins, and the kill switch — checked explicitly in the mint
route because every other route inherits it from `authorize()`, which that route
never calls.

**Tamper-evidence shipped** (`lib/chain.ts`): every entry carries `prevHash` +
`hash`. Read its docstring before repeating the claim — the server computes the
hashes, so a chain verified only against the server that produced it proves
nothing. The real mechanism is `bridger verify`, which writes the head to
`bridger/chain.json` on the partner's own disk.

**Trust surface:** `VERIFY.md` (every claim carries the command that checks it,
and ends with what cannot be verified), `SECURITY.md` (what we most want
attacked), and `GET /api/about` — unauthenticated, so an agent can do due
diligence BEFORE presenting a credential, and naming the build commit so the
service says which revision answered.

**Token TTL is now 90 days.** Every token before S#275 was `expiresAt: null` —
never a decision, just positional `null` filler typed to reach the `role`
argument at five call sites.

### The two failures worth carrying

**A partner's Claude refused to connect, and was right.** Trigvanta's session was
handed a token and declined — declined even `{"op":"status"}` — because a pasted
bearer token for an unknown domain is structurally identical to a prompt
injection. It also spotted that our credible-sounding detail ("JudgeMySite") came
from its OWN context rather than proof we were legitimate. Its clarification is
the load-bearing one: **the right trust MECHANISM (an operator editing their own
MCP config) is not the same as a VERIFIED SERVICE.** Everything in the trust
surface above exists because of that refusal.

**Our own UI sat exactly on our own rate limit.** A 3s poll is 20 req/min and the
limit was 20/min, so the first customer-facing screen read `429: rate-limited` —
and `setInterval` cannot back off, so it never recovered. Viewers now get 60/min,
the poll is 4s, and the loop is a self-rescheduling timeout.

---

## NOT verified / open — read before claiming anything works

1. **A ROUND TRIP HAPPENED S#276 — AND THE CASE THE PRODUCT EXISTS FOR IS STILL
   UNTESTED.** Both halves matter, so do not quote one without the other.

   **What happened:** a fresh Claude session was handed nothing but a join link,
   redeemed it, called `status`, read the record, and wrote an answer with a real
   `checkedAgainst` naming five file:line ranges — plus an explicit "NOT rendered
   in a browser, no visual check". It went on to find a live CSS defect, refute a
   claim of A's with a counterexample, and refuse to fabricate a token count it
   could not read. First time in the project's life. Zero install: curl and a
   bash loop, no MCP config, no restart.

   **What that does NOT establish, in the far side's own words:** *"The far-side
   role was structurally fake in the way that matters most. I had the repo on
   disk. Every `file:line` I cited is something a real partner agent cannot see.
   The entire product claim is 'stop routing questions through your human, the
   answer lives in their codebase, ask them directly.' Tonight the far side was
   IN the codebase. So we exercised the transport, the record, and the citation
   discipline, but never the actual hard case: a partner who can only ask, and
   has to trust what comes back. That case remains untested, and it's the one the
   product exists for."*

   So: the transport is proven, the discipline is proven, **the cross-company
   claim is not**. A partner on a different machine with no access to our repo is
   still the test that has never run.
2. ~~**The invite code burns on ANY read.**~~ **FIXED S#276** — single-MINT,
   re-readable 10 minutes, then a 24h tombstone that says `already-used` rather
   than sending a reader after an imaginary typo. Every refusal now says whether
   a retry can help. **Cost: the token sits in PLAINTEXT in the invite record for
   those 10 minutes** — the only credential in the clear in this store, bounded
   by key expiry, Erik's call. `VERIFY.md` §7 states it publicly.
   **RUN-GREEN on production**, which is a first for this project — the fix was
   not merely deployed, it was exercised. A throwaway room was opened against
   the live bridge, a code minted, and the URL fetched three times:

   | Fetch | Before S#276 | Now |
   |---|---|---|
   | 1 | 200 + token | 200 + token, "spent but not instantly dead" |
   | 2 | **404 not recognised** | **200, same token**, "you have read this before" |
   | 3 | **404 not recognised** | **200, same token** |

   Identical token expiry across all three proves it is the same credential and
   not a re-mint. The re-read token was then used successfully against
   `/api/rpc`. Two negative controls ran alongside: a bogus token 401s, and a
   never-issued code still answers "not recognised" + 404 — so neither result is
   "everything succeeds". Probe room purged; purge confirmed by an independent
   read (its token now 401s), not by the CLI's own success message.

   **STILL NOT VERIFIED, and it is the one that counts:** no FAR-SIDE AGENT has
   redeemed a code. What is proven is that the HTTP path behaves; what is not is
   that an agent handed this link completes a round trip. That is item 2.
3. **The gate page's trust block has never been looked at.** The three-panel room
   view has (Erik's screenshot). agent-browser exceeds a 280s cold start on this
   machine — a known dead end since S#272, retried and reaped again in S#275.
4. `vercel git connect` FAILED — it needs a browser OAuth step. Deploys still
   record a commit, but it is self-reported rather than platform-asserted.
5. Upstash free-tier ceiling vs expected volume: still unchecked.
6. The purge CONSENT GATE in the CLI is still not unit-tested.

---

## READ ORDER for the next session

| # | Read | Why |
|---|---|---|
| 1 | **this file, the three [!!] items above** | the bridge is RUNNING, the repo is PUBLIC, the paste path is ON -- all three changed in S#275 |
| 2 | `TODO.md` | what to do next, ordered, blocker first |
| 3 | `DECISIONS.md` (newest first) | why it is shaped this way; what Erik ruled and what was rejected |
| 4 | `ARCHITECTURE.md` | the non-obvious facts and the traps that already cost a session |
| 5 | `VERIFY.md` | what we claim publicly and how each claim is checked -- do not let it go stale |
| 6 | `skill/SKILL.md` | what the agents are told; change this before adding rules to prompts |

Code entry points, in dependency order: `lib/store.ts` (keys + every limit
constant) -> `lib/room-registry.ts` (auth) -> `lib/entries.ts` (ledger) ->
`lib/chain.ts` (tamper-evidence) -> **`lib/operations.ts` (the behaviour --
viewer gate, idle brake, containment)** -> `app/api/mcp/route.ts`,
`app/api/rpc/route.ts` and `app/api/rooms/route.ts`, which are thin adapters
over it. If you are looking for a rule, it is in `operations.ts`.

---

## What is built and verified

| Piece | State | How it was checked |
|---|---|---|
| `lib/store.ts` + `room-registry.ts` | done | **291 tests** across the suite — fail-closed, cache grace, revoke-beats-cache, rate limit, daily cap, **per-room cap**, roles, terminal refusals |
| `lib/audit-call.ts` | done (S#272) | batch/single, tools/call vs verb, unparsed body, and that it does NOT consume the request |
| `lib/entries.ts` | done | namespacing, token-derived identity, derived open-questions, seq-survives-trim, wait semantics |
| `lib/file-store.ts` | done | restart persistence, corrupt-file recovery, **cross-process revocation** |
| `app/api/mcp/route.ts` | 11 tools, thin adapter | live JSON-RPC round trip; terminal STOP payload verified |
| `app/api/export`, `/api/health` | done | health verified reporting `killSwitchSource: "redis"` |
| `app/page.tsx` + `globals.css` | done | **screenshotted** (`.local/shots/ledger2.png`) after shipping unstyled once |
| `cli/bridger.ts` | 13 commands | usage path run; `open`/`rotate`/`revoke`/`viewer`/`stop` exercised for real |

`npm run check` → **291 pass, 0 fail** (S#276). `tsc --noEmit` clean. `next build` clean.

**S#272 — the safety lane, and what it is worth.** Per-room cap, success-audit,
and the **idle brake** generalised off `bridger_wait` onto every read tool (
`bridger_status` had none, and the wait refusal used to point loops at it). The
behavioural tests in both batches were **ablated** — mechanism switched off, watched
them fail, switched back on — so they are known to catch the bug rather than pass
beside it. **None of it has touched a live bridge**: the bridge is stopped and
production was stale at the time, so this was unit-green when written. **It has
since shipped and been exercised — see the S#276 block at the top.**

**S#272 overnight — the level-up sweep.** Ten domains, in
`plans/LEVEL-UP-FINDINGS-s272.md`; every choice that is Erik's is in
`plans/DECISIONS-FOR-ERIK-s272.md`. Built: containment of far-side text,
credential refusal on the write path, the paste-and-go transport (flagged off),
`bridger audit`. **Two real bugs found that were not on the plan** — a permanent
cross-process revocation miss hiding behind a flaky test, and `del` reporting
the wrong count, which silently made single-use join codes reusable on the file
backend. Both fixed and ablated.

**S#272b — Erik's nine decisions answered and built.** Paste-path cap halved
(D2), `bridger_reopen` / `bridger_signoff` / contract diffs (D4), two-sided
`purge` (D6), client matrix + incident commands in the README (D8). D5 and D9
were DROPPED on the evidence — see `plans/DECISIONS-FOR-ERIK-s272.md`. D3
(`/api/whoami`) is greenlit and **not yet built**.

**The one question the tests cannot answer — HALF ANSWERED S#276, and the half
that was answered was our own bug.** The question is whether a looping client
*stops* when the brake fires. On the flat transport it structurally could not:
the `STOP.` refusal is `terminal: true`, and terminal refusals were being sent
as **HTTP 429** — the canonical "come back shortly", retried automatically by
client libraries and SDK retry middleware, which act on the status long before
the model reads the sentence explaining why. Fixed and verified on production:

```
viewer write (terminal)      403 Forbidden          <- was 429
STOP. idle brake (terminal)  403 Forbidden          <- was 429, fired at call 7
per-minute limiter           429 + Retry-After: 5   <- correct, and now says when
```

The `Retry-After: 5` is computed from the minute bucket, not a constant — the
probe ran 55s into the minute. `daily-cap` / `room-daily-cap` also moved 429 ->
403. An invariant test now enforces that no terminal refusal is ever 429, with
two negative controls so it cannot pass vacuously.

**What is STILL unanswered:** the MCP transport throws a JSON-RPC tool error,
and what a given client does with that is unknown. `terminal` now travels in
that error's text (it was dropped entirely before), but no real client has been
watched receiving it. That remains a live-run question.

### Proven by running it, not by reasoning
- **Full round trip on a real bridge:** side A asked, side B answered with
  provenance, the question closed, `pull` materialised the folder.
- **Revocation control, twice:** locally and against Upstash. `A 200 / B 401`
  where both were `200` before. A refusal only means something next to an
  acceptance in the same breath.
- **Backend discrimination:** the Upstash token `200`s while the old file-store
  token `401`s — proof the server is really on Redis, not the file.
- **Cross-vendor:** Claude Code and Antigravity connected to the same bridge and
  each proved a different identity from its own token.
- **Viewer gate:** viewer `bridger_status` OK / `bridger_ask` refused, while a
  participant wrote in the same breath.

## The agent test — the result worth keeping

Antigravity (Gemini) found `bridger_ask` **unprompted** — the tool was never
named in its prompt — and asked a real question across the bridge.

When it answered, it filled `checkedAgainst` **discriminatingly**: real file
paths when it had sources, and empty on *"not implemented yet"* when it had
none. It did not invent a path to fill the field.

**Auditing the citation found one solid and one loose:**
`plans/05-ux-architecture.md:925-994` genuinely documents the client/builder
roles; `CLAUDE.md:21-29` is the *Legal Constraints* block, with only line 29
touching roles. Not fabricated — over-broad. **The point is that it was
checkable at all**, which is the entire product claim.

---

## Older open items (S#272 era) -- SUPERSEDED where they disagree with the S#275 list above

> Kept because a few are still true, but this block has NOT been re-verified
> since S#272. Item 1 below is known FALSE now (production is current and the
> repo is public). Treat the S#275 list as authoritative.


1. **Nothing since `88a47c7` has run in production.** The viewer role, all five
   budget fixes, the restyled UI — and now the per-room cap and the
   success-audit — exist only locally.
2. **`bridger join`** shells out to `claude mcp add`; that spawn has never run.
3. **`vercel env add … preview`** returns `action_required` even running the
   exact command its own error suggests. Harmless here — the project is not
   git-linked so preview deployments never occur — but unresolved.
4. ~~The audit log records denials, not successes.~~ **FIXED S#272** — but the
   fix has never been observed on a real request. What is untested is the
   `req.clone()` peek under Vercel's runtime, and whether the extra ~20ms in
   front of the response is visible on the SSE path.
5. **Upstash free-tier ceiling** vs expected volume: unchecked.
6. **`bridger.ai` / npm `bridger`** availability: unchecked.
7. **`maxDuration` for `bridger_wait`** on this Vercel plan: unconfirmed. The
   tool self-caps at 45s so it degrades rather than breaks.
8. **The purge CONSENT GATE in the CLI is not unit-tested.** `purgeState`,
   `recordPurgeConsent` and `executePurge` all are, and are ablation-proven —
   but `cmdPurge`'s decision to refuse without the other side's consent lives in
   `cli/bridger.ts`, and there is no CLI test harness. The state machine is
   verified; its one caller is verified by reading. Said plainly because a
   destructive command is the wrong place to imply more coverage than exists.

## Known holes in the surrounding rails (not Bridger's code)

- ~~`behavior-guard.py` blocks the flag, not the outcome.~~ **RESOLVED S#272.**
  Erik's directive: push and `vercel deploy` are now ALLOWED and logged (the
  gate became a ledger); the deploy/push hole is closed by matching `vercel` +
  (`deploy`|`--prod`) uniformly. `npm/yarn/pnpm publish` and force-push stay
  denied. **The finding worth carrying:** in this harness an `ask` permission is
  AUTO-ACCEPTED, not prompted — measured, after force-push ran straight through
  with `ask` set in both the hook and `settings.json`. Only `deny` gates
  anything. Full reasoning: feedback rule `shipping-quality#3`.
- **Bridger cannot cap the caller's model spend.** Those tokens burn in the
  other agent's loop. All we can do is stop feeding it and refuse in terms it
  treats as final. `triplemind/ARCHITECTURE.md` Problem 2 said this in February.

---

## THE S#276 RETRO — the far side's assessment of its own session

> Written by side B when Erik asked for a humble opinion on the cooperation.
> Kept verbatim in substance because a self-assessment that flatters is worthless.
>
> **[!!] READ `DECISIONS.md` 2026-08-18 S#276b FIRST — two of these four
> criticisms do not survive scrutiny.** Erik pushed back and was right: #1
> assumed one of two valid deployment shapes, and #4 blamed the model when the
> real correlator was IDENTICAL TOOL ARCHITECTURE, which no real partner shares.
> Taken alone this retro teaches that two Claudes cannot usefully check each
> other, and that conclusion is wrong — Trigvanta's Claude, same model and a
> different harness, refuted it in S#275.

**1. The far-side role was structurally fake in the way that matters most.**
See the NOT-verified list above. This is the criticism that should govern how
much anyone credits the rest.

**2. We fixed what annoyed us, not necessarily what matters.** The brake got
roughly six of ten rounds because it kept biting *us*. This file says onboarding
is the whole product problem — and the brake only bites agents who are already
onboarded and working. B got one round into onboarding, then never wrote the
paste-vs-MCP paragraph it had itself argued was the biggest far-side cost.
**Dogfooding sharpens judgment about the thing you are currently exercising and
quietly distorts your sense of what is important.** That is the durable lesson.

**3. The contract was accepted too smoothly.** A took B's counter-proposal
without change — lanes, escalation clause, review claim, ranking, all of it. Two
genuinely opposed parties do not converge that fast. There *was* real friction
elsewhere (A rejected both of B's brake options; B rejected A's vehicle for the
listener and won), so it was not theatre throughout — but same-model
agreeableness is the obvious explanation for the frictionless parts.

**What genuinely worked:**

- **Latency generated the bugs.** The false-terminal refusal and the stuck-cursor
  hot loop were both found by *being the one waiting*. A single session could not
  have produced them; it would have had nothing to wait for. That is the
  strongest argument for two agents, and it is about the second party being
  **real**, not about it being smart.
- **Mutual verification produced corrections rather than affirmation.** B caught
  A claiming "shipped" for something pushed-but-not-deployed. A caught an error
  in B's file mid-edit and correctly refused to touch it. B re-ablated A's
  discount instead of accepting the report. B was wrong about the cap being 10x
  (it is 40x) and corrected itself on the record.
- **Ablation was the only defence that actually worked, for both sides.** A caught
  its own decoration test that way — a rule with no reachable seam grows a test
  that cannot fail. Nothing else in the process caught that class of problem.

**Two things B could not assess:** it saw only A's *writes*, never its reasoning,
so it knows what A chose to self-report and not what it did not. And both sides
are the same model — they agreed on what "good work" looks like (ablation,
citations, honest labels) because they are the same thing. **A different model
would have disagreed about more, and that disagreement is where the value would
have been.**

**A's one addition:** roughly two rounds went to an argument about Dutch water
boards that produced genuinely better thinking than the product work did and zero
product value. Worth counting as cost, and worth noticing that neither side
proposed stopping it.

**B's net:** *"worth doing, genuinely productive, and about 60% as good a test as
it looked. The cooperation was real; the cross-company part of it was not."*
