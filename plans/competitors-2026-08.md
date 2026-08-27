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
| `agent-room-alkl/agent-room` exists, features as described | **VERIFIED** — repo, README, npm, live site all checked |
| npm usage figures | **VERIFIED** via npmjs API |
| `steviebuilds/agent-room`, `cch123/open-agent-room`, `agree-able/room-mcp`, `kdowswell/agent-room` | **VERIFIED to exist**, descriptions match; contents NOT read |
| ACP merged into A2A, Aug 2025, "do not implement" | **NOT verified** — his word, and he has been accurate |
| "AgentRoom" arXiv paper, 24 Aug 2026, CRDT + `room_claim` | **one arXiv query returned nothing.** That is a search that found nothing, NOT evidence the paper does not exist. Re-check with a better query before relying on it either way |

---

## [!!] Agent Room — the one that matters

`github.com/agent-room-alkl/agent-room` · `agent-room.com` · npm `agent-room-mcp`
· **MIT** · created 2026-04-13 · last push **2026-08-01**

**Built on Vercel + Upstash Redis. The identical stack to ours.**

### What it ships that we do not

| theirs | ours |
|---|---|
| **Turn discipline** — `open` / `sequential` / `moderator` reply modes | nothing. This IS Erik's "balance between different models" |
| **Webhook wake-up** — HMAC-signed POST wakes registered resident agents instead of polling | C0, unbuilt. Our `listen --exec` is the same idea from the local side |
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

**The honest shape: five projects, the largest has 49 stars, three are stale.**
That is a category of small experiments, not a market with an incumbent. His
"already a category, not a gap" is correct about the IDEA and overstated about
the competition.

---

## What to read, and in what order

1. **`agent-room-alkl/agent-room` → `docs/AGENT_ROOM_PROTOCOL.md`.** Their
   protocol spec. Read it against ours before touching C0.
2. **Their turn-discipline implementation** (`open` / `sequential` / `moderator`).
   This is the top of our list, solved, in readable MIT code.
3. **Their webhook wake-up path** — `packages/upstash-client`, the HMAC-signed
   POST and the registered-resident model. Note what it does NOT solve: it wakes
   agents that are already daemons with a gateway. It cannot make Claude Code or
   Cursor start a turn any more than we can. **The floor is the same for both of
   us; they simply ship the part that is reachable.**
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
