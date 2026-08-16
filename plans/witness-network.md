# The Witness Network — parked idea, S#275

> **STATUS: PARKED. Not started, and deliberately gated.**
> Nothing here is buildable until **one far-side agent completes a single round
> trip between two known parties.** As of 2026-08-17 that number is zero. This
> design is the same mechanism with strangers and N sides, so every failure the
> two-party bridge has now would multiply. The gate is at the bottom of this file
> and it is not a formality.

---

## Where it came from

On 2026-08-16 a partner's Claude was handed a Bridger token and refused to use
it. That refusal produced better analysis of our own product than we had, and it
led directly to the public repo, `VERIFY.md`, `SECURITY.md` and `/api/about`.

Erik's question was: could that be a feature? A channel where one session pings
with a question and other people's opted-in sessions answer.

## The correction that makes it work

**The value was not "another Claude answered." It was "another Claude with a
different stake and no shared context said no."**

That session was rigorous because it was *defending something* — its operator's
production credentials. It had skin in being right. It also could not be primed
by our history, which is why it caught that the credible-sounding detail in our
message ("JudgeMySite") came from its own context rather than from evidence.

An opt-in **help** channel selects for helpfulness, and a volunteer answering a
stranger defends nothing and pays nothing for being wrong. That produces fluent,
agreeable, unverified answers — the default failure mode, and the exact thing
`checkedAgainst` exists to catch. **Helpfulness is not the ingredient.
Independent stake is.**

So: not a help network. A **witness network**.

## The discriminator

> **Is the question answerable by reasoning, or only by looking?**
>
> - **Reasoning** → the asker's own model already can. A stranger adds noise.
> - **Looking** → a stranger with the right vantage is irreplaceable.

Only the second kind may be posted. Erik's own phrase — *"someone else's on a
different region"* — is the sharpest statement of this, and it is a
**measurement** feature rather than a social one. Region, OS, client version,
hardware, install state: all vantages the asker does not have.

Questions that qualify:

- Does this endpoint return 429 from an EU IP but not a US one?
- What does Antigravity's live `mcp_config.json` actually look like on your disk?
  *(Asked for real in S#275 — this is the canonical shape.)*
- Does v4.2 of this library truly read `options.timeout`? Check your
  `node_modules`.
- Does this render correctly on Safari 17 on real hardware?

Questions that do not: anything beginning "what's the best way to…", any design
opinion, anything a web search answers.

## The knowledge directory, and the constraint that has to be structural

Erik's extension: findings accumulate into a shared, organised corpus that
sessions worldwide can pull from.

**The question it must survive: what does it hold that is not already training
data or one web search away?** Most of "issues, tricks and tips organised by
topic" is Stack Overflow, and the models already ate Stack Overflow. A worse
Stack Overflow with no users is the default outcome.

The narrow band where it is genuinely unserved:

1. **Negative results** — "I ran X, here is the output, it does not work."
   Almost nobody publishes these and they are the most expensive class to
   rediscover.
2. **Doc-contradicting findings.** S#275 alone: `technical#14` was wrong twice
   about prompt-cache floors; Stagehand reads `options.timeout` where its docs
   imply `timeoutMs`; `agent-browser close` prints success while eleven
   processes live. **None of that is on the internet.**
3. **Environment-bound facts with a short shelf life** — a config path that is
   true this month, on this OS, for this client version.

**So the corpus stores reproduced negative results, not tips.** That constraint
has to be enforced by the schema, not stated as a guideline, or it becomes slop
within a month.

## The failure mode that kills projects like this

An unmoderated corpus that AI sessions pull from automatically is a supply chain
for confident wrong answers. Entries get cited, citations become authority, and
**median entry quality falls as the corpus grows** — which inverts the network
effect it was built for. Virality makes it worse, not better.

`checkedAgainst` is a partial defence and nobody else has it: an entry naming no
artifact is stored as unchecked. Stack Overflow measures popularity; this
measures whether anyone actually looked.

**It is not sufficient, and we have direct evidence.** In S#271 we hand-audited
Antigravity's two citations and found one solid and one over-broad. The field
grades the citation, not the claim. Left alone it becomes a checkbox filled with
a plausible path.

## The rule that makes it trustworthy: reproduction, not reputation

**An entry earns trust when a second, unrelated witness runs the same command and
reports the same output.**

This is the identical principle as the hash chain shipped in S#275: one observer
proves nothing, two independent ones make it evidence. It is mechanically
checkable, it cannot be gamed by being popular, and it is the only version of
this corpus that should ever be pulled unsupervised.

Proposed entry states: `claimed` (one witness) → `reproduced` (two independent,
matching output) → `contested` (two witnesses, diverging output — which is itself
a valuable finding, usually meaning the answer is environment-dependent) →
`stale` (age-expired, needs re-running).

**`contested` is not a failure state.** A divergence between two machines is
often the most useful thing the network can produce.

## Consent

Erik's design, kept: opt-in as a Helper; a pinged session's answer is **approved
by its human before it is sent**. The request taxonomy
(Assistance / Question / Feedback) is ceremony and can be dropped or added later;
two-sided human consent is the load-bearing part and should be built first.

## Prior art — checked 2026-08-17

- **[AI Agent Link](https://www.indiehackers.com/post/i-built-a-network-where-ai-agents-help-each-other-heres-what-i-learned-a5cc722296)**
  — P2P network where agents post requests and others' agents fulfil them, with
  credits and a requester-side validation gate. **Task delegation**, not
  observation.
- **[Microsoft Research agent society](https://www.microsoft.com/en-us/research/blog/red-teaming-a-network-of-agents-understanding-what-breaks-when-ai-agents-interact-at-scale/)**
  — 100+ always-on agents, each tied to a human principal, with forums, DMs, a
  marketplace and an upvote-based reputation system. A research sandbox.

**The shape is not novel.** What neither has is *receipts*: they trade tasks and
reputation. Reproduction-gated observation with a named artifact is the part
nobody is doing, and it is the part Bridger is already built for.

## What it costs

**This is the thing that forces the N-party rewrite.** A channel is inherently
many-party, and two-ness is the data model — `SideId = "a" | "b"`, `otherSide()`
is a boolean flip, entry ids are namespaced per side, "the peer" is singular in
whoami, the wait cursor and the idle brake. This is not a feature on top of
Bridger; it is the reason to rebuild its core. See `DECISIONS.md` 2026-08-17.

It is also **the first network effect in the product.** Two-party rooms are
islands — a room is worth the same at three users or three thousand. A witness
network improves with *density of vantages*. Different business shape, and a
better one.

---

## [!!] THE GATE

Do not start this until **all** of the following are true:

1. One far-side agent has completed a full round trip on a two-party bridge —
   joined, read, written an entry with a real `checkedAgainst`.
2. The burn-on-read invite bug is fixed (`TODO.md` item 1).
3. Erik has seen the two-party product used by someone who is not him.

**Rationale, in his own words (S#275):** *"Focus on the core product first and
make it fully functional and tested, then proceed with the add-ons."* This file
exists so the idea survives without competing with the thing that has to work
first.
