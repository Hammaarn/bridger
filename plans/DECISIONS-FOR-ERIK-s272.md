# DECISIONS FOR ERIK — S#272

> **ANSWERED 2026-08-13.** Erik's calls are recorded under each item. D2, D4, D6
> and D8 were greenlit and are BUILT; **D3 is greenlit and still unbuilt** — the
> only outstanding one. D5 and D9 were dropped, D7 shrank to four README lines.
> Nothing is run-green; the deploy is still gated.

Each is a choice I could have guessed at and deliberately did not. Ordered by
what blocks the most.

---

## D1. Does `/api/rpc` become a supported transport, or stay a prototype?

> **ERIK: "you'll take that decision."** -> **Stays flagged OFF until the
> deploy lands and is verified, then promote as a separate step.** Shipping
> an untested public surface inside the same deploy as everything else means
> two unknowns at once, and if anything misbehaved there would be no way to
> tell which caused it. Deploy, verify, then set `BRIDGER_PASTE_PATH=1`.

Built behind `BRIDGER_PASTE_PATH=1`, unset everywhere. Right now it does not
exist in production.

| Option | What it means |
|---|---|
| **Promote it** (my recommendation) | Set the flag. Paste-and-go becomes the default onboarding; MCP becomes the option for partners who want the token out of their model's context. |
| Keep it flagged | Use it yourself to see the flow; do not offer it to a partner yet. |
| Drop it | Delete the two routes; stay MCP-only. |

**Trade-off:** promoting it makes the product joinable in one paste by any AI
with a shell — which is the thing you named as crucial — at the cost of the
partner's token living in their model's context, where an injection arriving over
this bridge could reach it.

**Why I recommend promoting anyway:** the mitigations are real (single-use code,
7-day expiry, room-and-side scoping, `stop`/`revoke` both kill it), and the
alternative is not "a safer bridge" but "a bridge nobody joins". A partner who
needs durability has MCP, unchanged. **MCP for durability, paste for reach** is
the division, and it only works if both exist.

**Do not promote it before the deploy of everything else** — it is the one piece
with no live testing at all, and the deploy is already carrying a lot.

---

## D2. Should the paste path get its own, lower daily cap?

> **ERIK: "Whatever is best for the project."** -> **BUILT at 200**
> (`PASTE_PATH_DAILY_CAP`), half the MCP default. The asymmetry is the whole
> argument: a paste-path token sits in the far side's model context where an
> injection arriving over this bridge can reach it; an MCP token sits in a
> config file the model never reads.

Today a redeemed token gets `DEFAULT_DAILY_CAP` (400), same as an MCP token.

**Recommendation: yes, halve it — 200.** A paste-path token is the one whose
credential sits in a model's context, so it is the likelier one to be misused,
and the honest use case (a partner integrating over days, not a service) does
not need 400 calls a day. The room ceiling of 600 still binds above it.

Not built because picking the number is a product judgment about how a partner
actually works, and I have never watched one use this.

---

## D3. `/api/whoami` — build it, and in which shape?

> **ERIK: "Build it."** -> **NOT YET BUILT. The one greenlit item
> outstanding.** The shape is settled (valid-token-only, opaque otherwise);
> it is the last piece of the join story.

A partner who cannot connect gets the same opaque refusal as an attacker. That
is deliberate and it is also why "it doesn't work" is undiagnosable from their
end.

**Recommendation: build it, answering only for a VALID token** — *"valid, room
X, side B, last seen 3m ago"* — and returning the standard opaque refusal for
everything else.

**The reasoning:** an honest partner's token *is* valid; their real question is
"am I even reaching the right bridge, as the right side?". A prober holding an
invalid token learns nothing. A prober holding a *valid* token already has
everything `whoami` would tell them. So the information asymmetry costs nothing
and buys the whole diagnostic story.

Not built: it is a new public surface on a security boundary, and that is yours.

---

## D4. The three protocol gaps — which, if any, are worth closing?

> **ERIK: "All 3 should be closed."** -> **ALL THREE BUILT.**
> `bridger_reopen` (asker-only; newest `seq` wins, so it never depends on two
> companies' clocks agreeing), `bridger_signoff` (any later write clears it),
> and contract entries that summarise added/removed lines.

All three change the shape of the record, which is why none were built.

**(a) A question closes on the first answer that references it.** The asker
cannot say "that did not answer it". *Recommendation: add reopen.* The asker is
the only one who knows, and today they have no way to say so — which quietly
makes the open-questions list optimistic.

**(b) A contract change logs only `"<N> chars"`.** You cannot see what changed in
the one edit the docs call the most expensive either side can make.
*Recommendation: build it* — store the previous length and a short diff summary.
Cheap, and it makes the entry actually useful.

**(c) No way to say "I am done for today".** *Recommendation: build it, and it is
the most valuable of the three.* It is the honest answer to nearly every
idle-brake situation: instead of a partner's agent inferring silence and getting
braked, `status` could say *"their side signed off 2h ago"*. It turns a guess
into a fact.

---

## D5. Provenance — display the span, or leave it alone?

> **ERIK: "Don't understand exactly what this would do, make the best
> decision."** -> **DROPPED — and I was wrong to recommend it.** The idea was
> to print `(70 lines)` beside a citation so a wide range reads as weaker
> evidence. The only real evidence we have points the other way: in the
> Antigravity test the **70-line** citation was the SOLID one and the
> **9-line** citation was the over-broad one. A number that looks like a
> quality signal and is not is worse than no number.

`checkedAgainst` is ungraded. The one cross-vendor test gave one solid citation
and one over-broad one (a 70-line range where one line was relevant).

**Recommendation: display the span width, never score it.** Rendering
`(70 lines)` next to a citation lets a human weigh it; a score would be the
system pretending to know something it cannot check.

**Explicitly rejected: validating paths.** The server cannot see either
machine's filesystem, so validation could only run inside the agent making the
claim — the exact party whose honesty is in question. And validating only our
own side would be worse than nothing: a green tick on our entries and none on
theirs reads as a judgment about them.

---

## D6. `bridger purge` — a real deletion path?

> **ERIK: "Yes thats a good idea, and both sides have to agree on the
> purge."** -> **BUILT, with consent as the core of it** (now invariant 23).
> The partner consents via `bridger_purge`, the operator consents and
> executes via the CLI; neither can finish alone. Erik's addition is the
> right shape: the ledger is a JOINT record, and one side erasing it destroys
> the other's account of what was asked and decided — which is what they may
> need most when a relationship ends. `--force` exists only for a partner who
> has genuinely vanished, and says so loudly.

There is none. `close` only flags a room; entries live until the 30-day idle
TTL. If a partner asks for deletion, today's honest answer is "wait 30 days".

**Recommendation: build it, with two constraints.** It must require an explicit
room id (never infer from `room.json`) and must print what it will delete before
doing it. And the docs must state the part that no command can fix: **deletion
on the server does not delete what either side already pulled to disk and
probably committed.** Any deletion promise covers the buffer only.

Not built tonight: a destructive command written unattended, against a mode I
cannot test live, is exactly what the stop conditions are for.

---

## D7. An incident playbook — worth the page?

> **ERIK: "Why is that needed?"** -> **It was not, and I overrated it.** The
> playbook is three commands already in `bridger --help`; the only real
> content would have been your stop-vs-revoke judgment. Shrunk to four lines
> in the README.

**Recommendation: yes, and it is fifteen minutes.** `bridger audit` now answers
"who called what" and `bridger stop` ends it, but nobody has written down the
order to do things in. That is a page you want to already have rather than be
composing while something is burning.

I did not write it because it should encode *your* judgment about when to stop a
bridge versus revoke one side, and I would be inventing that.

---

## D8. The `.local/` client-config files

> **ERIK: "Yes."** -> **BUILT.** The three-client matrix is a README table
> now, framed as "only if you take the MCP route" — the paste path needs none
> of it.

Three real client-config artefacts from the cross-vendor session live in
`.local/`, which is gitignored. They are the only record of how each client
spells remote MCP.

**Recommendation: fold the matrix into the README** — but only after D1, since
promoting the paste path changes how much the matrix even matters. If paste
becomes the default, this shrinks to a footnote for durability-minded partners.

---

## D9. Publish the CLI to npm?

> **ERIK: "What difference does that make?"** -> **Less than it did this
> morning.** Publishing lets a partner run `npx bridger pull` instead of
> cloning the repo. But the CLI only materialises the local folder, and with
> the paste path a partner never needs it for the actual work — so it buys
> convenience on a step most partners will never take, and spends a public
> package name before the product has a shape. **Recommendation: do not.
> Revisit when a partner actually asks for the folder.**

Carried from `TODO.md`, untouched tonight. Still gated on checking whether the
name `bridger` is free — and I did not check, because the honest scope of "check
the npm name" is "and then decide about `bridger.ai` too", which is a branding
conversation, not an engineering one.

---

## Two things I decided myself, recorded so you can overrule them

1. **`AUDIT_LOG_MAX` 1000 → 5000.** Denials are rare; successes are traffic. At
   the old value a full-burn day held ~14 hours, so the docstring's promise of
   "what happened last week" would have gone false exactly when the log became
   useful. Costs ~1 MB of Upstash.
2. **Refuse rather than redact on credential detection.** Reasoning in
   `lib/secrets.ts`; the short version is that redacting rewrites an author's
   words in a record whose value is being faithful, and still ships the original
   to Redis before rewriting anything.
