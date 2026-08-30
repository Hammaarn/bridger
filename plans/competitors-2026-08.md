# The products in this space — a study list, not an inventory

> **Source:** Erik's brother, 2026-08-26, after a night of his own research.
> *"Mönstret är tydligt: 'sätt agenter i samma rum' är redan en kategori, inte
> en lucka."* He is right, and the verification below is ours rather than his.
>
> **Companion file:** `landscape-2026-08.md` covers the PROTOCOL layer (MCP,
> WebMCP, A2A). This one covers PRODUCTS.
>
> **Read this before designing anything for C0.** Two of the three things at the
> top of `TODO.md` already have a working reference implementation under MIT.

---

## Verification status, stated per claim

| claim | status |
|---|---|
| `agent-room-alkl/agent-room` exists, features as described | **PARTLY WRONG, corrected S#284 by cloning it.** The repo, npm and live site are real. But "features as described" was read off their README, not their code: the **webhook wake-up delivery half, the HTTP `/mcp` endpoint and the `/api/room` REST surface are all absent from the public repo**, while the live service serves all three. Turn discipline and the Stop hook ARE fully published. See the reading list below. |
| npm usage figures | **VERIFIED** via npmjs API |
| `steviebuilds/agent-room`, `cch123/open-agent-room`, `agree-able/room-mcp`, `kdowswell/agent-room` | **VERIFIED to exist**, descriptions match; contents NOT read |
| "AgentRoom" arXiv paper, 24 Aug 2026, CRDT + `room_claim` | **VERIFIED S#284 — it exists, and the earlier "found nothing" was the query's fault, exactly as suspected.** `arXiv:2608.23740`, *"AgentRoom: Concurrent Multi-Agent Coding in a CRDT-Backed Shared Workspace"*, Cho & Lee, published 2026-08-24, cs.AI/cs.SE. **Not a competitor, and worth reading anyway** — it is one team's coding agents editing a CRDT-merged shared FILESYSTEM, with file-level claim/status/broadcast exposed as MCP tools. No second party, no trust boundary, no provenance; a research prototype, not a product. Its own conclusion is the useful part and it points at C0: *"Coordination, not parallelism or CRDT-merge, bears the load."* |
| ACP merged into A2A, Aug 2025, "do not implement" | **VERIFIED S#284.** IBM's ACP (which powered BeeAI) merged into A2A under the Linux Foundation; BeeAI now runs on A2A. Google donated A2A to the LF. His word was good, again. |

---

## [!!] Agent Room — the one that matters

`github.com/agent-room-alkl/agent-room` · `agent-room.com` · npm `agent-room-mcp`
· **MIT** · created 2026-04-13 · last push **2026-08-01**

**Built on Vercel + Upstash Redis. The identical stack to ours.**

### What it ships that we do not

| theirs | ours |
|---|---|
| **Turn discipline** — `open` / `sequential` / `moderator` reply modes | nothing. This IS Erik's "balance between different models" |
| **Webhook wake-up** — HMAC-signed POST wakes registered resident agents instead of polling | still nothing, and **deliberately**: it only wakes agents that are already daemons with a gateway, and their delivery code is not in the public repo anyway (S#284). Our `listen --exec` is the same idea from the local side |
| **Stop-hook wake-up** — keeps a Claude Code / Cursor turn from ENDING when a message lands | **MATCHED S#284** — `integrations/claude-code/`, `e92f29a`. This is the one that actually removes the nudge, and it is the half of their `apps/mcp/src/hook.ts` that is fully published. Cursor's `followup_message` half is still theirs alone |
| **Evidence-gated task board** — claimed, submitted with evidence, **verified by a DIFFERENT agent** before it counts as done | nothing |
| **Project memory** — durable project id, injects prior context across rooms | A10, parked |
| **Report export** — a room becomes minutes / an ADR / a PR description | `pull`, roughly |
| Presence with visible state | `joined`, weaker |
| Tool-call recovery — repairs tool calls a model leaks as plain text | nothing, and it is a real-world nicety |

Also: 9-character room code, MCP **and** REST, web UI, self-hostable, a published
protocol spec at `docs/AGENT_ROOM_PROTOCOL.md`, and a portable `SKILL.md` +
`room.sh` for anything that can run curl.

### What it does NOT have, and the reason is structural

**Nobody in their room is a stranger.** Every scenario in their README is one
team's agents: frontend and backend negotiating a contract, a reviewer, a
merger, or three Claude sessions playing Architect / Skeptic / Implementer.

So there is no containment of foreign text, no `basis` refusing an opinion that
carries a citation, no `checkedAgainst` on a CLAIM, no hash chain, and no
two-party consent to destroy the record. **They do not need any of it.**

**Their evidence-gating is on TASKS** (did you do the work, verified by another
agent). **Ours is on CLAIMS** (what did you check this against, for a party who
cannot check you). Adjacent, genuinely different, and easy to conflate.

### Traction, measured

```
npm last month   4,016 downloads
npm last week      282          <- declining, not growing
GitHub            37 stars, 12 forks, 0 open issues
last push         2026-08-01 (26 days before this was written)
```

**Nobody has won this.** A small project, possibly stalling.

---

## The rest of the category

| repo | stars | last push | what |
|---|---|---|---|
| `steviebuilds/agent-room` | 49 | 2026-07-12 | private LOCAL meeting rooms for Codex, Claude Code and others |
| `agree-able/room-mcp` | 23 | 2026-01-04 | rooms for MCP clients to coordinate; **8 months stale** |
| `cch123/open-agent-room` | 23 | 2026-04-30 | (no description) |
| `kdowswell/agent-room` | 1 | 2026-04-26 | mission-control dashboard for parallel coding agents, runs locally |

**[S#284] One row in the circulated version of this list is a double count.**
`agent-room-mcp` was listed as a separate project ("local file-backed room log +
task board"). It is not one: it is **Agent Room's own npm package** — the npm
description reads *"MCP server for Agent Room — multi-agent meeting rooms"*, and
the repo's README publishes `apps/mcp` under exactly that name. The local
file-backed description belongs to `steviebuilds/agent-room`, which is already
its own row. So the category is four projects, not five.

**The honest shape: five projects, the largest has 49 stars, three are stale.**
That is a category of small experiments, not a market with an incumbent. His
"already a category, not a gap" is correct about the IDEA and overstated about
the competition.

---

> **[S#285] This list was incomplete, and the missing entry is not a GitHub side
> project.** `cch123/open-agent-room` is an independent reimplementation of
> **Slock** (`slock.ai`, now `@botiverse/raft-daemon`, closed source, 269 npm
> releases). Assessed in `category-audit-s285.md`: **not a competitor** — its
> engineering is live agent-workspace MIGRATION between machines, and rooms are
> a surface on top. Shares a UI metaphor with this category and little else.

## What to read, and in what order

1. **`agent-room-alkl/agent-room` → `docs/AGENT_ROOM_PROTOCOL.md`.** Their
   protocol spec. Read it against ours before touching C0.
2. **Their turn-discipline implementation** (`open` / `sequential` / `moderator`).
   This is the top of our list, solved, in readable MIT code.
3. ~~**Their webhook wake-up path**~~ — **NOT READABLE, and the "same floor"
   claim was wrong. Both corrected S#284 by cloning the repo.**

   **(a) The delivery half is not published.** `packages/upstash-client/src/webhooks.ts`
   registers, unregisters and lists — that is all. There is no HMAC, no POST, no
   `AGENT_ROOM_WEBHOOK_ALLOW_HTTP`, no drop-after-20-failures, none of the headers
   their `OPENCLAW.md` documents in operational detail. Searched the whole tree
   with `grep -ril` on `webhook`, `hmac` and `createHmac`.

   **(b) Nor is the server edge.** There is no HTTP `/mcp` route and no
   `/api/room` (which their own `room.sh` posts to); `vercel.json` sends
   everything outside `/api/` to the SPA, and `api/` holds five functions —
   upload, install, report-og, report-page, delete-room-blobs. Live
   `www.agent-room.com/mcp` answers `tools/list` regardless. So their README's
   *"the hosted instance at agent-room.com is this repo deployed on Vercel +
   Upstash, nothing more"* is **not true of the repo as published.** The state
   logic is open; the edge is withheld. Worth knowing next to our own posture —
   `/api/about` publishes the running commit and `VERIFY.md` hands over the
   command that proves it.

   **(c) "The floor is the same for both of us" is FALSE, and it was our own
   sentence.** Their webhook cannot wake Claude Code. But their **`Stop` hook**
   can, and it is fully published (`apps/mcp/src/hook.ts`) — it does not start a
   turn, it stops one from ending. We shipped ours at S#284
   (`integrations/claude-code/`, `e92f29a`). What is still unbuilt on our side
   is the Cursor half of that same file: `{followup_message}` on Cursor's stop
   hook, enqueued as the next user message.
4. **`packages/shared` tool-call recovery** — repairing tool calls a model emits
   as plain text. Small, real, and the kind of thing only field use teaches.
5. `steviebuilds/agent-room` for the local-first take.

### The licence boundary, so nobody has to guess later

Everything here is **MIT**. Reading it for design is unrestricted. **Copying
code requires preserving the copyright and licence notice** — Apache-2.0 (ours)
and MIT are compatible in that direction, but a copied file carries its notice
with it. Design inspiration: free. Lifted code: attributed, or rewritten.

---

## What this changes, strategically

**1. The solo / multi-model positioning is DEAD.** Erik was enthusiastic about
"several small models with roles in one room" on 2026-08-26, and Claude
encouraged it without running a search — one day after missing A2A the same way.
Agent Room does exactly that, better, shipped, on our own stack. **Discard the
positioning; the test itself is still a cheap way to get Bridger used twice.**

**2. C0 gained a reference implementation.** Turn discipline and wake-up are the
two things Erik named as most important, and both are readable under MIT. That
is an answer key, not a threat.

**3. The trust room is now the ONLY differentiated surface.** Two organisations
that do not share an employer, a record neither can rewrite, provenance on
claims a partner cannot verify. Real — and the part with zero users.

Which sharpens the question rather than softening it: **is "two companies who do
not trust each other" a need someone will pay for, or a property nobody feels?**
Nothing in this file answers that, and no competitor's traction answers it
either — because none of them have any.
