# DECISIONS

Append-only, newest first. **DECISIONS wins on direction** — where this file and
`STATUS.md` or the code disagree about *intent*, this file is right.

---

## 2026-08-12 — S#271 — THE INCIDENT: a bridge is a feeding tube for a loop

**Source:** Erik — *"The bridge is burning consumption on Gemini, there is no
'stop' and wait feature so it burned through my whole consumption."*

**What happened.** Antigravity entered an agent loop: call the bridge → get
content → reason → call again. Every reply was cheap for us and expensive for
him, because the tokens burn in the *caller's* session. Our own numbers looked
fine throughout.

**The four things that made it possible, and one of them is a regression:**

1. **Rate limit was 120/minute** — 7,200 an hour. Not a limit, decoration.
2. **No daily cap.** `key-registry.ts`, the file this registry was *ported*
   from, has enforced `dailyCap` in production since S#266. The port dropped it
   while the DECISIONS entry claimed the properties were taken wholesale
   "because those were each learned from a real incident". They were. The one
   that bounds consumption is the one that went missing.
3. **Every refusal was a generic 401.** `withMcpAuth` can only answer yes or no,
   and to a looping agent one fixed string reads as *"try again"* — the worst
   possible reply, because it buys exactly one more turn, forever.
4. **`bridger_wait` answers "nothing yet" honestly**, and an agent reads that as
   a reason to wait again. A poll loop wearing a tool call.

**And the thing Erik actually named: there was no stop.** The kill switch
existed in code and could only be thrown with a hand-written Redis call. **A
safety mechanism that requires improvisation during an incident is not a safety
mechanism.**

### Decisions

1. **`bridger stop` / `bridger start` are first-class commands.** The Redis
   switch, not the env one: checked before anything else on every request with
   no cache in front of it, so it lands on the next call and needs no redeploy.
2. **`dailyCap` restored**, default 400/day per token. A missing value resolves
   to the default, never to infinity — an un-capped token *is* the bug.
3. **Rate limit 120 → 20/minute.** A human-paced integration makes single-digit
   calls a minute; 20 allows a burst of catch-up reads and stops a loop in
   about three seconds.
4. **A budget gate in FRONT of auth**, returning a JSON-RPC error whose message
   opens with `STOP.` and states that retrying cannot succeed, plus
   `data.terminal`. `no-token` / `unknown-token` still fall through to the
   standard challenge — no reconnaissance for the unauthenticated, and MCP
   clients need the real `WWW-Authenticate` to negotiate.
   `authorize()` gained `charge: false` so the gate and `verifyToken` cannot
   both spend one request's allowance.
5. **`bridger_wait` counts consecutive empty waits**; past three it refuses with
   `STOP WAITING` and tells the agent to report rather than poll.
6. **`/api/health` reports both kill switches.** It checked only the env one, so
   during the incident — stopped via Redis — it answered `healthy: true,
   killSwitch: "off"`. A diagnostic is consulted precisely when something looks
   wrong; one that reports "nothing is wrong" then is worse than absent.

### The honest limit, stated so it is not rediscovered

**Bridger cannot cap another model's spend.** Those tokens burn in the caller's
loop, in their session, under their quota. All we can do is stop feeding it and
refuse in words an agent treats as final. If that agent loops on something else,
none of this helps.

### The miss worth recording

`triplemind/ARCHITECTURE.md` Problem 2 — *"`--yolo` Mode Is Dangerous… no
`--max-turns` equivalent limits how long it runs"* — describes this exact loop,
written in February 2026. **It was read this same session**, cited as evidence
that Bridger was structurally safer than TripleMind because it owns no agent
lifecycle. That reasoning was correct and incomplete: not owning the loop does
not mean not *feeding* it. The generalisation: **when you inherit a prior
project's failure list, check each entry against what you are building, not
against what you are replacing.**

---

## 2026-08-12 — S#271 — Token roles: viewer vs participant

**Source:** Erik — *"what does OpenWork offer which would just make sense to
have in our project?"* Their line is *"auth, roles, and policies applied on the
way through."* Taken because it closes a hole we opened the same afternoon, not
because a competitor has it.

**The hole.** The web view had no token of its own, so watching a bridge meant
pasting a **participant** token into a browser tab — and anyone seeing that
screen, or that tab's storage, could then post as that side. The UI made
authorship cheap to steal, and the UI is precisely the reason a token ends up
somewhere visible. Introduced by the same change that added the view.

**Decisions:**
1. `TokenRecord.role: "participant" | "viewer"`. A viewer authenticates and
   reads — it *should* read — so the gate is per-tool, not at the auth layer.
2. **One `writableBridgeFrom()`**, not a check copied into five handlers. The
   copies are what drift (S#268: one prompt-rule text in three copies silently
   degraded three different things).
3. `bridger_contract` splits by intent: reading it is a viewer's right,
   replacing it is not.
4. `bridger_status` reports `role` and `canWrite`, so an agent learns its limits
   up front rather than by being refused mid-task.
5. **`rotate` revokes participants only.** Rotating a leaked working token must
   not silently blind an unrelated watcher — that is a separate decision and it
   belongs to whoever makes it deliberately. `revoke` without a filter still
   kills everything on the side.
6. **A missing or corrupted `role` resolves to `participant`.** Only the exact
   string `"viewer"` restricts. Every token minted before roles existed keeps
   working; a missing field must never downgrade a partner mid-integration.

**Verified live, with the control:** viewer → `bridger_status` OK
(`canWrite: false`) and `bridger_ask` refused; participant → same status OK
(`canWrite: true`) and `bridger_ask` wrote `JMS-Q-001`. A refusal on its own
proves nothing; it means something next to an acceptance in the same breath.

**Not taken from OpenWork, and why:** 50+ LLM providers and BYO keys (we call no
model — that is the differentiator, not a gap); scheduled tasks, Dispatch,
browser automation (all execution — owning nothing about the agents is what
keeps identity and revocation clean); extension marketplace (a capability
platform is a different product); SSO (premature); "live artifacts"
(auto-refreshing dashboard — already built).

---

## 2026-08-12 — S#271 — Local mode: a bridge needs no database

**Source:** Erik — *"Is the upstash DB really crucial right now or can we do it
later? I want to try two different AI utilizing it... The use case here is also
local sessions that I have opened on my device only."*

**Decision: add `BRIDGER_STORE=file`, and treat local as a first-class mode.**

Requiring a hosted Redis to bridge two windows on the same laptop is
infrastructure for its own sake. The `Store` interface was already injectable
(it exists so the auth path could be tested at all), so a file-backed
implementation was ~180 lines and no change to any caller.

It also unblocked the thing STATUS listed as the single biggest open risk: *no
call had ever succeeded end to end*. With a file store, the full ask → answer →
close → pull round trip ran on a laptop with no account anywhere. **Deferring
Upstash did not defer the verification; it enabled it.**

- **Opt-in only, never a fallback.** Missing Upstash credentials still return
  `null` and still fail closed. A hosted deploy that quietly degraded to
  per-instance local files would look healthy while every serverless instance
  kept its own disappearing ledger.
- **Hard error on Vercel.** `BRIDGER_STORE=file` there throws rather than warns:
  serverless filesystems are ephemeral and per-instance, so a file store there
  is not a degraded bridge, it is a broken one.
- **No TTL locally.** Expiring someone's own record off their own disk would be
  a surprise, not a feature. Deleting the data directory is theirs to run.

**Second AI confirmed to work with no code change.** Gemini CLI takes `httpUrl`
plus arbitrary `headers` (including `Authorization: Bearer`) in `settings.json`
— its own docs example is `http://localhost:3000/mcp`. Same endpoint, same
token, different config file. This is the payoff of MCP being a standard rather
than a vendor protocol, and it means "two different AI on one bridge" needs
nothing built.

### Defect found by the control, and the lesson

Revoking a side from the CLI reported success and **did nothing** — the CLI is a
separate process, and the running server served the revoked token from an
in-memory snapshot taken at startup. The file store's own comment already said
"not safe across processes"; it was written as a concurrency caveat and the real
consequence was a security one.

Fixed with an mtime check before every read. **The generalisable part:** the
check that found this was the *control* — revoked must 401 **while an untouched
token 200s in the same breath**. Checking only that the revoked token was
refused would have passed on the broken build, because it was refused for
reasons unrelated to the revocation. A refusal only means something next to an
acceptance.

---

## 2026-08-11 — S#271 — Bridger, v1 architecture

**Source:** Erik, live in session. Named by Erik ("It's a bridge and we enable it
between people's AI. Bridger").

### The problem, measured

Six manual round-trips on the JudgeMySite ↔ Trigvanta integration, each one
Erik typing *"any questions for their Claude?"*, carrying a markdown file to
Discord, and carrying the reply back. The human is the transport layer.

### What exists already (checked before building)

Cross-account agent messaging is a crowded shelf: **AgentDM** (free, MCP,
explicit cross-account messaging), **Agent Relay** (open-source, DMs/channels),
MCP Talk, claude-peers, claude-ipc, mcp-chat. The messaging half is solved.

**Every one is a pipe.** AgentDM: *"Message content is never read, filtered, or
stored beyond delivery."* Agent Relay stores chat transcripts. None keep the
traced record of decisions and their evidence.

**Decision: adopt nothing, build the ledger.** The pipe is a commodity; a
sellable tool cannot rest on someone else's free early-access service anyway.

### Decisions

1. **No LLM anywhere in the product.** No `ANTHROPIC_API_KEY`, no model id, no
   AI SDK. Bridger is an MCP tool server; both sides' reasoning happens in
   sessions they already pay for. *Erik: "don't make API a requirement to use
   here as we want a cost efficient solution."* This is a hard constraint, not a
   v1 shortcut — anything that would add a model call needs a new decision here.

2. **No shared repo.** Erik corrected an earlier design that made git the
   substrate: *"we don't even have a shared repo... Two separate repos."* Each
   side keeps its own `bridger/` folder; the room replicates entries. A shared
   repo would have meant permissions, an owner, and an implied shared codebase —
   and would have destroyed the one-paste join that is the whole product.

3. **Append-only with derived status.** Nothing mutates. A question is
   "answered" because an answer entry references it, not because a flag flipped.
   Removes the only write two sides could race on, and makes the log replayable.

4. **Author-namespaced entry IDs** (`JMS-Q-014`, `TRI-A-007`), with the side
   proven by the token and the code taken from the room record. A caller cannot
   mint an ID in the other party's namespace. No merge, no conflict resolution.
   Codes are disambiguated at room creation so two partners with the same name
   cannot collide.

5. **`checkedAgainst` is the product.** A path/commit/URL that was actually read,
   or `null` meaning unchecked. Deliberately not a boolean: a boolean can be set
   true without evidence, which is the exact failure this exists to catch.
   **Anchor:** S#270 sent two partner letters with claims FALSE IN CODE (an
   Idempotency-Key described as released when it was consumed; a refund never
   wired). Trigvanta's own Claude caught one by asking. Labelling, not blocking —
   the failure was *unlabelled* claims, not unverified ones.

6. **Retention: 30-day idle TTL on the room** (Erik chose "buffer, then local is
   truth"). Redis cannot expire individual list members, so this is an idle TTL
   refreshed on every write — an active room keeps its whole history; a dead one
   is collected whole. **This is not per-entry expiry** and is written down
   because the difference is discoverable the hard way.

7. **Auth ported from `roastmydev/lib/external/key-registry.ts`**, not
   reinvented: sha256-only storage, fail-closed on an unreadable registry, a
   30-second cache that a revocation always outlives, an env kill switch, a
   capped audit log. Those properties were each learned from a real incident
   there; re-deriving them would have meant re-learning them.

8. **Two classes of CLI command.** Operator (`open`/`rotate`/`revoke`/`close`)
   talks to the registry and needs Upstash credentials. Partner
   (`join`/`pull`/`log`/`status`) needs only a room token — no account, no repo
   access, no credentials. Mirrors `extkeys.mjs`.

9. **`/api/health` exists because 401 is ambiguous.** `withMcpAuth` answers every
   rejection with the same fixed string, so "bad token" and "registry not
   configured" are indistinguishable from outside — fine for security, useless
   for operations. Health reports configuration state and nothing about any
   token, room or entry.

### Rejected

- **CLI-Anything** (`HKUDS/CLI-Anything`) — Erik surfaced it as a CLI aid.
  SKIP as a dependency: it generates Click wrappers around *existing* desktop
  software via a 7-phase LLM pipeline. Wrong shape (we are writing ~8 commands
  from scratch, not wrapping an app) and it would violate decision 1.
  **ABSORBED:** its agent-native contract — JSON as a first-class output,
  composable commands, and the CLI shipping its own skill definition.
- **Building on AgentDM as the transport** — free early-access, hosted, stores
  nothing. Fine for a prototype, wrong spine for something sellable.
- **A blocking `wait` as the primary mechanism** — kept, but bounded (45s max)
  and last in the build order. It is the only feature with a per-second compute
  cost, and it only works while both sessions are live.

### Known limits, stated before use

- **Neither side can wake a Claude that isn't running.** `bridger_wait` is
  real-time only while both sessions are live — Erik's stated operating
  criterion. Otherwise the ping is a mailbox read at the next `bridger_status`.
  A Discord webhook for the *human* notification is v1.1, not v1.
- **`readEntries` reads the whole buffered list and filters in memory.** Correct
  at two-party scale and capped at `MAX_ENTRIES`; past a few thousand entries per
  room it wants real pagination.
- **Vercel `maxDuration` for `wait` is unverified on this account.** Route
  declares 60s, the tool caps itself at 45s. If the plan's limit is lower it
  degrades to a short poll rather than breaking.
