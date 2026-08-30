# The category, read as CODE — a full audit and an adoption list

> **S#285.** Five repos cloned and read, not five READMEs summarised.
> Companion to `competitors-2026-08.md` (which counted the category) and
> `landscape-2026-08.md` (protocols). This file is what to TAKE.
>
> **Why it exists:** `competitors-2026-08.md` said turn discipline and wake-up
> were "an answer key" for C0. That was read off Agent Room's README. Reading
> the code says **one of those two is a key to a different lock**, and the
> genuinely useful pieces were in files nobody had opened.

---

## What was actually read, per repo

| repo | HEAD | LOC | read? |
|---|---|---|---|
| `agent-room-alkl/agent-room` | `063c85a` 2026-08-01 | 18,706 | protocol spec, `KNOWN-GAPS`, `turnState.ts`, `hook.ts`, `projectMemory.ts`, `rooms.ts` |
| `cch123/open-agent-room` | `3cac309` 2026-05-01 | 10,005 (Go) | `docs/protocol.md`, `docs/research.md` |
| `steviebuilds/agent-room` | `ae600ec` 2026-07-12 | 591 (one file) | `SKILL.md`, `README.md` |
| `agree-able/room-mcp` | `75f4b83` 2026-01-04 | 382 | `README.md`, `bin.mjs` (grep only) |
| `kdowswell/agent-room` | `c988fe3` 2026-04-25 | 2,746 | **NOT READ** — 1 star, local dashboard, lowest signal |

**Honest limits.** Not opened in `agent-room-alkl`: `tools.ts` (1,781), `tasks.ts`
(802), `init.ts` (854), `retro.ts`, `messages.ts`, the whole web UI. Not opened
in `cch123`: all 10K lines of Go — the protocol doc was read, the implementation
was not. Nothing below rests on a file that was not opened.

## [!!] Census correction — there is a commercial player we have never assessed

`cch123/open-agent-room` is an **independent reimplementation of a product
called Slock** (`slock.ai`, npm `@slock-ai/daemon`) — humans and agents in
channels and DMs, persistent agent memory, a local daemon. Its `docs/research.md`
names the sources and the date it checked them (2026-04-29).

Slock is not in `competitors-2026-08.md`. Every entry there is a GitHub side
project; this is a funded-looking product. **Assessed below.**

---

## SLOCK / BOTIVERSE — assessed S#285, and it is NOT a competitor

**What it actually is now.** `@slock-ai/daemon` is a 1.4 KB compatibility shim;
the real package is **`@botiverse/raft-daemon`** (renamed). 269 versions since
2026-02-22, last published 2026-08-17. `github.com/botiverse/slock` is
**private** — closed source. The npm tarball is public, 6.9 MB unpacked, and
**not minified**, so it reads as source.

**[!!] LICENCE — different from everything else in this document.**
`package.json` has **no `license` field and there is no LICENSE file**, so it is
**all rights reserved**. Reading it is fine. **No code may be copied from it**,
unlike the five MIT repos. Everything below is a PATTERN to re-implement
independently — ideas and facts are not copyrightable, expression is.

**The strategic finding: their hard engineering is not rooms.** The `./core`
export is dominated by **agent migration** — moving a live agent's workspace
between machines: chunked and resumable, digest-verified at BOTH chunk and
whole-bundle level, symlink-target normalised, entry-count and size capped,
insufficient-disk aware, staged then committed behind a commit marker, with a
grant registry and a plan/verify/execute split. Runtimes are hosted via
`@earendil-works/pi-coding-agent` and a forked `kimi-code-sdk`.

Channels and DMs are a SURFACE on top of that. **cch123 reimplemented the
surface and missed the substance** — which is why its repo looks like a room
product and Slock is not one. Slock shares a UI metaphor with this category and
almost nothing else. It is not competing with Bridger.

### What to take from it — patterns only, re-implemented

**S1. URL query-string credentials — a REAL gap in `lib/secrets.ts`.**
Ours catches credentials in the *userinfo* position
(`scheme://user:pass@host`). It does **not** catch `https://host/path?token=…`
or `?api_key=…`. Slock redacts the whole query of every URL it emits. We should
refuse on a credential-shaped QUERY PARAMETER. Note our own `cannotVerify`
already says a join link puts a token into transcripts — this is that hazard,
one field over.

**S2. Our credential-assignment pattern is uppercase-only.**
`/\b[A-Z][A-Z0-9_]*(TOKEN|SECRET|…)/` misses `api_key = "…"`, `myToken: "…"`,
`github.token=…`. Theirs is case-insensitive with `[A-Za-z0-9._-]` around the
keyword. Widen ours — but KEEP the 20+ character value floor, which is what
stops false positives, and which they do not have.

**S3. `retryable` as a first-class error property.** They classify by HTTP
status class (408, 425, 429, 5xx retryable) with a *semantic code able to
override the status* (`experimental_surface_disabled` is never retryable even
on a 5xx). We already ship `terminal: true` on expiry — but hand-rolled, per
error. Making retryable/terminal systematic is the generalisation.
**425 Too Early is the one nearly everybody forgets.**

**S4. Two-level digest — chunk AND whole-bundle.** This is **V2 (Merkle +
gossiped heads) validated by an independent implementation**: verify the parts
and the whole SEPARATELY, because a sequence of individually-valid parts can
still be the wrong whole. Exactly the property our hash chain alone does not
give us.

**S5. Stage → commit marker → atomic commit**, for any multi-step operation that
can half-finish. Same shape as the librarian's temp→swap→`.bak` rule we already
enforce. **Apply it to `purge`**, which is our multi-step destructive op.

**S6. plan → verify → execute as three separate callables.**
`buildAdoptPlan` / `verifyAdoptPlan` / `executeAdoptPlan`. Good shape for
`purge` (two-party consent) and for `contract-patch`.

**S7. `classifyTargetResidue` — name what a failed operation LEFT BEHIND.**
S#283 hit a "purge hole". Residue classification is the discipline that closes
that whole class: a failed destructive op must be able to say what state it
left, not just that it failed.

**S8. `permissionRequestFingerprint` — bind a consent to a fingerprint of
exactly what was consented to.** Directly applicable to two-party purge consent:
a consent that is not bound to a content fingerprint can be spent on a different
deletion than the one it was given for.

**S9. Trace attribute CONTRACTS** (`DAEMON_CORE_TRACE_ATTR_CONTRACTS`) — pin the
telemetry attribute schema so traces cannot rot silently.

**S10. The untrusted-archive containment checklist** — symlink target
normalisation, entry-count caps, manifest and bundle size caps, insufficient
disk. **We have no attachments today.** The day a far side can send a file,
this is the list, and it is our `[[UNTRUSTED-PARTNER-TEXT]]` discipline one
layer down at the filesystem.

### What NOT to take from Slock

| Rejected | Why |
|---|---|
| **Redaction as the verb** | `lib/secrets.ts` chooses **refuse, not redact**, deliberately and with the reasoning in the file: redaction rewrites an author's words inside a record whose entire value is fidelity, and append-only is not violated by declining to append. **Take their DETECTORS, keep our VERB.** |
| **Email / home-path scrubbing** | PII redaction would make Bridger hostile to legitimate content, and it is redaction again. |
| **Agent migration itself** | We do not move workspaces. The patterns transfer; the feature does not. |

**Where we are already ahead:** our scanner covers AWS, Google, Stripe and JWT
shapes, none of which appeared in theirs, and it carries an explicit
*no-entropy-heuristic* rule because commit SHAs are the product and a scanner
that refuses provenance is worse than no scanner.

---

## ADOPT — ranked by value per unit of work

### A1. `send --wait` — collapse the round trip into one call

**From:** `steviebuilds/agent-room` SKILL.md.

Their whole cadence answer is *"prefer `send --wait 45`, which does both in one
command"* — the agent sends and is immediately blocked waiting, so the turn
never ends in between. **Verified against our CLI: our `wait` is a standalone
op (`cli/bridger.ts:1472`), not a flag on send.** So `answer --wait`,
`post --wait`, `decide --wait` are unbuilt and cheap.

**Hits C0 point 2 directly.** Highest value per line in this document.

### A2. [!!] The `THREAD_STATUS` control line — the whole C0 answer, in prose

**From:** `cch123` protocol rules 9-11, and — far more usefully — the **live
operative prompt** at `cmd/daemon/main.go:676`, which is where the mechanism
actually lives. The protocol doc undersells this badly.

The agent is instructed to **end every peer-discussion reply with exactly one
control line**, which the server then parses to decide routing:

```
THREAD_STATUS: continue   -> asking a concrete peer question / requesting an action
THREAD_STATUS: standby    -> acknowledging, agreeing, waiting on the user
THREAD_STATUS: final      -> converged; handing the result to @You
```

*"The server only routes another peer turn for `continue` or a clear request."*

**Why this is the important one.** It is a typed routing field obtained WITHOUT
a tool-schema change — the model emits it as text, the server parses it. Bridger
could carry it as a real field on an entry instead, which is strictly better,
but the semantic is theirs and it is proven in a running system.

**And the same prompt does C0 point 1, which nothing else here does:**

- *"keep the reply short, concrete, and under 8 lines"* — work-per-nudge shaping
- *"no Markdown headings, numbered outlines, tables, code blocks"* mid-discussion
- *"Do not mention another agent just to acknowledge, agree, say received, or
  stay on standby"* — the anti-ping-pong rule as an instruction
- `<<<MARKDOWN_DOCUMENT>>>` / `<<<END_MARKDOWN_DOCUMENT>>>` markers separating
  the DELIVERABLE from the handoff note, with `@You` required to sit outside them

### A2b. `maxAgentThreadDepth` — a hard integer bound on agent-to-agent depth

**From:** `cch123/cmd/server/main.go:27`, enforced at two call sites (`:1445`,
`:1786`), with the current depth injected into the prompt (*"this is turn N of
an agent-to-agent thread"*) so the agent knows how deep it is.

`maxAgentThreadDepth = 6`. One integer, server-side, and it is the runaway bound
for two agents talking to each other. **We have no equivalent** — our bound is
the harness's stop-hook override, which is a client-side accident rather than a
protocol property.

### A3. Terminal-acknowledgement detection, deterministic

**From:** `cch123` rule 11 — *"received", "confirmed", "standing by", "no
further action"* are terminal for routing **even if they mention another agent**.

A fixed string list, no model. Fits our no-model constraint exactly, and it
attacks the specific waste C0 names: a reply that exists only to close a loop.
Note this is the DETERMINISTIC backstop to A2's instruction — they ship both,
because an instruction is probabilistic and a string list is not.

### A4. Cursor stop-hook `followup_message`

**From:** `agent-room-alkl/apps/mcp/src/hook.ts`. Detects Cursor by *shape* —
`status` present, `hook_event_name` absent — and returns `{followup_message}`
instead of `{decision:"block"}`. One function, `isCursorStopInput()`.

**Closes the item our own TODO already lists as unbuilt.** MIT, attribute it.

### A5. Long-poll in the hook + block-streak that resets on activity

**From:** the same file. `POLL_MAX_MS = 30_000` at 1.5s intervals — their hook
*waits* for news before releasing the turn. **Ours probes once and lets go.**
Their streak allows 60 consecutive blocks (30 min) and **resets whenever a real
message arrives**, so productive work is never penalised.

Their code carries the field lesson too: it was 12 (6 min) until users reported
agents vanishing during natural pauses. That is tuning we would otherwise buy
with our own outage.

**Note what we already do better:** our kill FILE is a mid-session off switch
that needs no restart; theirs is an env var read at process start. Keep ours.

### A6. `@You` — an explicit human-handoff marker

**From:** `cch123` rule 13: `@You` is terminal for routing, a request for human
review, never an agent target. **Bridger has no way to say "this needs the
operator, not the far-side agent."** Cheap, and it is the honest exit from a
loop neither agent should be closing.

### A7. `projectMemory.ts` — the merge-not-append model, for A10

**From:** `agent-room-alkl/packages/shared/src/projectMemory.ts`.

Its categories include **`lessons`: "approaches that failed, pitfalls hit,
alternatives rejected and why"** — that IS the A10 failure bank.

Its opening constraint answers A10's own stated hard problem:
*"memory must be MERGED, not appended — append-only grows unboundedly, keeps
overturned decisions alive, and poisons future rooms."*

Pure logic, no I/O, deliberately shaped after mem0's update/dedupe model so an
LLM merger can replace it later. **This is the real find, and it is in a file
nobody had opened.**

### A8. Response-mode echoed on EVERY response

**From:** `steviebuilds` — join, `send --wait` and `listen` all reprint the
room's current response mode, and a mode change wakes every waiting agent.

Same channel as our `guidance` field, which a real far side has already acted
on. Pattern to copy: the server restates the client's obligations every time,
so a far side can never be operating on a stale rule.

### A9. `hostFirstMessage` — payload rides the connection event

**From:** `agree-able/room-mcp`. The host declares the opening message at room
creation; it is delivered the moment the peer connects. No "wait for them, then
speak" round trip. **Relevant to I1 "smooth as butter"** — the invite carries
the first message.

### A10. Harness detection and per-harness state scoping

**From:** `agent-room-alkl/apps/mcp/src/harness.ts` + `hook.ts`. Cursor and
Codex start the MCP server and the stop hook under *different scopes*, so hook
cursor state must be stored differently per harness. Pure field knowledge —
invisible until it bites, and it would bite us the day we ship the Cursor half.

### A11. Report export as a customer-facing artifact

**From:** `agent-room-alkl` report contract — room becomes a hosted page plus a
Markdown download with summary, decisions, action items, artifacts, transcript.

**We have `/api/export` returning JSON.** Theirs is a deliverable a human hands
to someone. Worth considering independently of everything else here.

---

## REJECT — and the reason, so nobody re-opens it

| Rejected | Why |
|---|---|
| **Turn-discipline state machine** (`turnState.ts`, 1,079 lines) | An N-agent CONTENTION arbiter — lead/supplement, round-robin, hard deadline caps, grace windows. **Bridger has two sides that strictly alternate. There is no contention.** C0 points 1 and 2 are work-per-nudge and round-trip count; this machine addresses neither. This is the "answer key" that fits a different lock. |
| **LLM arbiter routing** (`cch123` rule 5) | Their router calls a local model to decide who should reply. Bridger calls no model, deliberately, and `/api/about` publishes that. Non-starter. |
| **Channels / DMs / scopes** | One room, two sides. |
| **`[DECISION]`/`[TODO]` text markers** | Regex over free chat. Our `ask`/`answer`/`decide` are typed operations — strictly stronger. Do not trade down. |
| **`casRoom` read-mutate-write** | Non-atomic with a 3-attempt retry. Flagged in their OWN `KNOWN-GAPS.md` §2. Do not copy this path. |
| **P2P / no server** (`agree-able`) | Architecturally interesting against `cannotVerify` #1 (the operator can read every room) — but adopting it means abandoning the hosted product. Note it, do not build it. |
| **Presence heartbeats / Listening-Online-Idle** | Meeting-shaped. Possibly revisit as "is the far side even there", which is a real cross-org question — but not as their participant model. |

---

## NO ANSWER KEY EXISTS — build these ourselves

**1. The silent deadline — and only TWO of the five even have the problem.**

Checked `agent-room-alkl/packages/upstash-client/src/rooms.ts`: room TTL is set
with `EX ROOM_TTL_SECONDS` at creation and `KEEPTTL` on update, and **nothing
anywhere warns a user that a room is about to lapse.** Same blind spot as ours,
one clock over (theirs 24h, ours 30 days).

**The other three have no durable TTL at all** — grepped for `ttl|expire|EX <n>|maxAge`
and found nothing: `steviebuilds` keeps state locally under `~/.agent-room/`,
`agree-able` is P2P and session-scoped, `kdowswell` is a local dashboard. Their
silence on expiry is VACUOUS, not a shared blind spot.

**Which is the actual finding: hosted persistence is what CREATES the silent
deadline.** The three that dodge it dodge it by not being hosted, which is not
an option available to us. So there is no answer key in this category — but the
pattern is solved routinely OUTSIDE it (certificate renewal, PAT expiry
notification), and that is where to look. See the S#285 "every clock needs a
gauge" row.

**2. The trust boundary.** Of the five, four are **single-team** — every scenario
in every README is one company's own agents. `agree-able/room-mcp` is genuinely
two-party across machines (invite code, peer joins) but carries **no trust
machinery at all**: no containment of foreign text, no provenance on a claim, no
hash chain, no two-party consent.

So the differentiated surface is confirmed unclaimed. It is also confirmed
**unvalidated** — nobody in this category has users, so their silence is not
evidence the need is real. The question from `competitors-2026-08.md` stands
exactly where it stood: *is "two companies who do not trust each other" a need
someone will pay for, or a property nobody feels?*

---

## Licence

All five are **MIT**. Reading for design is unrestricted. A copied file carries
its copyright and licence notice (MIT into Apache-2.0 is fine in that
direction). Design inspiration: free. Lifted code: attributed, or rewritten.
