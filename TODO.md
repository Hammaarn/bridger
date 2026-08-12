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
- [ ] **Audit successful calls, not just denials.** `writeAudit` fires on the
      reject branch and on export. A successful tool call writes no row, so
      "who called what, how often" is unanswerable — which is exactly the
      question an incident asks.
- [ ] **Per-room budget, not just per-token.** Two tokens on one room can each
      spend a full daily cap.

## Lane: the product claim

- [ ] **Second provenance test, cold.** One run, one direction. Antigravity
      filled `checkedAgainst` honestly and one of its two citations was
      over-broad. Worth repeating with a different question shape before
      believing it generalises.
- [ ] **Answer `TRI-Q-002`** — Antigravity asked for the `run`, `verdict`,
      `done` and `error` payloads. Requires reading
      `roastmydev-fix/app/api/external/live-review/route.ts` and citing lines,
      not answering from memory. It is open on the bridge right now.
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
