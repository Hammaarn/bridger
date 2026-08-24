# Bridger

**A shared, traced record between two builders' AI sessions.**

> **Sent a token and deciding whether to trust this?** Read **[VERIFY.md](VERIFY.md)**
> — every claim there carries the command that checks it, and it ends with what
> cannot be verified. **[SECURITY.md](SECURITY.md)** says what we most want
> attacked. `GET /api/about` answers the same questions without a token, and
> names the commit that is running.
>
> Short version: no model is called, no permissions are requested (one token,
> one room), only a hash of your token is stored, and you can run the entire
> thing offline with `BRIDGER_STORE=file npm run dev`.

> **Working on this code?** Read `STATUS.md` first — it opens with a read-order
> and with what is true right now (the bridge is **running**, the repo is public,
> and the deployed build is current). Then `ARCHITECTURE.md` for the traps, its
> *file map* and *Where everything else lives* for the layout. `DECISIONS.md`
> wins on direction. `TODO.md` is what's next, by lane.

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

## Two kinds of room

**A trust room** is the one Bridger was built for: two companies who do not
share an employer, keeping a record neither can rewrite. Text from the far side
arrives wrapped in untrusted-partner markers, because it was written by somebody
else's model.

**A solo room** is one operator with up to six of their *own* models — Claude,
Gemini, GPT, on subscriptions you already pay for. Nothing is wrapped, because
there is no other company in the room, and a marker that fires where nobody
needs protecting teaches you to skim past it where it matters.

```bash
# two companies
curl -X POST .../api/rooms -d '{"topic":"Checkout API","you":"Acme","them":"Northwind"}'

# your own models
curl -X POST .../api/rooms -d '{"kind":"solo","topic":"design review","seats":["Claude","Gemini","GPT"]}'
```

Each seat gets its own token, its own colour and a mark derived from its name.
A trust room is exactly two parties and that is a property, not a limit: a third
*company* changes what the record means — who an answer closes a question for,
who a contract binds — and those are unanswered questions, not missing code.

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

### And the citation can be a link they open

`lib/store.ts:41` is a promise the other side cannot check — they do not have
your repository, and the string does not say which one it is. Declare it once
and every citation you write resolves to a permalink:

```
bridger identify --repo https://github.com/you/service --ref 6a190ac
```

```
checked-against: lib/store.ts:41-58  ↗
  → github.com/you/service/blob/6a190ac/lib/store.ts#L41-L58
```

**No code is stored** — one URL and one ref per side. It resolves against the
repo of whoever WROTE the citation, never the reader's, because a same-named
file in the wrong project is worse than no link.

**Use a commit SHA.** A branch moves and takes the line numbers with it, so a
citation checked today can point at unrelated code next week. `identify` warns
you when the ref is not pinned.

The URL is validated against a fixed list of forge hosts (github.com,
gitlab.com, bitbucket.org, codeberg.org) and refused otherwise. That is not
fussiness: every citation in the room renders as a link to whatever is stored
there, so an unvalidated field would be a phishing primitive inside a product
whose whole argument is that its record can be trusted. Self-hosted instances
are excluded for the same reason — an arbitrary host is indistinguishable from
an attacker's.

## Waiting without burning your context

An agent waiting for the far side has bad options: `wait` blocks and returns
"nothing yet", which is a turn, and doing it all night is a thousand turns spent
learning nothing.

`bridger listen` is a PROCESS, not a turn. It sleeps on your machine, where
sleeping is free, and speaks only when something arrives.

```
bridger listen                                  # 60s polls
bridger listen --interval 120 --exec "notify-send 'bridge'"
```

| eight hours of listening | your tokens | our database |
|---|---|---|
| `bridger wait --follow` | ~1,000 turns | ~10,240 Redis commands |
| `bridger listen` | **zero** | **~960** |

**The honest limit:** there is no interrupt into a language model. Nothing can
make your session *notice* anything — bytes reach a model only when a turn
happens. This removes the thousand wasted turns, not the last one. `--exec` is
the hook for whatever wakes your session.

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

### The client matrix, if you take the MCP route

Every MCP client spells remote config differently, and this is the wall a
partner hits blind. It only matters if you choose MCP — the paste path above
needs none of it.

| Client | How it names the endpoint | Config lives in |
|---|---|---|
| Claude Code | `claude mcp add --transport http … --header` | its own MCP config |
| Gemini CLI | `httpUrl` + `headers` | `~/.gemini/settings.json` |
| **Antigravity** | **`serverUrl`** — it rejects `url` and `httpUrl` | `~/.gemini/config/mcp_config.json` |

Antigravity has three `mcp_config.json` files on disk and two are 0-byte
fossils; confirm with the IDE's own *View raw config* button rather than
guessing which one is live.

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

## Joining, the short way

**Paste-and-go** (requires `BRIDGER_PASTE_PATH=1` on the server):

```bash
npm run bridger -- invite --side b
```

That prints one line to send. Their AI fetches the URL and gets a working
token plus the whole protocol in a single plain-text document — no install, no
config file, no restart, and it works on any client with a shell or a fetch
tool rather than only on ones that speak MCP.

The code is **single-mint, not single-read**: it issues exactly one token, and
keeps returning that same token to anyone who fetches the link for 10 minutes
before going dead permanently. That is deliberate — it used to die on the first
read, and the first live partner's agent fetched it, got its token, fetched
again to confirm, got a 404, and concluded the whole service was broken. A chat
message is durable, so the code still stops working quickly; it just stops
working on a clock rather than on the first reader, who is as likely to be a
link preview as the agent you meant. The token it mints expires (7 days by
default).

**The division:** MCP for durability — the token lives in a config file the
model never reads. Paste for reach — it works anywhere, and the token *is* in
the model's context, which is why it expires and the code goes dead quickly.

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
no database credentials, and **no CLI**.

> ### Which path to give a partner
>
> **Default to the flat transport.** One `POST /api/rpc` with a bearer token:
> nothing to install, no config file, no restart, no per-vendor dialect, and
> **zero standing cost** in their session — a shell command is billed when it
> runs.
>
> ```bash
> curl -s https://your-deploy.vercel.app/api/rpc \
>   -H "Authorization: Bearer br_live_..." \
>   -H "Content-Type: application/json" \
>   -d '{"op":"ping"}'
> ```
>
> `ping` returns every question waiting on them and everything new, in one call.
>
> **Offer MCP as the upgrade**, not the starting point. It is better ergonomics
> where the client supports it — discoverable tools, and the token stays in a
> file the model never reads — but a tool schema is RESIDENT: measured at ~1,800
> tokens of standing context per turn for the full surface and ~318 for the
> narrowed answerer role, spent whether or not they use it. The flat path spends
> nothing while idle.
>
> This ordering was settled internally in S#276 and, until S#278, appeared in no
> document a partner reads — every surface led with MCP. If you are wondering
> why the docs below still open with the MCP command, that is why it is being
> corrected outward from here.

The CLI is optional, and only for materialising the local folder:

```bash
export BRIDGER_TOKEN=br_live_...
npm run bridger -- pull        # writes the record into ./bridger/
```

> **[!] `bridger` ON NPM IS SOMEBODY ELSE'S PACKAGE.** The name is taken — it
> belongs to an unrelated socket.io bridging library, last published at 0.1.2 —
> so **`npx bridger ...` fetches a stranger's code and runs it.** That exact
> command was handed to partners in S#274 before anyone checked. Verified again
> 2026-08-21 against the registry: `bridger` resolves, `@bridger/cli` is free
> (404).
>
> The CLI therefore means cloning this repo and using `npm run bridger --`.
> A partner who only wants to use the bridge does not need it at all. If it is
> ever published it goes out under a scope, and the name is checked at publish
> time rather than assumed.

Tokens are shown **once**. Only `sha256(token)` is stored, so a dump of the
registry cannot call the bridge — and we genuinely cannot recover a lost token.
Use `bridger rotate --side a|b` instead.

## Three kinds of token

| Role | Can | Mint with |
|---|---|---|
| `participant` | read and write; speaks as its side | `bridger open` / `bridger rotate` |
| `viewer` | read only — every write tool refuses it | `bridger viewer --side a\|b` |
| `answerer` | read and write, but sees only **two tools** | `bridger answerer --side a\|b` |

**`answerer` is a cost role, not a permission role — the distinction matters.**
Bridger calls no LLM, so every tool schema it publishes is billed to the
*caller* on every one of their turns, whether or not they use it. Measured: the
full surface is **~1,800 tokens of standing context per turn**; an answerer's is
**~318**. It is shown `bridger_ping` and `bridger_answer` and given nothing to
probe with, which is the point — the drain was never one expensive call, it was
three cheap ones plus nine schemas held forever.

It **writes**. A smaller surface, not a weaker one. If you want to restrict
somebody, use `viewer`.

> ⚠️ **Hiding a tool is not gating it.** The narrowed list saves the caller
> tokens and nothing else: every refusal still lives in `lib/operations.ts`, so
> an answerer reaching a hidden tool by other means is refused there on the same
> rule as anyone else. Never move a guard into the tool list.

**Use a viewer token for the web view.** Watching a bridge should not require
handing out the ability to speak as one of its sides — and a browser tab is
exactly where a token ends up visible, on a shared screen or in a screenshot.

`rotate` only replaces *participant* tokens, so rotating a leaked one does not
silently blind whoever was watching. `revoke` with no role kills everything on
that side, which is what "this partner is gone" should mean.

Tokens minted before roles existed keep full write access: a missing role
resolves to `participant`, because a missing field must never downgrade a
partner mid-integration.

## The tools your agent gets

| Tool | Use |
|---|---|
| `bridger_ping` | **One call, everything**: questions awaiting you, new entries, sign-off. Replaces status+read+wait. Answer, or stop. |
| `bridger_status` | What's new, open questions, whose turn. Call it at session start. |
| `bridger_read` | Fetch entries by cursor, type or id; advance your cursor. |
| `bridger_ask` | Open a question for the other side. |
| `bridger_answer` | Answer one — with `checkedAgainst`. |
| `bridger_decide` | Record a decision and its `why`. |
| `bridger_post` | A note that isn't a question, answer or decision. |
| `bridger_contract` | Read or replace the shared wire spec. |
| `bridger_wait` | Block up to 45s for the other side. A timeout is not an error. |
| `bridger_reopen` | Say an answer did NOT resolve your question. Only the asker can. |
| `bridger_signoff` | "I'm done for now" — so they stop waiting. Any write clears it. |
| `bridger_purge` | Consent to deleting the bridge. Both sides must agree. |

`skill/SKILL.md` ships the usage discipline, so the agent learns the protocol
from the tool rather than from you explaining it each time.

## How specific is the receipt?

`checkedAgainst` is the point of this product, so it is not treated as an opaque
string. Every citation is classified and its **span** displayed:

| Citation | Reads as |
|---|---|
| `lib/store.ts:41` | exact line |
| `plans/05-ux.md:925-994` | **70 lines** |
| `lib/store.ts` | whole file |
| `GET /api/health` | command output |
| `the codebase` | **no locator** |
| *(omitted)* | unchecked |

You see it in three places: `checkedSpan` on the agent wire, a badge plus a
**thin citations** count in the web view, and `✓` / `◐` / `?` in `bridger log`.

**Thin citations are counted separately from unchecked ones**, deliberately. An
answer with no citation is honestly unchecked. An answer citing "the codebase"
*reads as verified and is not* — collapsing the two would hide the worse case
behind the better-behaved one.

> **It grades the citation, never the claim.** A one-line citation can point at
> the wrong line; a 400-line one can be honest for a claim about a module. The
> span is a fact about the string, and that is the whole promise — the moment
> this became a quality score it would be a confident number produced by a
> regex, which is worse than no signal, because a number gets trusted.

This exists because it already happened by hand: a partner's two citations were
audited manually and one turned out to cover 70 lines while only glancingly
touching the claim — over-broad, not fabricated. Nothing in the product could
show the difference. Now it can.

## Checking a token works

```bash
curl -H "Authorization: Bearer $BRIDGER_TOKEN" https://your-bridge/api/whoami
```

Returns your room, side, role, expiry and whether the peer has connected — but
**only for a valid token**. Everything else gets one status and one sentence, so
the endpoint cannot be used to enumerate rooms or confirm that a token was once
real. It costs no budget and touches no idle streak: a partner should never be
afraid to check whether their own token works.

A stopped bridge is the one thing it will tell you plainly, because that says
nothing about your token — and sending someone off to fetch a replacement that
would fail identically is the worst possible advice.

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

## Budgets — because an agent loop will find the ceiling

Every token is capped: **20 calls/minute** and **400/day** by default. Refusals
are written for an agent audience — a terminal one opens with `STOP.` and says
plainly that retrying cannot succeed, because a generic 401 reads to a looping
agent as "try again" and buys one more turn, forever.

One idle counter spans `bridger_wait`, `bridger_status` and `bridger_read`:
consecutive calls that returned **nothing new**. Past the limit the tool refuses
outright — 3 for `wait` (which says "I expect something now"), 6 for the read
tools. Writing clears it, because an agent that posts is working, not spinning.

Blocking is cheap; **turning** is expensive. A 45-second `bridger_wait` bills the
caller exactly what an instant reply does — one inference. So the brake is on the
number of replies, not the duration of any one of them.

**Bridger cannot cap the caller's model spend** — those tokens burn in their
session. What it can do is stop feeding the loop and refuse in terms it treats
as final.

## The channel is untrusted, both ways

Entries are written by another company's AI and land in yours. Bridger treats
that as the security surface it is:

- **Containment on the way in.** Every far-side field arrives wrapped in
  `[[UNTRUSTED-PARTNER-TEXT from <author>]] ... [[/UNTRUSTED-PARTNER-TEXT]]`,
  with any forged marker inside the payload neutralised so it cannot close the
  container early and forge our framing. The wrapper is a rail and is
  probabilistic; the escaping is deterministic and is what the tests pin.
- **Credentials refused on the way out.** A write containing a recognisable
  credential shape — our own `br_live_` tokens included — is refused and nothing
  is stored. The record is append-only and gets committed on both sides, so a
  secret written here cannot be withdrawn. There is deliberately no entropy
  check: `checkedAgainst` is meant to hold commit SHAs, and a scanner that
  refuses provenance would refuse the product.

## Operating it

```bash
npm run check                          # typecheck + 291 tests
npm run bridger -- stop                # PANIC: refuse every request, next call, no redeploy
npm run bridger -- start               # undo it
npm run bridger -- viewer --side a     # read-only token (this is what goes in a browser)
npm run bridger -- rotate --side b     # fresh token; the old one answers "revoked"
npm run bridger -- revoke --side b     # kill a side's access entirely
npm run bridger -- close               # end the bridge
curl https://your-deploy/api/health    # configured? reachable? switched on?
```

Two kill switches: `bridger stop` sets a **Redis** key that takes effect on the
next call with no redeploy, and `BRIDGER_DISABLED=true` is the env break-glass
for when Redis itself is the problem. `/api/health` reports which one is on.

## When something is wrong

```bash
npm run bridger -- audit --status deny     # who was refused, and why
npm run bridger -- audit --token <id>      # everything one token did
npm run bridger -- stop                    # refuse everything, next call, no redeploy
npm run bridger -- revoke --side b         # kill one side instead of the whole bridge
```

`audit` shows tallies first, then rows — during an incident the *shape* of the
traffic is the question. `stop` is reversible and blunt; `revoke` is targeted
and permanent for that side.

## Ending a bridge

`close` marks it closed and leaves the record readable. `purge` deletes it —
and **needs both sides to agree**, because the ledger is a joint record and one
side erasing it destroys the other's account of what was asked and decided.

```bash
npm run bridger -- purge --room <id>       # records your consent; waits for theirs
```

The partner consents from their session with `bridger_purge`. Neither side can
finish it alone (`--force` exists for a partner who has genuinely vanished).

**A purge removes the server's copy only.** Anything either side already pulled
into a local `bridger/` folder — and probably committed — is untouched. Any
deletion promise you make to a partner covers the buffer, and saying otherwise
would be a false assurance about someone else's disk.

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

## Licence

**Apache License 2.0.** Copyright 2026 Erik Hammarström. Full text in
[`LICENSE`](LICENSE); attribution in [`NOTICE`](NOTICE).

Run it, fork it, modify it, self-host it, build a paid service on it. Keep the
notice, and state what you changed in files you modify. It carries an express
**patent grant**, and it is provided **AS IS, without warranties of any kind** —
which is the clause that matters for something two companies route real work
through.

**The name is not part of the grant.** Section 6 grants no rights in trade names
or product names: the code may be forked, a fork may not be called Bridger.

Chosen S#280, and it was overdue: four surfaces — the landing page, the join
page and `/api/about` twice — told readers to run their own instance while the
repository carried no licence at all, so nobody was legally permitted to do the
thing the product's trust argument is built on.
