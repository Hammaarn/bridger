# STATUS — Bridger

`DECISIONS.md` wins on direction. This file is what is *true right now*.

**As of 2026-08-11 (S#271). Nothing deployed. Nothing pushed. No git repo yet.**

## Built and verified

| Piece | State | How it was checked |
|---|---|---|
| `lib/store.ts` | done | typechecked; exercised by every test via `FakeStore` |
| `lib/room-registry.ts` | done | **22 tests** — incl. fail-closed, cache grace, revoke-beats-cache, rate limit, rotation |
| `lib/entries.ts` | done | **17 tests** — incl. namespacing, token-derived identity, derived open-questions, seq-survives-trim, wait semantics |
| `app/api/mcp/route.ts` | done, 8 tools | `next build` clean; auth path probed live |
| `app/api/health/route.ts` | done | probed live: `503 / registry: not-configured` |
| `app/api/export/route.ts` | done | typechecked; **not yet exercised against a real registry** |
| `cli/bridger.ts` | done, 8 commands | typechecked; **only the usage path has been run** |
| `skill/SKILL.md` | done | — |

**39/39 tests green. `tsc --noEmit` clean. `next build` clean.**

## Verified by running it, not by reasoning

- `POST /api/mcp` with **no** Authorization → `401`
- `POST /api/mcp` with a **bogus** bearer → `401`
- `GET /api/health` with no Upstash configured → `503`, `registry: "not-configured"`

That last one is the control. `withMcpAuth` returns the same fixed string
(*"No authorization provided"*) for every rejection, so the two 401s alone could
not distinguish "token rejected" from "server misconfigured" — a 401 that was
always going to be 401 proves nothing. Health separates them, and confirmed the
local 401s were the absent registry rather than broken header plumbing.

Read `node_modules/mcp-handler/dist/index.js:143-180` to confirm: the header
*is* parsed and passed to `verifyToken`; the generic message is emitted whenever
that returns `undefined`.

## END TO END, RUN FOR REAL — no database, no deploy

Upstash turned out not to be needed to prove any of this. `BRIDGER_STORE=file`
(added after Erik asked whether the DB was crucial) runs the whole bridge off a
local JSON file, which is also the right backend for two sessions on one laptop.
Against a live server on `:3210`, with two different tokens:

| Step | Result |
|---|---|
| `initialize` | 200 — `serverInfo: bridger 0.1.0`, instructions delivered, **stateless** (no session header) |
| `tools/list` | all 8 tools listed |
| A `bridger_ask` | `JMS-Q-001`, seq 1 |
| B `bridger_status` | `unread: 1`, `openQuestions[0].yours: true` — correct side, correct turn |
| B `bridger_answer` + `checkedAgainst` | `TRI-A-001`, `checked-against: lib/external/key-registry.ts:289` |
| A `bridger_status` | `openQuestions: 0` — derived closure works |
| `GET /api/export` → `bridger pull` | 3 entries materialised; folder verified UTF-8 correct |
| `bridger log` | ✓ marks the answer carrying provenance |

**The revocation control, which is the one that found a bug:**

| | before revoke | after `bridger revoke --side b` (from a separate CLI process) |
|---|---|---|
| side A token | 200 | **200** |
| side B token | 200 | **401** |

A 401 next to a 200 in the same breath is the only version of that check worth
running. See the defect below for what the first attempt showed.

## The defect this session found

**Revocation silently did nothing in file mode.** The operator CLI is a separate
process: `bridger revoke` wrote `active: false` and reported success, while the
running server kept serving the revoked token from an in-memory snapshot loaded
at startup. `file-store.ts` had a comment saying it was "not safe across
processes" — true, and it badly under-sold the consequence. A revocation that
reports success and does nothing is worse than one that fails loudly.

Fixed: every read checks the file's mtime and reloads if another process wrote.
Regression test added (`sees another PROCESS's revocation`), and the live control
above now passes. **Found by running the control, not by reading the code.**

## Still NOT verified

1. **Nothing has run against Upstash.** The Redis path is exercised only by unit
   tests through the injected-store seam. Needed before any hosted deploy.
2. **No deploy exists.** Vercel `maxDuration` for `bridger_wait` unconfirmed.
3. **`bridger join`** shells out to `claude mcp add`; that spawn has not been run
   — the join line itself is verified only as text, not as an executed command.
4. **No real agent has driven the tools.** Every call above was raw JSON-RPC over
   curl. Claude Code and Gemini CLI connecting as clients is the next step, and
   it is the one that tests whether the tool *descriptions* actually steer an
   agent — which no amount of protocol testing can show.
5. **Upstash free-tier ceiling / `bridger.ai` / npm name** — unchecked.

## Next, in order

1. **Connect a real agent.** `claude mcp add --transport http bridger
   http://localhost:3210/api/mcp --header "Authorization: Bearer <token>"` in one
   session, and the Gemini CLI / Antigravity equivalent in another. Gemini CLI
   takes `httpUrl` + `headers` in `settings.json` — same endpoint, same token,
   no code change.
2. Watch whether the agents reach for `bridger_ask` unprompted, and whether they
   fill `checkedAgainst` honestly. That is the real test of the SKILL.md.
3. Only then: Upstash + Vercel, for the two-machine Trigvanta case.
4. Dogfood: the next real Trigvanta question goes through Bridger instead of
   through Erik. **That is the acceptance test** — if he is still hand-carrying
   markdown files, it failed.
