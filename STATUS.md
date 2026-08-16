# STATUS — Bridger

**True as of 2026-08-17, S#275.** `DECISIONS.md` wins on direction;
`ARCHITECTURE.md` wins on how it works; this file is what is *true right now*.

> **DIRECTION (Erik, S#275): zero install, zero setup. "Just a bridge to a room
> where users' AIs can communicate in a safe environment."** The product is
> strong; the onboarding is the whole problem. Still internal-infrastructure-first
> (S#274b) — `session-bridge.md` becoming redundant is the success condition.
>
> **THE NAME IS PARKED.** `bridger` collides everywhere and `.ai` is $80/yr.
> Erik's call: *"this isn't even a real product with credibility yet — that
> waits until we have a real working end-to-end bridge that people use."*
> Candidates checked and free at the time: `trycrossing.com` $11.25 ·
> `crossing.team` $7.99 · `crossing.dev` $97.90 · `bothsides.dev` $9.99.
> Rejected with reasons in `DECISIONS.md` 2026-08-17.

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

1. **NO FAR-SIDE AGENT HAS EVER COMPLETED A ROUND TRIP.** Not Gemini, not
   Trigvanta's Claude. Both were connected or invited; neither wrote an entry.
   Every claim about the far-side experience is still inference.
2. **The invite code burns on ANY read, including a browser preview.** That is
   what broke the Trigvanta demo: their Claude fetched, re-fetched, got a 404 and
   concluded the service was broken. **Agents retry; burn-on-read assumes a human
   who clicks once.** Fixing this is the top TODO item.
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
