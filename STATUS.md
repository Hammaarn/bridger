# STATUS — Bridger

**True as of 2026-08-12, end of S#271.** `DECISIONS.md` wins on direction;
`ARCHITECTURE.md` wins on how it works; this file is what is *true right now*.

---

## READ ORDER for the next session

| # | Read | Why |
|---|---|---|
| 1 | **this file, "State right now"** below | the bridge is STOPPED and prod is STALE — start there or you will be confused |
| 2 | `ARCHITECTURE.md` | 15 non-obvious facts + 7 invariants. Traps that already cost a session |
| 3 | `DECISIONS.md` (newest first) | why it is shaped this way; what was rejected and why |
| 4 | `TODO.md` | what to do next, by lane |
| 5 | `skill/SKILL.md` | what the agents are told; change this before adding rules to prompts |

Code entry points, in dependency order: `lib/store.ts` (keys + every limit
constant) → `lib/room-registry.ts` (auth) → `lib/entries.ts` (ledger) →
`app/api/mcp/route.ts` (tools + budget gate).

---

## [!!] State right now — two things will confuse you if you miss them

**1. THE BRIDGE IS STOPPED.** The Redis kill switch is set; every token gets
`401`. Verified at close on both sides. Deliberate — an agent loop burned an
entire Gemini quota (see the incident in `DECISIONS.md`).

**2. PRODUCTION IS STALE.** `https://bridger-nu.vercel.app` runs a build from
before the viewer role, the budget fixes and the UI restyle. `vercel deploy
--prod` is **hard-blocked by Erik's `behavior-guard.py`**, so only he can ship it.

**Order matters when bringing it back — deploy BEFORE start:**
```bash
cd C:/Users/Erik/Documents/Projects/bridger
vercel deploy --prod            # Erik only; the hook blocks this for Claude
npm run bridger -- start        # lift the kill switch
curl https://bridger-nu.vercel.app/api/health
```
Lifting the switch first would restore the *old* build: 120 calls/min, no daily
cap, no terminal refusals — the exact configuration that burned the quota.

---

## What is built and verified

| Piece | State | How it was checked |
|---|---|---|
| `lib/store.ts` + `room-registry.ts` | done | **71 tests** — fail-closed, cache grace, revoke-beats-cache, rate limit, daily cap, **per-room cap**, roles, terminal refusals |
| `lib/audit-call.ts` | done (S#272) | batch/single, tools/call vs verb, unparsed body, and that it does NOT consume the request |
| `lib/entries.ts` | done | namespacing, token-derived identity, derived open-questions, seq-survives-trim, wait semantics |
| `lib/file-store.ts` | done | restart persistence, corrupt-file recovery, **cross-process revocation** |
| `app/api/mcp/route.ts` | 8 tools + budget gate | live JSON-RPC round trip; terminal STOP payload verified |
| `app/api/export`, `/api/health` | done | health verified reporting `killSwitchSource: "redis"` |
| `app/page.tsx` + `globals.css` | done | **screenshotted** (`.local/shots/ledger2.png`) after shipping unstyled once |
| `cli/bridger.ts` | 10 commands | usage path run; `open`/`rotate`/`revoke`/`viewer`/`stop` exercised for real |

`npm run check` → 71 pass, 0 fail. `tsc --noEmit` clean. `next build` clean.

**S#272 — the safety lane, and what it is worth.** Per-room cap, success-audit,
and the **idle brake** generalised off `bridger_wait` onto every read tool (
`bridger_status` had none, and the wait refusal used to point loops at it). The
behavioural tests in both batches were **ablated** — mechanism switched off, watched
them fail, switched back on — so they are known to catch the bug rather than pass
beside it. **None of it has touched a live bridge**: the bridge is stopped and
production is stale, so this is unit-green, not run-green. It ships in the deploy
production is already waiting for.

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

## Known holes in the surrounding rails (not Bridger's code)

- **`behavior-guard.py` blocks the flag, not the outcome.** `vercel deploy
  --prod` is hard-blocked; plain `vercel deploy` is **not**, and it published to
  production on a CLI-linked project. Match on `vercel deploy` generally.
- **Bridger cannot cap the caller's model spend.** Those tokens burn in the
  other agent's loop. All we can do is stop feeding it and refuse in terms it
  treats as final. `triplemind/ARCHITECTURE.md` Problem 2 said this in February.
