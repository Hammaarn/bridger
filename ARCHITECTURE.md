# Bridger — architecture and the non-obvious facts

> **If you read one file before touching this code, read this one.** It carries
> the facts that are expensive to rediscover and the traps that already cost a
> session. `DECISIONS.md` wins on *intent*; this file wins on *how it works*.

---

## What it is, in one paragraph

A remote **MCP server** that two teams' AI sessions connect to with one pasted
line. It holds an append-only **record** of an integration: questions, answers,
decisions, and the contract both sides build against. It executes nothing, owns
nothing about the agents, and **calls no LLM** — there is no `ANTHROPIC_API_KEY`
in this codebase and there must never be one. Both sides run on their own
subscriptions; running cost is Vercel invocations plus Redis commands.

## The file map

```
app/
  page.tsx              the read-only live view (client component, polls /api/export)
  globals.css           ALL styling lives here — see trap #1
  api/mcp/route.ts      the 8 MCP tools + the budget gate in front of auth
  api/export/route.ts   bearer-authed JSON dump; feeds the UI and `bridger pull`
  api/health/route.ts   is the bridge configured, reachable, and switched on
lib/
  store.ts              narrow Redis interface + key layout + every limit constant
  file-store.ts         file-backed Store for local bridges (opt-in, never a fallback)
  room-registry.ts      tokens, roles, budgets, revocation — the whole auth surface
  entries.ts            the append-only ledger, cursors, status, wait
cli/bridger.ts          operator + partner commands
skill/SKILL.md          the usage discipline shipped to the agent
```

## The shape of a request

```
  POST /api/mcp
      │
      ▼
  gated()                 ← budget gate, BEFORE auth (route.ts)
      │  authorize({charge: true})
      │  · env kill switch → Redis kill switch → token → room → rate → daily cap
      │  · refused?  terminal JSON-RPC error, message opens with "STOP."
      ▼
  withMcpAuth(verifyToken)
      │  authorize({charge: false})   ← MUST NOT charge again
      │  AuthInfo.extra = { room, token }
      ▼
  tool handler
      │  bridgeFrom(ctx)          reads      → any token
      │  writableBridgeFrom(ctx)  writes     → participants only
      ▼
  entries.ts → Redis
```

---

## Non-obvious facts

**1. All styling is in `app/globals.css`. Do not reach for styled-jsx.**
The first version used `<style jsx>` inside a client component. `tsc` passed,
`next build` passed, and the page shipped **completely unstyled** — every class
name present, no rules applied. Nothing failed loudly.

**2. A string check on served HTML is not UI verification.**
Directly from #1: the markup was correct, so grepping the response for
`"Room token"` reported success while the page was raw HTML on a black
background. A visible surface is verified by *looking at it*
(`agent-browser screenshot <path>` — positional path, `--full`, **not**
`--path`/`--full-page`, which hang).

**3. `authorize()` runs TWICE per request; exactly one call may charge.**
The budget gate needs the resolved token to shape a terminal refusal;
`verifyToken` needs it to build `AuthInfo`. Both call `authorize`. The gate
charges, `verifyToken` passes `charge: false`. Get this wrong and every counter
doubles, halving every cap.

**4. A generic 401 is the worst possible reply to a looping agent.**
`withMcpAuth` can only answer yes or no, and every no becomes the same fixed
string — which reads as "try again". That is why refusals are shaped *before*
auth. `DENY_MESSAGE` entries for terminal reasons open with `STOP.` and say
plainly that retrying cannot succeed. `no-token` / `unknown-token` deliberately
fall through to the standard challenge: no reconnaissance, and MCP clients need
the real `WWW-Authenticate` to negotiate.

**5. Entry IDs are author-namespaced, and that is what removes merging.**
`JMS-Q-014` = side code + type letter + counter. The side comes from the
**token**, never from arguments, so a caller cannot mint an ID in the other
party's namespace. Codes are disambiguated at room creation, so two partners
both called "Acme" cannot collide.

**6. Open questions are DERIVED, never stored.**
A question is answered because some `answer` entry references its id. Nothing
mutates, so two sides answering at once is just two entries. There is no flag to
race on.

**7. `seq` is a counter, not a list index.**
The entries list is trimmed at `MAX_ENTRIES`, which shifts indices. Cursors
compare `seq`, so trimming can never renumber history or resurrect read entries.

**8. Retention is an IDLE TTL on the room, not per-entry expiry.**
Redis cannot expire list members. Every write refreshes a 30-day TTL, so an
active room keeps its whole history and a dead one is collected whole. Local
`bridger/` folders are the permanent record; the server is a buffer.

**9. The file store re-reads on mtime, and must.**
`BRIDGER_STORE=file` keeps state in memory. The operator CLI is a **separate
process**: without an mtime check, `bridger revoke` wrote `active: false`,
reported success, and the running server kept serving the revoked token from its
startup snapshot. A revocation that reports success and does nothing is worse
than one that fails loudly.

**10. `BRIDGER_STORE=file` is opt-in and throws on Vercel.**
It is never a fallback for missing Upstash credentials — a hosted deploy that
degraded to per-instance files would look healthy while every instance kept its
own disappearing ledger. Missing credentials fail closed instead.

**11. There are TWO kill switches, and health must report both.**
`BRIDGER_DISABLED=true` (env, needs a redeploy) and the `bridger:disabled` Redis
key (immediate, no cache in front of it — checked before anything else on every
request). `/api/health` once checked only the env one and answered
`healthy: true` while the bridge was refusing everything.

**12. Vercel's published mcp-handler example is stale against 2.1.0.**
Verified by reading `node_modules`, not the docs page: types come from
`@modelcontextprotocol/server` (**not** `/sdk`); `createMcpHandler(init, opts)`
takes two args with **no** `basePath`; `registerTool` wants a **full zod object**
as `inputSchema`, not the raw-shape form; a tool reads its caller from
`ctx.http?.authInfo`.

**13. Every MCP client spells remote config differently.**
Claude Code `claude mcp add --transport http … --header`; Gemini CLI `httpUrl` +
`headers`; **Antigravity requires `serverUrl`** and rejects `url`/`httpUrl`.
Antigravity's live config is `~/.gemini/config/mcp_config.json` — three
`mcp_config.json` files exist and two are 0-byte fossils, so confirm with the
IDE's own *View raw config* button.

**14. `fra1` and `eu-central-1` are paired on purpose.**
Vercel defaults to `iad1` (US East). With an EU database that would cross the
Atlantic on every Redis hop, several per request. `vercel.json` pins `fra1`;
if the Upstash region ever changes, change this too.

**15. PowerShell will corrupt this repo's source files.**
`Set-Content -Encoding utf8` writes a **BOM**; esbuild then fails on the CLI's
shebang while `tsc` tolerates it. `Get-Content` without `-Encoding utf8` renders
UTF-8 as cp1252 and makes correct files look like mojibake. Use the Read/Write/
Edit tools, or `[System.IO.File]::WriteAllText` with a BOM-less encoder.

**16. Rotation resets the per-token daily counter — the room counter is what survives it.**
`rotateSide` calls `issueToken`, which derives `id` from a fresh hash, and
`USAGE_KEY` is keyed on that id. So a rotated side starts the day at zero. This
is not a hostile-caller hole (no MCP tool issues tokens; rotation is
operator-only) — it is a hole in the *honest* response to a refusal: agent hits
`daily-cap` → reads our own message *"tell your operator the bridge budget is
exhausted"* → operator rotates → the loop resumes with a full 400.
`ROOM_USAGE_KEY` is keyed on the room, which rotation does not change, and
`DENY_MESSAGE["room-daily-cap"]` explicitly tells the operator not to mint a
replacement. **Two counters, two questions: "has this token spent its share" and
"has this bridge spent its day".**

**17. The audit log records SUCCESSES, and that is recent.**
Until S#272 `writeAudit` fired only on the reject branch and on export, so a
successful tool call left no row and *"who called what, how often"* — the first
question an incident asks — was unanswerable. `AuditEntry.status` already had
`"ok"` in its type; nothing wrote it. Rows are now written in `gated()`, the one
seam every request passes, with the tool name read from a **clone** of the body
(`lib/audit-call.ts`) so the handler still gets an unread request. Two
consequences: `AUDIT_LOG_MAX` went 1000 → 5000 because denials are rare and
successes are the traffic; and `durationMs` on an SSE `GET` row is
time-to-headers, **not** how long the stream stayed open — the honest duration
is on `bridger_wait`, which is a POST.

**18. Blocking is cheap; TURNING is expensive. The brake is on turns.**
The costs live in the caller's session, and a `bridger_wait` that holds the
socket 45s bills them exactly what an instant reply does — **one inference**. So
long waits were never the problem, and shortening them would make things worse,
not better. The problem is the number of *replies*, each of which buys one more
turn over a context that grew since the last one.
This is also why the caps are not the answer on their own: `RATE_LIMIT_PER_MINUTE`
and the daily caps bound CALLS, and cannot bound TOKENS — those burn where we
cannot see them. 600 polls is a legal day under every cap here and still a
terrible day for whoever pays for it.
So `IDLE_STREAK_KEY` counts **consecutive calls that returned nothing new**, on
whichever tool the caller is spinning. Acquiring information resets it; so does
writing, cleared inside `appendEntry` because every write path funnels through
it. Two thresholds on one counter: `MAX_EMPTY_WAIT_STREAK` (3) for
`bridger_wait`, which says *"I expect something right now"*, and
`MAX_IDLE_STREAK` (6) for `bridger_status` / `bridger_read`, which are also the
legitimate start-of-session calls. Past the limit the tool THROWS.
**Two S#272 corrections worth keeping:** `bridger_status` had no brake at all and
was the one tool an idle agent would naturally spin on — and the wait refusal's
own last sentence used to read *"the answer will be here at your next
bridger_status"*, sending a looping agent from the braked tool to the unbraked
one. Refusals now point at a HUMAN, never at another tool.

**19. The bridge is a cross-company prompt-injection channel, and the defence is half deterministic.**
Every entry is written by another company's model and lands verbatim in ours.
Before S#272 there was nothing on that path — a grep for
`sanitiz|guard|redact|escape|untrusted` across `lib/ app/ cli/` returned **zero
hits**. `lib/untrusted.ts` now contains every free-text field at the two seams it
travels: `wire()` (read / wait / write-echo) and `openQuestions[].title`
(status), plus the contract body. **Be precise about what protects you:** the
`[[UNTRUSTED-PARTNER-TEXT ...]]` banner is a *rail* — an instruction to a model,
therefore probabilistic. The deterministic half is `escapeMarkers`, which makes
it impossible for far-side text to close our container early and forge our
framing. The tests pin the escaping; nothing can pin the banner. The author
label is escaped too, because it is far-side-controlled at room creation.

**20. Credentials are refused at write time, and there is deliberately no entropy check.**
An entry reaches a third party's Redis, another company's session, and both
sides' git history via `bridger pull` — append-only, so a secret written here
cannot be taken back. `lib/secrets.ts` matches **known credential shapes only**
(vendor prefixes, structural formats) and refuses the write. It does NOT do
entropy or long-hex detection, and that is the load-bearing choice: `checkedAgainst`
exists to carry commit SHAs and paths, so an entropy check would refuse
provenance, which is the product. A missed bespoke secret is survivable; a
blocked citation is not. **Two call sites, one scanner** — `appendEntry` and
`setContract`, because `setContract` stores the 100k body to Redis *before*
calling `appendEntry`, so a single scan in the latter would refuse the caller
while the secret sat stored.

---

## Invariants — break these and something silent goes wrong

1. **No LLM call, ever.** The moment a model call enters this codebase, the cost
   story and the subscription-only promise are gone.
2. **One write path.** Every mutation goes through the MCP tools. The UI reads.
   `/api/export` reads. If a second write path appears, "who wrote this" — the
   property the whole ledger rests on — stops being answerable.
3. **Identity comes from the token, never from arguments.**
4. **Fail closed.** No registry → refuse. Unreadable kill switch → assume ON.
5. **A missing field must never downgrade a partner mid-integration.** Absent
   `role` → participant. Absent `dailyCap` → the default, not infinity.
6. **Counters are charged last**, after every other gate, so a refusal for the
   wrong room never spends the caller's budget. Within that block the order is
   minute → token-day → room-day, **narrowest first**, so a caller over its own
   cap is told `daily-cap` rather than `room-daily-cap`: those two refusals send
   an operator to different places.
8. **Every budget ceiling must be able to bind.** A room cap equal to the sum of
   its tokens' caps can never be the constraint that fires, which makes it
   decoration — the mistake the 120/min rate limit already taught this project
   once. `DEFAULT_ROOM_DAILY_CAP` (600) is deliberately below
   `2 x DEFAULT_DAILY_CAP` (800), and a test asserts it.
7. **Provenance is a path, not a boolean.** A boolean can be set true without
   evidence, which is the exact failure the field exists to catch.
9. **A refusal never names another tool.** Every STOP message points the caller
   at its operator. Naming a tool in a message whose job is to end a loop just
   moves the loop, and this codebase shipped exactly that bug once.
10. **Far-side text is never bare.** Any new path that puts an entry, a title, a
    contract or a label in front of a model goes through `contain()`. A field
    added to `wire()` without it is a hole, and it will not look like one.
11. **A refusal that the caller can fix must not be shaped like STOP.** The
    credential refusal says retrying works, because it does. Reusing the
    loop-ending vocabulary for a one-edit problem makes a well-behaved agent
    abandon a task it could finish.
