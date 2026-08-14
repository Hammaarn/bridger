# TODO — Bridger

Read `STATUS.md` first — the bridge is **stopped**, and (changed S#272)
production is **current**, not stale.

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
- [ ] **D3 `/api/whoami` — greenlit, NOT BUILT.** Answer only for a valid token,
      opaque refusal otherwise. The last piece of the join story.

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
- [ ] **Consider surfacing over-broad citations.** A cited range of 70 lines is
      weaker evidence than a cited line. The ledger records the string; nothing
      grades it. An honest first step is displaying the span, not scoring it.

## Lane: the join experience (highest leverage for a real partner)

- [x] **`/j/<one-time-code>`** — DONE S#272. Plain-text join document, code
      burns on read, mints an expiring token. Plus `POST /api/rpc`, a flat
      transport needing no client config at all, and `bridger invite`. Behind
      `BRIDGER_PASTE_PATH=1`. **Unit-green only — no far-side agent has ever
      redeemed a code.** Whether it becomes supported is D1 in
      `plans/DECISIONS-FOR-ERIK-s272.md`.
- [ ] **`/api/whoami`** — still open, and now the last piece of the join story.
      Recommended shape (D3): answer only for a VALID token, opaque refusal
      otherwise. A prober with an invalid token learns nothing; a prober with a
      valid one already knows everything it would say.

## Lane: hygiene

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
