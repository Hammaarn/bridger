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

## NOT verified — the honest list

1. **No call has ever succeeded end to end.** Every local probe was a *refusal*.
   The valid-token path — `tools/list`, a real `bridger_ask`, an answer coming
   back — needs a live Upstash instance and has never run. This is the single
   biggest open risk and the first thing to do after provisioning.
2. **`/api/export` and `bridger pull`** have never touched a real registry.
3. **`bridger join`** shells out to `claude mcp add`; that spawn has not been run.
4. **`maxDuration` for `bridger_wait`** is unconfirmed against the Vercel plan.
5. **Upstash free-tier command ceiling** not checked against expected volume.
6. **`bridger.ai` / npm `bridger`** availability not checked.

## Next, in order

1. **Erik: provision an Upstash Redis DB** (its own, not JudgeMySite's) and put
   `UPSTASH_REDIS_REST_URL` / `_TOKEN` in `.env.local`.
2. Run `npm run bridger -- open ...` locally, then connect **this** session to
   `http://localhost:3000/api/mcp` and call `bridger_status`. That closes gap 1
   without deploying anything.
3. `git init` + first commit. **Erik gates the push.**
4. Deploy to Vercel, set the same env vars, re-run the probes against production
   *with a control path* — a valid token must 200 where a revoked one 401s.
5. Two-session test: add the server as side A here and side B in a second
   session, ask from one, answer from the other, `pull` both, diff the folders.
6. Dogfood: the next real Trigvanta question goes through Bridger instead of
   through Erik. **That is the acceptance test** — if he is still hand-carrying
   markdown files, it failed.
