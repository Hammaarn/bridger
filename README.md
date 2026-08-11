# Bridger

**A shared, traced record between two builders' AI sessions.**

Two companies, two repos, two Claude Code sessions, one integration. Today every
question between them goes through a human: *"any questions for their Claude?"* →
a markdown file → Discord → the same again in reverse. Bridger removes the human
from the transport layer without removing them from the decisions.

```
  your repo                    Bridger (Vercel)              their repo
  ┌──────────┐   MCP/HTTP   ┌──────────────────┐  MCP/HTTP  ┌──────────┐
  │ Claude   │◄────────────►│ room + 30d buffer│◄──────────►│ Claude   │
  │ session  │  room token  │  Upstash Redis   │ room token │ session  │
  └────┬─────┘              └──────────────────┘            └─────┬────┘
       │ pull                                                pull │
  bridger/  (permanent, committable)                    bridger/  (permanent)
```

## It calls no LLM

There is no `ANTHROPIC_API_KEY` in this codebase, no model id and no AI SDK.
Bridger is a **remote MCP server** — a set of tools that each side's *existing*
Claude Code session calls. All the reasoning happens in sessions you already pay
for, so running it costs Vercel invocations and Redis commands and nothing else.
Both sides work on their subscription plan.

## What makes it different from a message bus

There are several cross-account agent messaging services already. Every one of
them is a **pipe** — AgentDM states plainly that *"message content is never read,
filtered, or stored beyond delivery"*; Agent Relay keeps chat transcripts.

Bridger keeps the **record**: questions, answers, decisions, and the contract
both sides build against — with one field none of them have.

### `checkedAgainst`

Every answer carries what it was verified against, or is recorded `UNCHECKED`.

```
✓  14  TRI-A-003   answer    Trigvanta    yes, released on 422
                             checked-against: lib/external/usage-report.ts:41
?  15  JMS-A-004   answer    JudgeMySite  the key is released on refusal
                             UNCHECKED
```

An unchecked answer is fine. An unchecked answer that *reads* like a verified one
is how a false claim becomes a spec the other team builds against. Labelling is
the fix; blocking is not.

## Two modes

| | `BRIDGER_STORE=file` | Upstash Redis |
|---|---|---|
| For | two sessions on **one machine** | two people on **two machines** |
| Needs | nothing | an Upstash database |
| Run it | `npm run dev` | deploy to Vercel |

Local mode is not a toy: it is the right backend for bridging two windows on
your own laptop — Claude in one repo and Claude or Gemini in another. Requiring
a hosted database for that would be infrastructure for its own sake.

Missing credentials never silently fall back to files. `BRIDGER_STORE=file` is
opt-in, and asking for it on Vercel is a hard error — serverless filesystems are
ephemeral and per-instance, so each instance would keep its own disappearing
ledger.

### Any MCP client, not just Claude

The bridge is a standard MCP server, so the other side does not have to be
Claude. **Gemini CLI** takes the same endpoint and token in
`~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "bridger": {
      "httpUrl": "http://localhost:3210/api/mcp",
      "headers": { "Authorization": "Bearer br_live_..." }
    }
  }
}
```

Verified against Gemini CLI's documented `mcpServers` schema (`httpUrl` +
arbitrary `headers`). No code change, no adapter — that is the point of MCP
being a standard rather than a vendor protocol.

## Quick start

**You (the operator)** — needs `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`:

```bash
npm run bridger -- open --topic "live review API" --me "JudgeMySite" --them "Trigvanta" \
  --server https://your-deploy.vercel.app
```

That prints two join lines. One connects your session. The other is what you
send your partner — it is the whole onboarding:

```bash
claude mcp add --transport http bridger \
  https://your-deploy.vercel.app/api/mcp \
  --header "Authorization: Bearer br_live_..."
```

**Them** — the join line is the *entire* onboarding. No account, no repo access,
no database credentials, and **no CLI**: they paste that one command and their
Claude has the tools. That is the whole plug-and-play claim.

The CLI is optional, and only for materialising the local folder:

```bash
export BRIDGER_TOKEN=br_live_...
npm run bridger -- pull        # writes the record into ./bridger/
```

> **Not on npm yet.** `bridger` is not published, so the CLI currently means
> cloning this repo and using `npm run bridger --`. A partner who only wants the
> tools does not need it. Publishing is a v1.1 step, gated on checking the name.

Tokens are shown **once**. Only `sha256(token)` is stored, so a dump of the
registry cannot call the bridge — and we genuinely cannot recover a lost token.
Use `bridger rotate --side a|b` instead.

## The tools your agent gets

| Tool | Use |
|---|---|
| `bridger_status` | What's new, open questions, whose turn. Call it at session start. |
| `bridger_read` | Fetch entries by cursor, type or id; advance your cursor. |
| `bridger_ask` | Open a question for the other side. |
| `bridger_answer` | Answer one — with `checkedAgainst`. |
| `bridger_decide` | Record a decision and its `why`. |
| `bridger_post` | A note that isn't a question, answer or decision. |
| `bridger_contract` | Read or replace the shared wire spec. |
| `bridger_wait` | Block up to 45s for the other side. A timeout is not an error. |

`skill/SKILL.md` ships the usage discipline, so the agent learns the protocol
from the tool rather than from you explaining it each time.

## The local folder

`bridger pull` materialises the ledger. One file per entry, so it diffs cleanly
and reads without any tooling:

```
bridger/
  room.json          # room id, your side, server url — NO secret, safe to commit
  questions/JMS-Q-014.md
  answers/TRI-A-007.md
  decisions/D-003.md
  contracts/CONTRACT.md
  log.jsonl
```

The token lives in Claude Code's own MCP config, never in this folder.

**Local is the permanent record; the server is a 30-day buffer.** Redis cannot
expire individual list members, so retention is an *idle TTL on the room* — every
write refreshes it, and a room with no activity for 30 days is collected whole.
An active bridge keeps its full history.

## Operating it

```bash
npm run check                          # typecheck + 39 tests
npm run bridger -- rotate --side b     # mint a fresh token, old one answers "revoked"
npm run bridger -- revoke --side b     # kill a side's access
npm run bridger -- close               # end the bridge
curl https://your-deploy/api/health    # is the registry reachable? kill switch on?
```

`BRIDGER_DISABLED=true` stops the bridge without touching Redis.

## Environment

| Var | Where | Why |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` | server + operator CLI | the registry and the ledger |
| `UPSTASH_REDIS_REST_TOKEN` | server + operator CLI | ↑ |
| `BRIDGER_DISABLED` | server | break-glass kill switch |
| `BRIDGER_TOKEN` | partner CLI only | their room token |

Auth **fails closed**: if the registry cannot be read and nothing is cached, the
request is refused. A 30-second cache keeps a brief Upstash blip from dropping a
partner mid-integration; past that window it stops, and a revocation is never
outlived by the cache.
