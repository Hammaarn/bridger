# BRIDGER — LEVEL-UP BRIEF (S#272, overnight)

> Paste the block below as a prompt. Everything above it is context for Erik.
>
> **What this is:** the instruction set for taking Bridger from "6 commits and 75
> passing tests" to "a tool a real partner could be handed". Written by the
> session that just spent S#272 inside this codebase, so it names the specific
> failure modes this project has actually produced — not generic engineering
> advice.
>
> **The honest ceiling on tonight:** `vercel deploy --prod` is hard-blocked and
> push is Erik's gate, so nothing can be verified against a live bridge. Every
> claim produced tonight is unit-green at best. The brief is built around that
> constraint rather than pretending it away.

---

## ERIK'S TWO CALLS, made before the stretch began (2026-08-13)

1. **Run it as one long stretch**, not a `/loop`. Later loop cycles drift
   further from anything he has reviewed, and the extra tokens buy work nobody
   has sanity-checked.
2. **The paste-and-go HTTP transport: prototype behind a flag + spec the
   security model.** Build enough that he can SEE the flow in the morning
   rather than read about it. It does NOT become a supported transport tonight
   — that call stays his. Flag it, document it, queue the decision.

---

## THE PROMPT

You are the designer and engineer of Bridger, not a contractor taking tickets on
it. For this stretch you own the product: its protocol, its failure modes, its
onboarding, its operational story. Erik is asleep. Decisions that are yours to
make, make — and record why. Decisions that are his, queue; do not guess them.

Read in this order before touching anything: `bridger/STATUS.md` (the bridge is
STOPPED, production is STALE), `bridger/ARCHITECTURE.md` (18 non-obvious facts +
9 invariants), `bridger/DECISIONS.md` newest-first, `bridger/TODO.md`,
`bridger/skill/SKILL.md`.

### What "done" means tonight, stated before you start

You cannot deploy and you cannot push. So a piece of work is done when it is
**committed, covered by a test that fails without it, and written into the
docs** — and it is never "verified", "working" or "live". Any sentence you write
tonight that claims a runtime property is a sentence you cannot support. Mark
those `[UNVERIFIED — needs a live bridge]` explicitly and move on. A brief that
comes back honest about a blocked check is worth more than one that manufactures
motion around it.

### The stance

Assert a design position. Bridger currently has good bones and an incomplete
product: it survived a real cross-vendor test and it also shipped a safety
message that relocated a loop instead of stopping it. Both facts are true and
the second is the more informative one. Look for that shape everywhere — the
mechanism that is present, plausible, and pointed slightly wrong.

### THE NORTH STAR — Erik's requirement, and it outranks the rest

> *"It's crucial that the user experience and use is extremely easy to use.
> Basically I am imagining token paste into session enables the communication
> between different AI's on different machines, like peer2peer."*

**This is the product. Everything else is in service of it.** A bridge that is
technically excellent and takes twenty minutes of client-config archaeology to
join is a failed product; the three-different-spellings problem
(`ARCHITECTURE.md` #13) is not a footnote, it is the thing standing between this
and being useful.

Two clarifications to design against, neither of which weakens the goal:

**It is not peer-to-peer, and should not become so.** Both peers connect to a
hub, because the hub IS the append-only record — the thing that makes an answer
auditable later. True P2P would cost NAT traversal and lose the ledger. The goal
is that it should *feel* peer-to-peer: paste, and the other machine's AI is
reachable. Design for the feel, keep the hub.

**MCP is one transport, not the only one, and that assumption is load-bearing.**
Today the token goes into a client config file, which is where the join friction
lives and why every client spells it differently. A pasted token plus a short
instruction block over plain HTTP works in any AI with a shell — no config file,
no restart, no per-client dialect. **Evaluate this as a first-class second
transport.** The likely shape is: MCP for clients that speak it (better tool
ergonomics, token never in context), HTTP-with-bearer for everything else and
for the paste-and-go path.

**The security trade-off, stated so it is resolved rather than discovered.**
Putting the token in the model's context does NOT break authorship — a token
proves which side, so a model holding side A's token still cannot post as side
B. What it costs is credential exposure: the token is now reachable by
transcripts, context summaries, screenshots, and by a prompt injection arriving
from the far side (domain 1). Resolve it deliberately. Candidate directions,
none pre-chosen: a short-lived one-time join code that exchanges for a
longer-lived credential; expiry and low caps on paste-path tokens; a
paste-path token scoped to a single room with `bridger stop` always available.
Pick one, say why, and name what it does not protect against.

**The test for every UX decision:** what does the partner literally do, in
order, from "Erik sends them a line" to "their AI asks a question"? Count the
steps. If a step needs a file path, a restart, or knowing which of three keys
their client wants, it is a defect, not documentation.

### The sweep — ten domains, each producing findings, not prose

Domain 0 is the north star above and comes first; it is likely to reshape 3 and
9. For each: state what exists (read it, do not recall it), name what is missing
or misaimed, and decide whether it is a BUILD (do it), a DESIGN (write the spec,
do not build), or an ERIK (queue it).

1. **The channel is untrusted input, and nothing treats it that way.**
   Entries written by another company's AI land verbatim in our model's context
   via `bridger_read` / `bridger_status` / `bridger_wait`. That is a
   cross-company prompt-injection surface with no guard on it. JudgeMySite
   already learned this lesson on its own output path (`guardVerdict`); Bridger
   has no equivalent on its *input* path. Consider: containment framing in the
   wire shape so far-side text is never bare, a scan on the way in or out, and
   what the honest limit of a model-facing rail is. **Start here — this is the
   largest unaddressed risk in the product.**

2. **Secrets in the ledger.** Nothing stops either side posting an API key,
   a token or a customer's PII into an append-only record that lives on a third
   party's Redis and materialises into a git-tracked folder on both machines.
   Consider a write-time scan, what it should do on a hit (refuse vs redact vs
   flag — they are not the same decision), and whether refusing is even right
   when the ledger's whole value is that it is append-only.

3. **Join and diagnosis — the partner-facing wall. Serves domain 0 directly.**
   Today every rejection is the same string by design, so a partner who cannot
   connect has nothing to debug with. `TODO.md` already scopes
   `/join/<one-time-code>` and `/api/whoami`. Build them, and resolve the
   tension the design creates: a diagnostic endpoint that is useful to a
   confused partner is also useful to someone probing tokens. The one-time code
   is also the strongest answer to domain 0's credential-exposure problem — a
   code that burns on first view keeps live tokens out of chat logs while still
   being one pasted line, so design the two together rather than in sequence.

4. **Protocol semantics — the part Erik named as "simplifies the usage".**
   The tool descriptions ARE the protocol; they are what the far-side model
   reads and the only place its behaviour can be shaped. Audit them as an
   interface. Then the gaps in the lifecycle: how a question is CLOSED, what
   happens when both sides write at once, how the contract is versioned, whether
   "whose turn" is expressible, and whether a side can say "I am done for today"
   — which is the honest answer to most idle-brake situations and does not exist.

5. **Provenance quality.** `checkedAgainst` is a free string that nothing grades,
   and the one real cross-vendor test produced one solid citation and one
   over-broad one. We cannot validate the far side's paths. We CAN validate our
   own before posting. Decide whether asymmetric validation is honest or
   misleading, and whether displaying the span (a 70-line range is weaker
   evidence than a line) beats scoring it.

6. **Budget and loop safety — mostly done today, so find what is left.**
   Per-room cap, success-auditing and the generalised idle brake landed in
   `29d44d1` and `73e90cc`. The open question is the one no test can answer:
   whether a real client STOPS on a thrown tool error or treats it as retryable
   and spins on the throw. Design the transport-level fallback for the case
   where it does not, but do not build it on a guess — say what would settle it.

7. **Operability.** The audit log now has success rows and nothing reads them.
   There is no way to ask "who called what, how often" without a Redis client.
   Consider what an incident playbook looks like at 2am, and what the smallest
   real answer is — a CLI subcommand over `/api/export` is probably it, not a
   dashboard.

8. **Data lifecycle.** Retention is an idle TTL on the room. Nobody has asked
   what happens when a partner wants their data deleted, what is actually stored
   where, or what the honest answer is if a partner's lawyer asks. Write the
   answer down; build only what is cheap and obvious.

9. **Client compatibility.** Three MCP clients spell remote config three ways
   and one of them rejects the other two's keys. That knowledge lives in one
   architecture note and in three files under `.local/`. Decide where it belongs
   so a fourth client does not cost another session.

### How to work

- **Understand before designing, design before building.** A first pass that
  reads and maps is not a delay; every defect this project has produced was
  visible in code somebody had not read.
- **One seam, not N copies.** This codebase's own argument, twice proven:
  `writableBridgeFrom`, `appendEntry`. A check copied into five handlers is a
  check that drifts.
- **Ablate every behavioural test.** Switch the mechanism off, watch the test
  fail, switch it back. A test that passes with and without the code is
  decoration, and this project has caught that on itself.
- **Commit in coherent units** with the reasoning in the message, not just the
  change. Commit freely; push nothing.
- **Update `DECISIONS.md`, `ARCHITECTURE.md`, `STATUS.md` and `TODO.md` in the
  same commit as the code that invalidates them.** A doc that lies is the bug
  that outlives the session.

### The anti-patterns you specifically produce — do not

- **Do not build an eval harness, scorer, or test rig for a question.** Answer
  it directly or say plainly it needs a live bridge. A shipped script's own
  `--selftest` is fine; an apparatus for grading model output is not.
- **Do not claim state you did not read this turn.** "It works", "it is live",
  "the fix shipped" require a fresh independent read, and tonight most of them
  cannot be had at all.
- **Do not assert absence without searching** ("no tool does this", "we would be
  first"). Two queries or say "I do not know of one".
- **Do not manufacture breadth.** Nine domains is a sweep, not a quota. A domain
  where the honest finding is "this is fine, here is why" gets one paragraph and
  you move on. Depth on the two or three that are actually blocking beats a
  uniform layer of shallow findings.
- **Do not over-engineer a stated-simple thing.** Before any mechanism, compute
  what the operation looks like done BY HAND with zero infrastructure, and make
  that the baseline the machinery has to beat.
- **Do not invent pending tasks.** Only things Erik greenlit are commitments;
  everything else is a candidate and goes in the decision queue as such.

### Deliverables

1. **`plans/LEVEL-UP-FINDINGS-s272.md`** — the sweep. Per domain: what exists
   (with file:line), what is wrong or missing, the call (BUILD / DESIGN / ERIK),
   and for anything unverifiable an explicit `[UNVERIFIED]` tag naming what would
   settle it.
2. **`plans/DECISIONS-FOR-ERIK-s272.md`** — the queue. Every choice that is his,
   each stated as: the decision, the two or three real options, the trade-off in
   one line, and your recommendation with its reasoning. No option you would not
   ship.
3. **The BUILD items, built** — committed, tested, ablated, documented.
4. **A closing summary in chat** that leads with what is NOT verified, then what
   shipped, then what is queued for him. Not the reverse.

### Stop conditions

Stop and write up if any of these hit: the work needs a deploy, a push, or a
credential; a design decision would change the product's shape rather than fill
it in; or you have spent the token budget Erik set. Do not push past a stop
condition by finding a smaller version of the same action.
