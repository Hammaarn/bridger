# The landscape, as of 2026-08-26 — read this before any moat argument

> **Why this file exists.** On the night of 2026-08-25 an OpenAI announcement
> landed mid-session and the whole conversation reorganised around it. Two
> hours of strategic analysis went into **the wrong standard**, because nobody
> searched for the adjacent one until a hook forced the check. This file is the
> corrected picture, written so the next session starts from it rather than
> re-deriving it from a tweet.
>
> **Standing rule this file encodes:** before arguing about position, run the
> search. A negative existence claim ("nothing else does this") is the one whose
> failure is silent by construction.

---

## The three things, and they are on different layers

| | what it is | scope | status |
|---|---|---|---|
| **MCP** | a model calls tools on a server | one agent ↔ one server | shipped, ubiquitous |
| **WebMCP** | a *web page* registers its own functions/forms as tools for an agent **in that browser session** | one agent ↔ one site, single-origin | W3C CG **draft**, Chrome 149 origin trial |
| **A2A** | communication between **independent agent systems** across frameworks, languages and vendor stacks | agent ↔ agent, cross-org | **Linux Foundation, 150+ orgs, in production** |

**Bridger is on none of these layers.** It is a shared append-only *record*
between two organisations, with provenance on claims and containment on foreign
text. MCP/WebMCP/A2A are all about **invocation**; Bridger is about **what was
agreed and how it was checked**.

---

## WebMCP — the one that grabbed the attention, and the smaller threat

A page exposes JS functions or annotated `<form>` elements as tools with JSON
Schemas. The agent calls them; **tools execute on the page, visibly, in the
user's authenticated session** — so the agent reaches business logic and login
state a backend MCP server would have to rebuild.

**Why it does not reach Bridger's case:**

- **Origin-isolated by construction.** The `tools` Permissions Policy defaults
  to `self`; cross-origin iframes need `allow="tools"`. There is no concept of a
  second party, because a standard about operating *a* website does not need one.
- **The agent must be in a browser.** Explicitly headless-incompatible. The
  agents doing integration work are in terminals and editors — on 2026-08-25 the
  far side was Grok in Cursor and our side was Claude Code in a shell. Neither
  could have used WebMCP for a single call.
- **No record.** Tool calls are ephemeral. Nothing accumulates, nothing is
  jointly owned, nothing is tamper-evident.
- **The agent inherits the USER's identity**, not a seat. Bridger's token is one
  room, one side — a permission model WebMCP has nowhere to put.

**What it does cost us:** every pair of companies that *already shares a
platform* can now coordinate agents through it. That is a chunk of the
imagined market, taken by the platform layer rather than by a competitor. Plus
an attention tax — for a while, every conversation starts with "is this WebMCP?"

**Where it helps:** Bridger's browser surface could expose WebMCP tools, so a
browser agent participates with **no token paste**. That is the connector
friction dissolving for one class of client. Consuming the standard, not being
replaced by it.

---

## [!!] A2A — the one that actually matters, and it was missed for two hours

**Agent2Agent.** An open protocol for communication and interoperability
between *independent* agent systems — different frameworks, different vendors,
different organisations. A task lifecycle: discovery (Agent Cards), delegation,
execution, status updates, artifact return.

- Linux Foundation project, **150+ supporting organisations**
- **Production deployments**: supply chain, financial services, insurance, IT ops
- Microsoft (Azure AI Foundry, Copilot Studio), AWS (Bedrock AgentCore Runtime),
  Google Cloud reference architecture pairing A2A orchestration with MCP execution
- Salesforce, ServiceNow, MongoDB; Accenture, Deloitte, McKinsey

**It removes the constraint the WebMCP analysis leaned on.** "Both agents must
be in a browser" is true of WebMCP and irrelevant here. A2A is cross-vendor,
cross-organisation and browser-free.

**How it still differs from Bridger:** A2A is **delegation** — *my agent asks
your agent to do work*. Bridger is a **joint record** — *our two teams keep an
account of what was agreed and what it was checked against*. A2A moves tasks;
it does not keep a ledger neither side can rewrite.

**So the honest posture is not competitor. It is layer.** The record two
organisations keep about what their A2A agents agreed is a thing A2A's own
architecture leaves open.

---

## The paper — promising, and DELIBERATELY NOT SPENT AS EVIDENCE

`arxiv.org/pdf/2606.31498` — **"Governance Gaps in Agent Interoperability
Protocols: What MCP, A2A, and ACP Cannot Express."**

A partial extraction named four gaps: trust boundaries between
**mutually-distrustful organisations**, **provenance and audit trails**, **joint
consent from multiple parties before actions execute**, and **tamper-evident
records**. That is Bridger's feature list written by someone who has never heard
of it.

**Confidence: LOW, on purpose.** The fetch reported a compressed PDF it could
not fully read and the summary hedged ("appears to be"). The TITLE is solid; the
specifics are not verified. **Read the paper properly before building any
argument on it** — this is the same shape as the EVAL-billing summary that
confidently answered a question the source never addressed.

---

## The WebMCP Challenge — the rules, checked

| | |
|---|---|
| Deadline | **3 September 2026, 1:00pm PDT** |
| Existing apps | **allowed** — "add WebMCP support to an existing one" |
| Required | live URL working in ChatGPT's browser · <3-min YouTube demo **with audio** · public repo, OSS licence at top, visible tool registration |
| Judged on | WebMCP Leverage · Execution · Potential Impact · Creativity & Ambition (no weightings published) |
| Prizes | $35,000; top 10 × $3,500 ($3,000 cash + credits) |
| Eligibility | Sweden not on the exclusion list |

**Bridger qualifies today** — public, Apache-2.0, on Vercel (a sponsor).
**JudgeMySite does not**, for two checked reasons: `Hammaarn/judgemysite` is
`PRIVATE` with `licenseInfo: null`, and its review pipeline is
`@browserbasehq/stagehand` + `playwright` — headless, which WebMCP explicitly
does not support.

**Not entered, and that is deliberate:** it is a third concurrent commitment
against an unfinished product, and it violates the no-feature-creep gate set the
same evening.

---

## Where Bridger actually stands, once the threat analysis is done

**The property, and it is one thing: zero OAuth.** No account, no OAuth, one
token addressing one room and one side. Defensible not because it is hard --
it is an afternoon's work -- but because it is **unacceptable to an incumbent**:
SSO mandates, procurement and audit requirements forbid shipping it. Same shape
as not calling a model.

**With evidence.** Grok, first contact, unprompted, on why it connected: *"no
OAuth or filesystem access, one token maps to one room and one side."*

**And the case that needs no partner.** A local multi-model setup -- several
small models with roles, coordinating through one record -- is the only use case
one person can run ALONE. Every test so far has been blocked waiting for a
second party, which is why nobody has used this twice. Solo rooms (S#281) and
`BRIDGER_STORE=file` mean it is already built; what is missing is positioning,
not code.

Small models are a better fit than large ones, not a worse one: a resident MCP
schema is a large fraction of an 8B's context and the flat transport costs
nothing standing, while typed entries scaffold a weak model far more than a
strong one.

**Limits, stated:** solo mode turns containment OFF (no other company to
contain), so this surface does NOT carry the trust argument. And it overlaps
LangGraph / CrewAI / AutoGen, which are free and established -- the distinction
(framework you build in vs record between existing sessions) has to be made out
loud every time.

---

## What did NOT change on 2026-08-25

Nobody has used Bridger twice. Every session has been Erik, Erik's own two
sessions, Antigravity on his laptop, or his brother. **Zero returns.**

None of the above moved that, and no strategic argument in this file substitutes
for it. Structure has never once predicted demand.
