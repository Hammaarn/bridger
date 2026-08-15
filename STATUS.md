# STATUS — Bridger

**True as of 2026-08-15, S#274.** `DECISIONS.md` wins on direction;
`ARCHITECTURE.md` wins on how it works; this file is what is *true right now*.

> **S#274 added three things, all unit-green and none run-green.**
> 1. **The answerer role** — `bridger answerer --side b` mints a token shown two
>    tools (`bridger_ping`, `bridger_answer`) and nothing to probe with.
>    Measured: the full surface is ~1,800 tokens of schema billed to the CALLER
>    on *every* turn; the answerer's is ~318. Answering used to cost 3 turns
>    minimum (`wait` -> `status` -> `answer`) because `wait` returns entries but
>    not open questions. `bridger_ping` returns both and advances the cursor.
> 2. **Citation specificity** — `checkedAgainst` is classified and its SPAN
>    displayed (`checkedSpan` on the wire, a badge + "thin citations" stat in
>    the UI, `✓`/`◐`/`?` in `bridger log`). It grades the citation, never the
>    claim. This is the S#271 hand-audit turned into a product feature.
> 3. **`/api/whoami`** — D3 as greenlit. Valid token gets an answer; everything
>    else gets one status and one sentence.
>
> **192 tests (was 142). Four mechanisms ablated.** The bridge is still STOPPED
> — that is Erik's switch and it was not touched.
>
> **PRODUCTION IS CURRENT: `9135d6c`**, deployed 2026-08-15 and aliased to
> `bridger-nu.vercel.app`. Verified by independent probe, not by the deploy
> tool's own success message: `/api/health` still reports
> `killSwitch:"on", killSwitchSource:"redis"`, and `/api/whoami` answers — a
> route that did not exist before, which is what proves the new build is live.
>
> **What that probe DID and DID NOT establish.** It proved the stopped-bridge
> path end to end: a presented token gets `503` and is told *"your token is not
> the problem"*, which is the difference between a partner waiting and a partner
> chasing a replacement that would fail identically. It did NOT prove the
> token-reason opacity — with the switch on, every presented token
> short-circuits to `bridge-disabled` before the token is even examined, so
> valid and bogus are indistinguishable and there is nothing to compare.
> That property stays unit-green until `bridger start`.

---

## READ ORDER for the next session

| # | Read | Why |
|---|---|---|
| 1 | **this file, "State right now"** below | the bridge is STOPPED and prod is STALE — start there or you will be confused |
| 2 | `ARCHITECTURE.md` | 25 non-obvious facts + 12 invariants. Traps that already cost a session |
| 3 | `DECISIONS.md` (newest first) | why it is shaped this way; what was rejected and why |
| 4 | `TODO.md` | what to do next, by lane |
| 5 | `skill/SKILL.md` | what the agents are told; change this before adding rules to prompts |

Code entry points, in dependency order: `lib/store.ts` (keys + every limit
constant) → `lib/room-registry.ts` (auth) → `lib/entries.ts` (ledger) →
**`lib/operations.ts` (the behaviour — viewer gate, idle brake, containment)** →
`app/api/mcp/route.ts` and `app/api/rpc/route.ts`, which are thin adapters over
it. If you are looking for a rule, it is in `operations.ts`, not in a route.

---

## [!!] State right now — ONE thing will confuse you if you miss it

**THE BRIDGE IS STOPPED.** The Redis kill switch is set, so every authenticated
call gets `503 bridge-disabled`. Deliberate — an agent loop burned an entire
Gemini quota (the incident is in `DECISIONS.md`). Nothing is wrong; it is off.

**PRODUCTION IS CURRENT** as of S#272 — this is a change from every previous
handover, which warned it was stale. `https://bridger-nu.vercel.app` runs the
build at `055ac3a`, deployed 2026-08-14 and verified against the live health
endpoint. The old "prod is a build behind" warning is retired; do not carry it
forward without re-checking.

**To bring it back up — one command:**
```bash
npm run bridger -- start                      # lift the kill switch
curl https://bridger-nu.vercel.app/api/health # expect healthy:true, killSwitch:"off"
```

**How to check the real state rather than trusting this file** — and you should,
because a handover ages:
```bash
curl -s https://bridger-nu.vercel.app/api/health
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer br_live_bogus" \
     https://bridger-nu.vercel.app/api/export     # 503 = stopped, 401 = running
```
The second probe is the discriminating one: the kill switch is checked BEFORE
the token, so a bogus token separates "stopped" from "running" without needing a
real credential. That check is here because `/api/health` itself lied for months
— it reported `killSwitch: "off"` while every request was refused (the pre-S#272
build only read the env switch, not the Redis one). Fixed and verified, but the
habit of confirming state from an independent angle is the point.

---

## What is built and verified

| Piece | State | How it was checked |
|---|---|---|
| `lib/store.ts` + `room-registry.ts` | done | **142 tests** — fail-closed, cache grace, revoke-beats-cache, rate limit, daily cap, **per-room cap**, roles, terminal refusals |
| `lib/audit-call.ts` | done (S#272) | batch/single, tools/call vs verb, unparsed body, and that it does NOT consume the request |
| `lib/entries.ts` | done | namespacing, token-derived identity, derived open-questions, seq-survives-trim, wait semantics |
| `lib/file-store.ts` | done | restart persistence, corrupt-file recovery, **cross-process revocation** |
| `app/api/mcp/route.ts` | 11 tools, thin adapter | live JSON-RPC round trip; terminal STOP payload verified |
| `app/api/export`, `/api/health` | done | health verified reporting `killSwitchSource: "redis"` |
| `app/page.tsx` + `globals.css` | done | **screenshotted** (`.local/shots/ledger2.png`) after shipping unstyled once |
| `cli/bridger.ts` | 13 commands | usage path run; `open`/`rotate`/`revoke`/`viewer`/`stop` exercised for real |

`npm run check` → 142 pass, 0 fail. `tsc --noEmit` clean. `next build` clean.

**S#272 — the safety lane, and what it is worth.** Per-room cap, success-audit,
and the **idle brake** generalised off `bridger_wait` onto every read tool (
`bridger_status` had none, and the wait refusal used to point loops at it). The
behavioural tests in both batches were **ablated** — mechanism switched off, watched
them fail, switched back on — so they are known to catch the bug rather than pass
beside it. **None of it has touched a live bridge**: the bridge is stopped and
production is stale, so this is unit-green, not run-green. It ships in the deploy
production is already waiting for.

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

**The one question the tests cannot answer:** whether a real looping client
*stops* when a tool throws, or treats a tool error as retryable and spins on it.
That decides whether the brake is a brake. It is the first thing to watch when
the bridge comes back.

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

## NOT verified / open

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
