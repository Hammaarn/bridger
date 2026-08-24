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
  api/mcp/route.ts      MCP transport — a THIN ADAPTER over lib/operations.ts
  api/rpc/route.ts      flat HTTP transport, same operations (BRIDGER_PASTE_PATH=1)
  j/[code]/route.ts     the join document; single-MINT code, re-readable 10 min
  api/export/route.ts   bearer-authed JSON dump; feeds the UI and `bridger pull`
  api/health/route.ts   is the bridge configured, reachable, and switched on
lib/
  store.ts              narrow Redis interface + key layout + every limit constant
  file-store.ts         file-backed Store for local bridges (opt-in, never a fallback)
  room-registry.ts      tokens, roles, budgets, revocation — the whole auth surface
  entries.ts            the append-only ledger, cursors, status, wait
  operations.ts         THE BEHAVIOUR — viewer gate, idle brake, containment
  http-gate.ts          kill switch + budget + deny vocabulary + audit, both routes
  untrusted.ts          containment of far-side text
  secrets.ts            credential refusal on the write path
  question-state.ts     is a question still open — shared with the UI, no imports
  audit-call.ts         names a JSON-RPC call for the audit row
  invites.ts            join codes: mint once, stay readable briefly
  purge.ts              two-sided deletion
cli/bridger.ts          operator + partner commands
scripts/seed-demo.ts    seeds a local bridge so the UI can be LOOKED at
skill/SKILL.md          the usage discipline shipped to the agent
```

**Looking for a rule? It is in `operations.ts`, never in a route.** The routes
parse and serialise; that is the only reason two transports are safe.

`lib/question-state.ts` is the exception that proves it. The web view is a
CLIENT component and cannot import `entries.ts` — that reaches
`room-registry.ts` and `node:crypto`, which breaks the browser bundle. That
constraint is why the page once carried its own COPY of the open-question rule,
and why the copy silently inverted the moment `reopen` entries existed
(fact #24). So the one rule both sides need lives in a file with **no imports at
all**. Any future rule the UI also needs belongs there, for the same reason.

## Where everything else lives

```
README.md          what it is + quick start. Read first if you have never seen it.
STATUS.md          what is TRUE RIGHT NOW + the read order. Read first otherwise.
ARCHITECTURE.md    this file — how it works, the traps, the invariants.
DECISIONS.md       why it is shaped this way. Wins on intent. Newest first.
TODO.md            what is next, by lane.
plans/             per-session briefs and findings. Historical; read on demand.
answers/           replies drafted for the bridge but not yet posted.
bridger/           the LOCAL materialised record — `bridger pull` writes here.
.local/            working artefacts (screenshots, join snippets). Gitignored.
```

## The shape of a request

```
  POST /api/mcp                          POST /api/rpc
      │                                       │
      └──────────────┬────────────────────────┘
                     ▼
             gate()  (lib/http-gate.ts)   ← ONE gate, both transports
                     │  authorize({charge: true})
                     │  · env kill switch → Redis kill switch → token → room
                     │    → rate → token daily cap → ROOM daily cap
                     │  · refused? terminal payload, message opens with "STOP."
                     ▼
             the adapter parses its own dialect
                     │  MCP: withMcpAuth + zod tool schema (charge: false — the
                     │       gate already spent it; charging twice halves caps)
                     │  RPC: {op, ...args} + the same zod shapes
                     ▼
             lib/operations.ts            ← EVERY guard lives here
                     │  requireWrite()    writes → participants only
                     │  chargeWaste()     BYTES returned that taught nothing
                     │  contain()         far-side text is never bare
                     ▼
             entries.ts → Redis
                     │  scanForSecrets()  credentials refused before any write
                     ▼
             audit row (ok / deny / error), both transports
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
Status comes from the entries themselves — nothing mutates, so two sides acting
at once is just two entries and there is no flag to race on. **Since S#272 the
derivation is a race between the newest `answer` and the newest `reopen` for
that id, compared by `seq`** (see #21); it is no longer "any answer closes it".
The rule lives in `lib/question-state.ts` and is shared with the UI — do not
re-derive it anywhere else (#24).

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
**S#276 REWROTE THIS, because counting calls was measuring the wrong noun and
measuring it backwards.** Measured on production: an empty wait returns ~155 B,
a status ~1,220 B, one real answer ~8,400 B. A consecutive-count brake fired on
the CHEAPEST operation after three calls and never on the dearest — and its
refusal pushed a caller off `wait` and onto `status` at ~8x the bytes, so the
brake *increased* far-side spend. It also killed the feature standing behind it:
a listener IS a run of empty waits, so any wake mechanism built on it shipped
born-dead exactly when the partner was slow.

So the brake is now denominated in **wasted bytes** (`WASTE_KEY`,
`WASTE_BUDGET_BYTES` = 12,000). Every response that teaches the caller nothing is
charged its own JSON length; anything informative, and any write, clears the
debt. The cost asymmetry then does the weighting with no per-operation ceilings.

Two refinements that are load-bearing rather than tuning:

- **Blocked calls are charged at 10%** (`BLOCKED_CALL_DISCOUNT`). Context is
  spent per TURN; a wait that blocked 45s spent wall clock and cannot be in a
  tight loop. Without this, one budget would have to be generous enough for an
  overnight listener and tight enough to stop a spinner — impossible when the
  payloads are ~8x apart and the behaviours ~600x apart. Measured live: 12
  blocked waits cost 304 B of 12,000.
- **"Informative" means "not previously served"** (`SERVED_KEY`, a server-side
  high-water mark). A client whose cursor never advances is re-served the same
  entries instantly, forever — every response looked informative, so the budget
  reset every time and the brake went blind to the most expensive loop in the
  product. The caller's cursor cannot be trusted for this, because it is exactly
  what is stuck.

`MAX_EMPTY_WAIT_STREAK` (3) and `MAX_IDLE_STREAK` (6) still exist and still drive
the *graduated guidance*, which demonstrably works — a real far-side agent
stopped on the advisory wording without ever reaching a refusal. They no longer
terminate a waiter.
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

**21. A question is open until the ASKER says otherwise.**
It used to close on the first entry referencing it and stay closed, which made
the open-questions list optimistic: every half-answer and misunderstanding read
as resolved, and the one party who knew better — the asker — had no way to say
so. `openQuestions` now races the newest `answer` against the newest `reopen`
for that id, **compared by `seq`**, not by timestamp: `seq` is monotonic per
room, so it does not depend on two companies' clocks agreeing. `bridger_reopen`
is guarded to the asking side, because a side that could reopen its own answer
would make the signal meaningless.

**22. A sign-off is cleared by any write, deliberately.**
`bridger_signoff` exists because "I am done for today" is the honest answer to
nearly every situation the idle brake exists for, and without it a partner's
agent has to INFER silence, get braked, and report a guess. It is cancelled
automatically by the next write of any kind — **being back IS the signal**. A
sign-off you have to remember to cancel is one that will be wrong, and a stale
"they are away" is worse than no signal at all.

**23. Purge needs both sides, and cannot reach the copies.**
The ledger is a joint record: one side deleting it destroys the other's account
of what was asked, answered and decided — which is what they may need most when
a relationship ends. So the partner consents via `bridger_purge` and the
operator consents and executes via the CLI; neither can finish alone. Keys are
ENUMERATED rather than scanned, because a purge that can glob is a purge that
can over-delete. **It removes the server's copy only** — `bridger pull` folders
on both sides, usually committed, are out of reach, and any deletion promise
has to say so.

**24. A rule the UI also needs must be SHARED, or it inverts silently.**
`app/page.tsx` carried its own copy of "is this question answered":
`entries.filter(e => e.answers)`. Correct for months — until `reopen` entries
existed, because a reopen carries `answers: <questionId>` too. From that commit
on, the page rendered every REOPENED question as ANSWERED: not a crash, not a
blank, but **the opposite of the truth in the one panel a human reads to decide
whose turn it is**. Measured on a seeded bridge: the shared predicate found one
open question, the page's copy found none.
The copy existed because of a real constraint (client component, see the file
map), so the fix was to give the rule a home neither side has to reach around —
`lib/question-state.ts`, zero imports. **A second copy of a rule is not a
duplication problem; it is a correctness problem with a delay on it.**

**25. `ask` is not a gate in this harness — only `deny` is.**
Not a Bridger fact, but it governs what Claude can ship from here, and it cost a
wrong explanation before it was measured. `settings.json::permissions.ask` and a
hook returning `permissionDecision: "ask"` are AUTO-ACCEPTED in this session's
permission mode: force-push ran straight through with `ask` set in *both*.
So the honest ladder is **`deny` = gate, `ask` = depends on the mode, prose =
hope** — and the only way to know which you have is to RUN the command and watch
it fail. S#272: push and `vercel deploy` are now allowed-and-logged, `npm
publish` and force-push are denied. Rule: `shipping-quality#3`.

### 26. Our tool schemas are billed to the CALLER, forever, used or not (S#274)

Bridger calls no LLM, so the cost lands entirely on the other side — and not
only per call. Every tool schema published sits in the caller's context on
**every one of their turns**. Measured from source: the full 11-tool surface is
**~1,800 tokens standing**, per turn, whether or not a tool is used.

That reframes what "expensive" means here. Answering one question used to take
three turns minimum — `wait` returns entries but not open questions, so knowing
*what* to answer needed a second call — and each of those turns paid the full
schema again. The dominant cost was the **surface**, not the call count.

The fix was therefore a deletion, not an addition: the `answerer` role is shown
two tools and has nothing to probe with (~318 tokens). **A `bridger_ping` tool
added to the existing eleven would have made this worse, not better** — which is
what measuring first caught, and what reasoning about it had got backwards.

### 27. Registration is module-level and auth-blind, so `tools/list` is filtered by handler choice (S#274)

`createMcpHandler`'s builder runs once at import, where no token exists;
`withMcpAuth` attaches the caller later, and tools read it at call time from
`ctx.http?.authInfo`. So a per-caller tool list cannot be produced from inside
the builder.

Two handlers are built over the **same** `lib/operations.ts`, and `gated()`
picks between them — it is the only place that has already resolved the token
*and* still controls dispatch. No JSON-RPC rewriting, no second URL, no forked
rule set. `instructions` is narrowed for the answerer too: it ships as standing
context exactly like the schemas do.

### 28. `checkedAgainst` is classified, and the classifier grades the STRING (S#274)

`lib/citation.ts` turns a citation into a kind (`line` / `range` / `file` /
`command` / `commit` / `unlocated` / `none`) and a line count. Surfaced as
`checkedSpan` on the wire, a badge and a "thin citations" stat in the UI, and
`✓`/`◐`/`?` in `bridger log`.

The derived fields carry **no far-side text** — they come from our own regex —
which is why they are safe to read without containment while the raw string
beside them is still contained.

It exists because S#271 audited two partner citations by hand and found one
covered 70 lines while barely touching the claim: over-broad, not fabricated,
and invisible in the product. Both are now regression fixtures.

**A test asserts no label ever emits a verdict word** (`good`, `weak`,
`verified`, …). That guard is the feature: a quality score derived from a regex
is a confident number, and a confident number gets trusted.

### 29. Hiding a tool is a cost optimisation and has never been a gate (S#274)

An `answerer` is shown two tools purely to save the caller schema tokens. It is
a full participant at the operations layer, and the ablation test asserts *both*
halves — an answerer may still perform an operation its tool list does not show,
and a viewer is still refused by that same operation. If the first assertion
ever starts failing, a permission has been smuggled into a cost optimisation and
the tool list has silently become a boundary nothing else enforces.

---

### 30. The mint route must check the kill switch itself — every other route gets it free

`authorize()` checks `KILL_SWITCH` for every authenticated request, so twelve
tools and four endpoints inherit the panic button without knowing it exists.
`POST /api/rooms` has **no token to authorise**, so it inherits nothing. Without
its own explicit check, `bridger stop` would refuse every existing room while
cheerfully minting new ones — the panic button failing open on the one path that
creates work. Any future unauthenticated route has the same hole by default.

### 31. Two-ness is a property of a TRUST room, not of Bridger — REVISED S#281

**It used to be both, and the distinction is the whole of solo mode.**

The original fact read: `SideId = "a" | "b"`, `otherSide()` is a boolean flip,
`sides` is a fixed-shape object, "the peer" is singular in `whoami`, the wait
cursor and the idle brake — so N parties is a rewrite of the core. All of that
was accurate, and it made a real limitation of the CODE look like a statement
about the product.

S#281 did the rewrite. Seats are `a`..`f`, `otherSeats()` returns a list, and
`sides` is a partial record. What did NOT change is what a `trust` room MEANS:
two companies who do not share an employer, keeping a record neither can
rewrite. A third COMPANY still brings semantics that do not exist (does an
answer close a question for *everyone*? who does a contract bind? does the room
need every party to sign off, or one?) — so `SUPPORTED_SLOTS = 2` stays, and its
refusal now points at solo mode rather than claiming a rewrite is needed.

**The create screen no longer shows disabled buttons with a reason.** It shows
two room KINDS, because the choice is real now. A control that does nothing,
twice, and then apologises was the honest version of a limitation; it is not the
honest version of a choice.

**And the containment follows the kind, not the seat count.** A `solo` room
wraps nothing in untrusted-partner markers: one operator's own models are not
another company, and a marker that fires where nobody needs protecting teaches
the reader to skim past it in the room where it is load-bearing.

### 32. A quota REFUSAL burns a slot; a VALIDATION failure must not

`chargeMint` increments atomically *before* deciding, so a refused attempt still
costs — otherwise the boundary can be probed for free. But the first build also
charged before validating the form, so an empty label or an over-long topic
burned one of the day's three rooms. **Measured, not reasoned:** the live counter
read 3 with only two rooms in existence. Two typos and an honest person is locked
out until midnight UTC. Validation now runs first and costs nothing; the sanitiser
runs twice (once to validate, once inside `createRoom`) rather than passing
cleaned values back in, which would risk double-escaping the containment markers.

### 33. `parseEntry` rebuilds entries field by field — anything unnamed is silently dropped

It does not spread the stored object; it constructs a new one. So a field added
to `Entry` and written by `appendEntry` will be **erased on every read** unless
`parseEntry` is updated too. This bit the hash chain immediately: entries were
written with `hash`/`prevHash`, stripped on read, and the verifier reported
`unchained` while looking perfectly correct. Written-and-invisible is worse than
never written, because the failure renders as a legitimate state.

### 34. IPv6 must be counted by /64, or the limit does not exist

A residential ISP hands one customer a /64 at minimum — 18 quintillion addresses,
often a /56 or /48. Counting exact v6 addresses is therefore identical to having
no limit at all for anyone on a modern connection, while v4 users get the real
cap. The asymmetry is **invisible in testing** (a laptop on v4 watches the limit
work perfectly) and total in production. Same trap applies to any future
per-address counter.

### 35. The rate limit and the poll interval are one system, and they collided

A 3-second poll is 20 requests a minute. `RATE_LIMIT_PER_MINUTE` was 20. The UI
therefore ran permanently ON the ceiling and the first extra call — the `whoami`
on mount — tipped it into `429`. And `setInterval` has a fixed period, so a
rate-limited tab re-earned its limit every minute and **could never recover**
without a manual reload. Three fixes, all needed: viewers get their own ceiling
(60/min — they cannot write and call no model, so the agent-loop reasoning behind
the 20 does not apply), the poll is 4s, and the loop is a self-rescheduling
timeout with backoff. **Whenever either number moves, check it against the other.**

### 36. A credential-shaped test fixture is a real problem for a public repo

GitHub push protection blocked the first publish, citing a Stripe key in
`lib/__tests__/secrets.test.ts` — our own secret scanner's test fixture, fake
since the day it was written and realistic enough to trip GitHub's detector. That
is inherent to testing a secret detector. Fixtures are now **assembled from
fragments at runtime** (`j("sk", "_live_", "…")`) so no credential-shaped literal
exists on disk while the value reaching `scanForSecrets` is byte-identical.
Clicking GitHub's "allow this secret" was rejected: a repo whose pitch is *audit
me* cannot carry strings that light up an auditor's tooling.

### 37. Raw control bytes in source make a file binary to `grep`

Four files in S#275 shipped raw NUL or bidi characters where escape *text* was
intended — including `lib/chain.ts`, where a NUL sat inside the hash input. It
worked (NUL is a fine domain separator) but it made the hashing function
unreviewable by `grep`, in the one file whose entire purpose is being auditable.
**Write character classes as numeric code points** (`STRIP_RANGES` in
`room-text.ts`) and build hostile test fixtures with `String.fromCodePoint`. A
regex of invisible characters cannot be reviewed by anyone, including its author.

### 38. The wire is a 3D projection, and every "2D field" fix is wasted work (S#277)

`app/wire.tsx` is not a dot lattice with displacement. It is a horizontal plane
receding to a horizon, with points projected through a pinhole camera:

    s  = focal / z
    sx = cx + x * s
    sy = horizonY + (camY - y) * s

Four independent things carry the depth: rows compressing toward the horizon,
size falling off as `1/z`, distance fog, and the wave's SCREEN amplitude
shrinking with distance so near crests are tall and far ones are a ripple.

The consequence for anyone editing it: **`band` is `[horizon, near]`, not a
region to fill, and the plane spans the full width at every depth by
construction.** The closing band on the gate was once "chopped off at the
bottom-left" precisely because it was a 2D field whose coverage depended on its
lattice rather than on the viewport.

Three earlier versions were flat and none of them could be tuned into this one.
If it looks wrong, ask what the camera is doing before changing a constant.

### 39. Rows are spaced in SCREEN space, because even-in-z leaves holes at the front (S#277)

Screen row spacing under perspective goes as `camY*focal/z^2`. Spacing rows
evenly in `z` — the obvious way — put the nearest rows ~120px apart while the
horizon stayed solid: dense at the back, gappy at the front. Rows are now placed
evenly in screen space and the depth solved by inverting the projection
(`z = camY*focal/offset`), with a mild exponent retaining some horizon density.

**`pitch` controls COLUMNS.** Lowering it cannot fix a foreground gap, which is
exactly the wrong turn this note exists to prevent.

### 40. Per-frame `rgba()` strings, not fill count, are what costs frames (S#277)

Adding one halo rect per point took the hero from 68fps to 37. The extra
`fillRect` was not the cost — composing two `rgba()` strings per point per frame
was, at roughly 40k allocations and 40k CSS colour parses per frame. A point's
alpha is `intensity * fog` and both are fixed at build, so the string never
changes; precomputing `fill` and `halo` per point restored 60fps with the halos
still in place.

The general rule for this canvas: **anything that does not change between frames
belongs in `build()`.** `getComputedStyle` is already there for the same reason.

### 41. The canvas resolves its palette in `build()`, so a theme flip needs a listener (S#277)

Colours are read from CSS custom properties inside `build()`, and `build()` runs
on resize. Without an explicit `prefers-color-scheme` listener, toggling the OS
theme left the field painted in the previous scheme until something happened to
resize the window. Invisible when every dot was one grey; obvious once each dot
carried its own hue.

The additive-glow switch is decided from the DOT COLOURS' luminance rather than
from a media query, so it follows whatever the page's tokens actually are.
Additive compositing on a light surface paints dark dots toward the paper and
erases the field.

### 42. Two canvases on the gate, and both are idle most of the time (S#277)

The hero and the closing band are separate `Wire` instances. Each stops on
`visibilitychange` and on leaving the viewport via `IntersectionObserver`, so the
closing band costs nothing until it is scrolled to.

**This produces a screenshot artifact that looks exactly like a bug:** a
`fullPage` capture keeps the original viewport, so the closing band never
intersects, never starts, and captures blank. Verified by re-capturing at a
1900px viewport. Separately, Chrome CLI `--virtual-time-budget` captured the hero
blank while a direct canvas probe found 308,233 non-zero pixels — use puppeteer
for anything involving this component.

### 43. Fonts are a BUILD-time network dependency now (S#277)

`next/font/google` downloads Instrument Sans and Azeret Mono at build and
self-hosts them, so there is no runtime third-party request — which is the point,
on a page read by people deciding whether this domain deserves a credential. The
trade is that **the build now needs network access to Google Fonts.** An offline
or network-restricted build will fail here, and the fix is `next/font/local` with
the files vendored.

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
11. **Two transports, one set of rules.** Every guard — viewer gate, idle brake,
    containment — lives in `lib/operations.ts`, never in a route. A rule added
    to one adapter and not the other is a fork, and the drift is silent.
12. **A refusal that the caller can fix must not be shaped like STOP.** The
    credential refusal says retrying works, because it does. Reusing the
    loop-ending vocabulary for a one-edit problem makes a well-behaved agent
    abandon a task it could finish.
13. **A narrowed tool list is never a permission.** Roles may hide tools to save
    the caller tokens; every refusal still lives in `lib/operations.ts`. The
    moment hiding is the only thing preventing an action, it is a fake gate —
    and a fake gate is worse than none, because it is trusted.
14. **Nothing in this codebase may score whether a claim is true.** It may
    describe evidence — a span, a kind, a count — and stop there. Judging
    whether a citation supports its answer requires reading both, which requires
    a model, which puts an LLM in the trust path of the one product whose whole
    pitch is that it calls none. That is invariant 1 seen from the other side.
15. **Instructions we hand a partner must be runnable as written.** The answerer
    handoff shipped `npx bridger join …` for a CLI that is not on npm; it would
    have fetched an unrelated package and passed it a live token. Anything
    printed for the far side is a spec someone follows — route it through
    `joinCommand()` rather than hand-rolling a second copy beside it.
