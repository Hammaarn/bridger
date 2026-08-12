# BRIDGER — LEVEL-UP SWEEP, S#272

**Written overnight, 2026-08-13.** Ten domains from `LEVEL-UP-BRIEF-s272.md`.

> **NOTHING HERE IS RUN-GREEN.** The bridge is stopped and production is stale;
> `vercel deploy --prod` is hard-blocked and push is Erik's gate. Every claim
> below is from reading the code or running the test suite on this machine. No
> live request has met any of it. Where a question can only be settled by a real
> bridge it is tagged `[UNVERIFIED]` with what would settle it.

**Tests: 123, up from 55 at the start of the day.** Every behavioural mechanism
added tonight was ablated — switched off, watched fail, switched back.

---

## The two findings that were not on the plan

Both came out of things that looked like noise. They are the most valuable
things in this document, and neither was a domain in the brief.

### F1. The test suite was flaky, and the flake was a real security bug

`file-store.test.ts`'s cross-process revocation case failed roughly **four runs
in six**. The cause was not the test.

`FileStore.refresh()` reloaded only when `mtime !== seenMtimeMs`. Filesystem
timestamps are coarse enough that another process's write routinely lands on the
value we already recorded — and then the reload is skipped. Worse than a narrow
race: **nothing moves the mtime afterwards, so the miss is permanent** and a
revoked token keeps working indefinitely.

That is precisely the failure the mtime check was *added* to prevent — the
file's own docstring calls it *"a revocation that reports success and does
nothing"*. The optimisation reintroduced the bug it was written to fix. Affects
`BRIDGER_STORE=file`, the local two-sessions-on-one-machine mode the README
endorses. **Fixed** (`fa32ca4`): three signals — mtime differs, size differs, or
the file is younger than a 2s trust window — plus a `pendingWrites` guard so
reloading cannot roll back an unflushed write.

*Residual, not defended against: a same-size write landing on an identical mtime
more than 2s old. A real write sets mtime to now, so this needs a deliberately
forged timestamp.*

### F2. `del` reported the wrong number, and it silently broke single-use codes

`FileStore.del` and `FakeStore.del` both returned `keys.length` — **the number
asked for**, not the number removed. Redis returns the true count.

`redeemInvite` uses that count as its burn lock (checking existence before
deleting would be a plain time-of-check/time-of-use race). So a single-use join
code issued **two tokens** on the file backend while behaving correctly hosted.
The `Store` interface never stated the contract, so neither implementation was
strictly wrong — which is how it survived.

**Fixed** (`9ed9ecc`): the contract is documented on the interface, both local
implementations match Redis, and three tests pin it. Found only because I wrote
a concurrency test for the invite burn.

**The generalisation worth keeping:** a cross-implementation contract with no
test holds only on whichever backend someone happens to run.

---

## Domain 0 — Paste-and-go. THE NORTH STAR

**What existed.** Joining meant putting a token in a client config file. Three
known MCP clients spell that file three different ways and Antigravity rejects
the other two's keys (`ARCHITECTURE.md` #13). A partner hit that wall blind,
before ever seeing the product work.

**The by-hand baseline, computed first.** With zero infrastructure, joining is
already *"paste one `curl` command with a bearer token"*. That works today. So
only two things were worth building: the **whole operation set** (an agent needs
to know what it can do, not just how to do one thing) and **keeping a live
credential out of a durable chat message**. Everything else would have been
decoration, and most of what a "join system" usually contains is decoration.

**BUILT** (`9ed9ecc`, behind `BRIDGER_PASTE_PATH=1`):

- `GET /j/<code>` — plain text, burns the code, returns a working token plus
  every operation with a copy-pasteable `curl` and the four rules of the record.
  Plain text because the reader is a language model: HTML buries content in
  markup it must strip, JSON makes it rebuild prose from fields.
- `POST /api/rpc` — `{op, ...args}`, bearer auth, **the same argument shapes as
  the MCP tools**. A partner who starts here and later moves to MCP should not
  relearn the API, and a divergence between them would go unnoticed for months.
- `bridger invite` — prints the single line to send.

**One design question settled rather than guessed.** The objection to
URL-pasting is *"what if their AI cannot fetch?"* — but fetch capability is a
**precondition** of an HTTP transport: an agent that cannot make a request
cannot call the bridge at all. The objection dissolves, so the safer option is
also the only possible one. Anyone who cannot fetch should use MCP.

**The step count, which is the real test.** From "Erik sends a line" to "their
AI asks a question": (1) paste the line, (2) their AI fetches it, (3) their AI
calls `{"op":"ask"}`. No file path, no restart, no per-client dialect.

**`[UNVERIFIED]`** — no far-side agent has ever done this. What would settle it:
one real partner session redeeming a code and posting an entry. Specifically
unknown is whether a given client fetches a pasted URL without being told to.

## Domain 1 — The channel is untrusted input. **BUILT**

**What existed: nothing.** A grep for `sanitiz|guard|redact|escape|untrusted`
across `lib/ app/ cli/` returned **zero hits**. Every entry is written by another
company's model and lands verbatim in ours.

Text travels three paths, and the second is the one that is easy to miss:
`wire()` (read/wait/write-echo), `openQuestions[].title` in status (reads like
metadata, is actually the partner's prose), and the contract body — at 100,000
characters the largest untrusted payload the API accepts, and the one most
likely to be read as a specification and implemented against.

**Built** (`4a73153`): `lib/untrusted.ts`, applied at every seam.

**Be precise about what protects you, because the weaker half looks stronger:**

| | Kind | Bounds an attack? |
|---|---|---|
| `escapeMarkers` | Deterministic string surgery | **Yes.** Far-side text cannot close our container early and forge our framing. |
| The `[[UNTRUSTED-PARTNER-TEXT]]` banner | A rail — an instruction to a model | **No.** It raises the cost. Nothing pins it. |

The tests pin the escaping. Nothing can pin the banner. The deterministic
defence — refusing to show far-side text at all — is the product, so containment
plus escaping plus a named container is the honest ceiling here.

Applied uniformly rather than only to `side !== yours`: our own past entries are
still data to a fresh session, and a conditional container is absent exactly
when someone mis-computes the condition.

## Domain 2 — Secrets in the ledger. **BUILT**

An entry reaches a third party's Redis, another company's session, and both
sides' git history via `bridger pull`. Append-only, so a secret written here
cannot be taken back; the only remedy is rotation on someone else's schedule.
`SKILL.md` said "do not paste secrets" — a rail, aimed at an agent that may not
even have our skill installed.

**Refuse, not redact.** Redact rewrites an author's words inside a record whose
whole value is being a faithful account, and still ships the original to Redis
first. Flag durably stores the secret *and* announces it. Refusing costs one
rewrite and loses nothing, because nothing was appended — append-only is not
violated by refusing to append.

**No entropy heuristic, and this is the load-bearing choice.** `checkedAgainst`
exists to carry commit SHAs and file paths — exactly what a long-hex or
high-entropy rule fires on. A scanner that refuses provenance refuses the
product. Known vendor prefixes and structural formats only; nine
false-positive cases are pinned in tests (`commit a2b0f35`,
`lib/external/usage-report.ts:41`, …). A missed bespoke secret is survivable; a
blocked citation is not.

**Two call sites, one scanner** — `setContract` writes to Redis *before* calling
`appendEntry`, so a single scan in the latter would have refused the caller while
the 100k body sat stored.

The refusal is deliberately **not** shaped like the STOP messages: retrying works
once the secret is removed, and reusing loop-ending vocabulary for a one-edit
problem makes a well-behaved agent abandon a task it could finish.

## Domain 3 — Join and diagnosis. **PARTLY BUILT, one item queued**

`/j/<code>` is built (domain 0). **`/api/whoami` is NOT.** Every rejection is
deliberately the same string, so a partner who cannot connect has nothing to
debug with — and the tension is real: an endpoint useful to a confused partner
is equally useful to someone probing tokens.

**My recommendation, queued as D3:** `whoami` answers only for a **valid** token
(*"valid, room X, side B, last seen 3m ago"*) and returns the standard opaque
refusal otherwise. That helps every honest partner — whose token *is* valid, and
whose actual problem is "am I even reaching the right bridge?" — and tells a
prober nothing they did not already know by holding a working token. Not built:
it is a new public surface and that is Erik's call.

## Domain 4 — Protocol semantics. **DESIGN, not built**

The tool descriptions *are* the protocol — they are what the far-side model
reads and the only place its behaviour can be shaped. Audited; they are good.
Three genuine gaps in the lifecycle:

1. **A question closes on the first answer referencing it.** `openQuestions`
   derives "answered" from any `answers: <id>` entry. There is no way to say
   *"that did not actually answer it"*, and no reopen. The asker — the one
   person who knows whether they got an answer — has no say.
2. **The contract is replaced wholesale and the ledger records only
   `"<N> chars"`.** You cannot see *what* changed, which makes the entry nearly
   useless for the one edit the docs call "the most expensive edit either side
   can make". A stored `previousLength` + a diff summary would cost little.
3. **No way to say "I am done for today".** This is the honest answer to most
   idle-brake situations, and its absence is why the brake has to guess. A side
   that could sign off would let `status` say *"their side signed off 2h ago"*
   instead of a partner's agent inferring silence.

All three change the product's shape rather than fill it in, so per the brief's
stop condition they are queued (D4), not built.

## Domain 5 — Provenance quality. **DESIGN**

`checkedAgainst` is a free string nothing grades. The one real cross-vendor test
produced one solid citation (`plans/05-ux-architecture.md:925-994`) and one
over-broad one (`CLAUDE.md:21-29`, where only line 29 was relevant).

**We cannot validate the far side's paths — and we cannot validate our own
either.** The server has no access to either machine's filesystem. Any
"validation" would have to happen client-side in the agent that is making the
claim, which is exactly the party whose honesty is in question. **Asymmetric
validation would be worse than none:** a green tick on our side and nothing on
theirs reads as a judgment about *them*.

What is honest and cheap: **display the span, do not score it.** A cited range
of 70 lines is weaker evidence than a cited line, and simply surfacing
`(70 lines)` next to a citation lets a human weigh it without the system
pretending to know. Queued as D5.

## Domain 6 — Budget and loop safety. **DONE TODAY; one open question**

Per-room cap, success-auditing and the generalised idle brake all landed
(`29d44d1`, `73e90cc`). The rotation bypass — where an operator following our own
refusal text handed a looping agent a fresh 400 — is closed.

**The open question no test can answer:** does a real client **stop** when a tool
throws, or treat a tool error as retryable and spin on the throw? If it spins,
the message is not doing its job and the next lever is refusing at the transport
level before the handler runs.

**`[UNVERIFIED]`** — what would settle it: one live loop against a real client,
watching whether calls stop after the brake fires. I have **not** designed the
transport-level fallback in code, because building it now would be building on a
guess about which way that goes.

## Domain 7 — Operability. **PARTLY BUILT**

**The audit log was written and read by nothing.** `AUDIT_LOG` appeared in
exactly two places, both writes. "Who called what, how often" — the first
question an incident asks — was answerable only by someone with a Redis client
and the key layout in their head. At 2am that is the same as unanswerable.

**Built:** `bridger audit [--status ok|deny|error] [--token <id>] [--limit N]`.
Tallies first (during an incident the *shape* of the traffic is the question),
rows second. A CLI subcommand rather than a dashboard: the operator already
holds the credentials and is already in a terminal.

Still missing: an incident playbook. Queued as D7 — cheap to write once, and the
thing you want to not be composing while an incident is running.

## Domain 8 — Data lifecycle. **FINDING, one item queued**

**There is no deletion path.** `closeRoom` sets `closed: true` and nothing else;
entries persist until the room's 30-day idle TTL. So if a partner asks for their
data to be deleted, the honest answer today is *"wait 30 days or I will do manual
Redis surgery"*.

What is stored where, stated plainly for the first time:

| Where | What | Lifetime |
|---|---|---|
| Upstash (eu-central-1) | entries, room, tokens (sha256 only), cursors, contract | idle TTL, 30 days from last write |
| Upstash | audit rows | capped list, 5000 rows |
| Both sides' disks | the `bridger/` folder from `bridger pull` | forever, and usually committed to git |

That last row is the one a lawyer would care about and the one nobody has said
out loud: **deletion on the server does not delete anything a partner already
pulled.** Any deletion promise can only ever cover the buffer.

`bridger purge` is queued (D8) rather than built — it is destructive, and a
destructive command written unattended at night against a mode I cannot test
live is exactly what the brief's stop condition is for.

## Domain 9 — Client compatibility. **RESHAPED BY DOMAIN 0**

Three clients, three spellings, one that rejects the others' keys. That
knowledge lives in `ARCHITECTURE.md` #13 and three files under `.local/`.

**The paste path largely dissolves this**, which was the point: a partner whose
client is awkward now has a route that needs no client config at all. So the
answer is not "document the matrix better" — it is **MCP for durability, paste
for reach**, and the matrix only matters to partners who choose durability.

One honest gap: the three `.local/` files are working artefacts from one
session, not documentation, and `.local/` is gitignored. If the matrix is worth
keeping it belongs in the README next to the MCP instructions. Small; queued as
part of D9 with the transport decision, since promoting `/api/rpc` changes what
the README should even say.

---

## What I did not do, and why

- **No transport-level loop fallback** (domain 6) — it would be built on a guess
  about how clients treat thrown tool errors. Named what would settle it instead.
- **No `whoami`, no `purge`, no protocol-lifecycle changes** — each changes the
  product's shape rather than filling it in. Stop condition, by design.
- **No live verification of anything.** Deploy is gated. Said once here and
  repeated in the summary rather than smoothed over.
