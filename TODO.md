# TODO — Bridger

Read `STATUS.md` first — the bridge is **stopped** and production is **stale**.
Nothing below matters until that block is understood.

---

## 0. Bring it back (Erik gates this)

```bash
vercel deploy --prod            # Erik only — behavior-guard.py blocks it for Claude
npm run bridger -- start        # then lift the kill switch
```
**Deploy before start.** Lifting first restores the pre-budget build.

---

## Lane: safety — before another agent touches the bridge

- [ ] **Watch the budget under a real loop.** The caps are unit-tested and the
      terminal refusal is verified by hand; neither has met an actual runaway
      agent. The number that matters is whether a looping agent *stops* on
      `STOP.` — if it retries anyway, the message is not doing its job and the
      next lever is refusing at the transport level.
- [x] **Audit successful calls, not just denials.** DONE S#272 — rows written in
      `gated()`, the one seam every request passes, carrying real
      tokenId/roomId/side (the deny rows cannot: a refused caller has no
      resolved token). `AUDIT_LOG_MAX` 1000 → 5000. **Unit-green, not run-green.**
- [x] **Per-room budget, not just per-token.** DONE S#272 — and the real hole
      was sharper than this line: **rotation resets the per-token counter**, so
      the cap could be cleared by the operator following our own refusal text.
      `ROOM_USAGE_KEY` + `RoomRecord.dailyCap` (600). Ablation-proven.
      **Unit-green, not run-green.**

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

- [ ] **`/join/<one-time-code>`** — a page that detects or asks the client and
      emits the exact paste-block. Three clients spell remote MCP three
      different ways (`ARCHITECTURE.md` #13) and a partner will hit that wall
      blind. The code burns on first view, which also removes live tokens from
      chat.
- [ ] **`/api/whoami`** — takes a token, answers *"valid, room X, side B, last
      seen 3m ago"*. Today every rejection is the same string by design, so
      "it doesn't work" is undiagnosable from the partner's end.

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
