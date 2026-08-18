# TODO — Bridger

Read `STATUS.md` first — the bridge is **RUNNING**, the repo is **PUBLIC**,
`BRIDGER_PASTE_PATH=1` is **on**, and as of S#276 production runs `6efbef9` with
the byte-denominated brake. This header said "stopped" for two sessions after it
stopped being true; `curl -s <server>/api/health` settles it in one second.

**S#276 closed items 1 and 2 below.** A far-side agent completed a full round
trip — joined from a bare link, read, wrote, cited five file:line ranges — but
read the qualification in `STATUS.md`: it was on the same machine with the repo
on disk, so the cross-company case the product exists for is STILL untested.

**The next thing worth doing is the one we avoided.** Both sides spent the
session on the brake because it kept biting them, while `STATUS.md` says
onboarding is the whole product problem. Onboarding got one round. The
paste-path-as-default argument — that resident MCP schema costs a partner
~1,800 tok/turn against ~318 for the answerer, so the flat transport should be
the recommended default and MCP the opt-in — was made, agreed, and never
written into the docs a partner actually reads.

> **DIRECTION (Erik, S#275): zero install, zero setup — "just a bridge to a room
> where users' AIs can communicate in a safe environment."** The idea is strong;
> the ONBOARDING is the product problem. Still internal-infrastructure-first
> (S#274b). The name is parked until there is a working end-to-end bridge people
> use — `DECISIONS.md` 2026-08-17.

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
