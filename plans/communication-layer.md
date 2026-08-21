# The communication layer — OPEN PROBLEM, S#275

> **STATUS: OPEN, and deliberately not closed.** Erik, ending S#275: *"I believe
> there might be a smart solution and we just haven't looked it up yet or talked
> our way to reach the solution."* That is the right posture. Everything below is
> the state of the argument, not a verdict — do not treat the trilemma as proof
> that no fourth option exists. It is proof that nobody has found one **yet**,
> which is a much weaker claim.

---

## The constraint

**Erik, S#275:** *"It should literally only cost tokens when communication is
happening between 2 instances aka Read/Reply. Everything else should strictly be
0 token cost if possible."*

Adopted (`DECISIONS.md` 2026-08-17). It already drove the S#274 answerer role.

## Why it is hard, stated precisely

Bridger calls no LLM, so **every token this product costs is billed to somebody
else's session.** That is unusual and it is why this matters more here than for a
normal API: our own numbers look perfect no matter how wasteful we are. The
Gemini quota incident (S#271) burned an entire quota while every metric we owned
stayed green.

**An MCP tool schema is resident.** The client holds it in context on every turn
of the caller's session, used or not. So a completely silent bridge still costs
the far side money, forever.

## What is measured, and what is not

| Fact | Source | Confidence |
|---|---|---|
| Full 12-tool MCP surface ≈ **1,800 tokens/turn** | measured S#274 | one measurement |
| `answerer` role (2 tools) ≈ **318 tokens/turn** | measured S#274 | one measurement |
| `/api/rpc` standing cost = **0** | structural — nothing is registered | reasoned, not measured |
| A blocked `bridger_wait` costs **one** call regardless of duration | by design | verified in code |
| **What the JOIN DOCUMENT costs a far side** | **10,279 bytes / 189 lines / ~2,300-2,500 tokens** | measured 2026-08-21 by Antigravity itself |
| A foreign client's transport choice when offered both | **flat, by decision** — 16 calls, zero MCP | observed 2026-08-21 |
| **What a real multi-day integration costs** | — | **still not measured** |

**UPDATE 2026-08-21: two of these rows are now answered by a real far side**,
and the answer to the transport question was the one this file hoped for — a
foreign client chose flat over MCP deliberately, and reached our own conclusion
about why. See TODO lane C. The trilemma's "trust-anchored" column also needs
revisiting: Antigravity took a pasted URL from an unknown domain without
refusing, which is a data point AGAINST the assumption that the paste path is
the cell a careful agent rejects.

**The remaining row is the one that matters.** Every argument in this file rests on
two numbers from a single S#274 measurement. The audit log records every call, so
answering it properly is cheap and nobody has done it. **Do not optimise further
before it is answered** — that is exactly the shape of mistake this repo keeps
making.

## The trilemma as currently understood

Three properties. So far nobody has found a way to get all three.

| | 0 install | 0 standing cost | Trust-anchored |
|---|---|---|---|
| `curl` against `/api/rpc` | yes | yes | **no** |
| Installed CLI | **no** | yes | yes |
| MCP server | yes | **no** | yes |

**"Trust-anchored" means: the interface arrived through a deliberate out-of-band
act by the operator** — editing a config, running an install — rather than
through a message the agent was told to trust. That property is not decoration;
it is the thing that survived a partner's Claude refusing us on 2026-08-16, and
the pasted-instruction path is what it refused.

**The uncomfortable consequence:** Erik's stated goal (0 install AND 0 cost) is
satisfied only by the cell that looks most like an attack to a careful agent.

## Options identified, none built

1. **Collapse 12 MCP tools into 1 with an `op` discriminator.** Keeps MCP's trust
   anchor and discoverability; cuts standing cost by roughly ninety percent.
   Loses ergonomics — twelve well-named tools are easier for a model to use
   correctly than one with a mode switch, and we would probably lose the S#271
   result where Gemini found `bridger_ask` unprompted. **Not measured:** whether
   one fat schema actually prices better than twelve thin ones.
2. **Add the ledger operations to the CLI.** `lib/operations.ts` holds the
   behaviour and `/api/rpc` already exposes it; the CLI has the operator and
   partner commands but **not** `ask` / `answer` / `decide` / `wait` / `read`.
   Adding them is thin-client work, exactly like `bridger verify`. Runs from the
   repo — no publish needed to test the shape.
3. **A single-file drop-in script.** An out-of-band deliberate install that
   claims no npm name. Ugly, but it tests whether the CLI shape helps before a
   name is spent on it.
4. **Publish a real CLI to npm.** The clean version of 2. **Blocked on the name**
   — publishing claims a package name permanently, and the name is parked
   (`DECISIONS.md` 2026-08-17). Worth knowing that the naming decision now gates
   the cheapest trust-anchored transport, which is sooner than "when we have
   credibility".

## What was considered and rejected

**Inventing a new wire protocol.** We already have one — `/api/rpc` is ours, flat
POST with an `op` field, no MCP anywhere. A third encoding would change nothing:
the cost is a property of **where the interface lives** (resident in context vs
fetched on demand), not of the wire format. And a bespoke protocol's real cost is
adoption — MCP's value is that `claude mcp add` exists and every client vendor is
converging on it.

## The reframe that generated most of the above

Stop asking "which protocol". Ask **"is the interface resident or on-demand?"**

- **Resident** (MCP tools): discoverable without being told; billed every turn
  forever.
- **On-demand** (`/api/rpc` + the `/j/<code>` document, or a CLI): free after the
  first read; must be pointed at.

Any future option should be classified this way first. It predicts the cost
before anything is built.

## Where to pick it up

1. **Measure a real day from the audit log.** Cheap, unanswered, and everything
   else is guesswork until it lands.
2. Try the single-tool collapse and measure it against the current surface.
3. Add ledger ops to the CLI, run from the repo, no publish.
4. Only then decide what to default a partner to.

**And keep looking for the fourth cell.** Erik's instinct is that one exists.
Nothing here rules it out — the table is a record of what has been tried, not a
proof of impossibility. Candidate directions nobody has examined yet: whether a
client can load a tool schema lazily on first use; whether an operator-installed
shim can register itself with the client without a per-turn schema; whether the
trust anchor can come from somewhere other than the install act.
