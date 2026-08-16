# TODO — Bridger

Read `STATUS.md` first — the bridge is **stopped**, and (changed S#272)
production is **current**, not stale.

> **DIRECTION (Erik, S#274b): Bridger is internal infrastructure first, and it
> gets build time.** Its first customer is Erik's own multi-session workflow —
> concurrent Claude sessions, Claude alongside Antigravity, the live JudgeMySite
> partner integration. **`session-bridge.md` becoming redundant is the success
> condition.** See `DECISIONS.md` 2026-08-16.

---

## THE ORDER I WOULD DO THESE IN

1. **Back it up.** 24 commits, five days, one disk, **no remote**. One command:
   `gh repo create bridger --private --source=.` Nothing else here matters if
   the disk dies, and this is the only item with no downside.
2. **Run it once, between two of Erik's own sessions.** Zero build cost, and it
   closes four open items at the same time (the `STOP.` question, the idle
   brake, the answerer path, a second cold provenance test). Both sides being
   ours removes every coordination excuse.
3. Then the lanes below.

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

- [x] **`/j/<one-time-code>`** — DONE S#272. Plain-text join document, code
      burns on read, mints an expiring token. Plus `POST /api/rpc`, a flat
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
