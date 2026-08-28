# Can `checkedAgainst` be verified? — what the literature actually says

> **Why this file exists.** Erik: *"wouldn't it be better to combine checkedAgainst
> and verification? And verification gates are solvable as python modules?"* Then:
> *"I'm 100% sure we'll gather strong data if we just look."*
>
> He was right that the data exists. It points at a **narrower** design than either
> of us proposed, and it corrects one thing I had asserted from principle when a
> measurement was available.
>
> **Confidence badge, and it matters: these are ABSTRACTS, not full reads.** An
> abstract is the authors' own summary of their own work — the same class of
> claim as a tool's `--help` output (shipping-quality#26a). Every number below
> should be re-read in the paper before anything is built on it. What is safe to
> take now is the DIRECTION, which is consistent across a dozen independent
> groups.

---

## The question, split the way the literature splits it

Two things hide under "verify a citation", and conflating them is why the
question feels unanswerable:

| | tractable? |
|---|---|
| Does the cited thing **exist / resolve**? | Yes — deterministic, cheap |
| Does it **support the claim**? | This is the studied part, and the answer is *partly, and worst exactly where we need it* |

---

## Finding 1 — [!!] The metrics fail precisely at OUR failure mode

**Zhang et al., `arXiv:2406.15264` and `arXiv:2408.12398`** — a comparative
analysis of faithfulness metrics against human judgement, at three support
levels: **full / partial / none**.

> *"No single metric consistently excels across all evaluations... the
> best-performing metrics struggle to distinguish **partial** support from full
> or no support."*

**That is the S#271 incident, named.** Antigravity's second citation pointed at a
70-line span that only glancingly covered the claim — over-broad, not fabricated.
Partial support. The literature says this is the boundary automated metrics
cannot hold.

**Design consequence:** never grade support level. `checkedSpan` today reports a
STRUCTURAL fact — one line versus seventy — and refuses to score. That refusal
is now backed by measurement rather than taste, and `lib/citation.ts` should say so.

## Finding 2 — deterministic matching BEATS LLM evaluation at discriminating

**ResearchQA, `arXiv:2607.11074`** — 6,211 QA pairs, eight models, using both a
deterministic citation matcher and an LLM rubric evaluator side by side:

> *"Citation-based metrics separate systems more clearly than LLM-evaluator
> scores: section coverage and citation accuracy vary substantially across
> models, while evaluator scores remain **tightly compressed**."*

The LLM judge could not tell systems apart. The deterministic matcher could.

**This is the strongest single result for our purposes** — and it is the one that
upgrades my earlier answer from intuition to evidence. I said a deterministic
resolver was the buildable half because it "felt" like the honest line. It is the
buildable half because it *discriminates better*.

## Finding 3 — LLM-as-judge as a gate is measurably unreliable, and standard validation hides it

**Norman et al., `arXiv:2606.19544`** — the largest systematic evaluation to date:
21 judges, nine providers, ~541,000 individual judgments, including the April 2026
frontier.

> *"Kappa deflation between exact match and Cohen's kappa is **universal (33–41
> percentage points** on MT-Bench)... judge rankings shift by up to 14 positions
> across benchmarks... high test–retest reliability (>0.95) coexists with severe
> position bias."*

Read that first clause carefully: the way people normally validate a judge —
exact-match agreement — **systematically overstates its discriminative ability**,
because it does not correct for chance. A judge that looks 80% reliable may be
barely above chance.

Corroborated twice: **`arXiv:2602.09383`** finds error rates **above 50%** for
powerful evaluators on JudgeBench-Pro, and **`arXiv:2512.16041`** finds
Gemini-2.5-Pro and GPT-5 fail to hold consistent preferences in **nearly a quarter
of difficult cases**.

**Design consequence:** an entailment gate is refused on measurement, not on
`shipping-quality#30` alone. Good — a hard gate justified only by a house rule is
a hope; this one now has a number.

## Finding 4 — the uncomfortable one: humans are not the gold standard either

Also from **`arXiv:2512.16041`**:

> *"We also find substantial inconsistency in human judgments, which indicates
> that human annotation may not be a reliable gold standard."*

This bites our fallback. "Erik checks it" is the answer we reach for whenever a
mechanism cannot be trusted — and it has its own error rate. It does not make the
human check worthless; it means a design resting entirely on it is resting on
something unmeasured.

## Finding 5 — `basis` does real work, and less than we might assume

**LegalCiteBench, `arXiv:2605.10186`** — 21 models, closed-book citation tasks:

> *"Misleading Answer Rates exceeding **94% for 20 of 21** evaluated models on
> retrieval-heavy tasks. A prompt-only abstention experiment shows that explicit
> uncertainty instructions **reduce some confident fabrication but do not improve
> citation correctness**."*

Our `basis` field (`opinion` / `inference`) is exactly an explicit uncertainty
instruction. So it is doing the thing it is documented to do — reducing
*fabrication dressed as verification* — and it will not make citations correct.
That is precisely the claim `lib/entries.ts` already makes for it. Keep it,
expect nothing more from it.

## Finding 6 — a caution against MY OWN proposal

**MuRGAt, `arXiv:2602.11509`:**

> *"Even strong MLLMs frequently hallucinate citations despite correct reasoning.
> Moreover, we observe a key trade-off: **increasing reasoning depth or enforcing
> structured grounding often degrades accuracy.**"*

I proposed a pre-write gate that *refuses to send* a citation that does not
resolve. This finding is the argument against the blocking form.

**But the validity condition matters and I nearly over-applied it:** MuRGAt's
result is about structured grounding imposed at GENERATION time changing how the
answer is produced. A post-hoc resolver that checks a finished citation does not
touch generation. So the finding does not straightforwardly transfer — it is a
reason to prefer **annotate over block** and to watch for the effect, not proof
that blocking is wrong.

## Finding 7 — citation presence is mechanistically decoupled from citation faithfulness

**van Dort & Heuss, `arXiv:2606.28358`** — activation patching on
Llama-3.1-8B-Instruct to find what actually decides whether a citation is attached:

> *"Not a single, localized component but a distributed, multi-stage
> 'attributional ensemble'... amplifying or attenuating only those critical heads
> and MLPs repairs over 90% of missed citations and eliminates 69% of spurious
> ones... The results reveal a potential disconnect between the model's apparent
> reasoning and its internal computational pathway, suggesting that **inline
> citations can create a false sense of security**."*

Two things for us. There IS an internal signal (partly answering the open
question I flagged earlier). And the decision to cite is not the same computation
as the reasoning the citation claims to support — which is the mechanistic
version of the whole `checkedAgainst` argument.

---

## What this changes, concretely

| | before | after |
|---|---|---|
| Deterministic resolver | "the honest half" | **the half that measurably discriminates better** — build it |
| Support-level grading | refused on principle | refused on measurement: metrics fail at partial support, which IS our failure mode |
| Entailment gate | refused by house rule | refused by ~541K judgments |
| `checkedSpan` reporting structure, not score | a design choice | **vindicated** |
| Pre-write gate that BLOCKS | recommended | soften to **annotate**, watch for degradation |
| "a human checks it" fallback | assumed sound | has its own measured error rate |

**Net: the ambition narrows and the cheap half gets stronger.** Nothing here
supports building a verifier. Everything here supports building a **resolver**
that reports whether a citation resolves, and leaving support to the reader.

## What was NOT searched

- Internal correctness signals as a usable product mechanism — only touched
  incidentally by Finding 7. Not searched directly.
- Anything on two-party / cross-organisation provenance specifically. Every paper
  here is single-party: a model citing sources for a user. **Nobody in this
  literature is citing across a trust boundary**, which is either a gap worth
  occupying or a sign the framing is ours alone.

## Order I would do it in

1. **Get one partner to declare a repo.** Still zero code, still the highest value
   per effort: it makes existing citations checkable by the reader, which is
   stronger than anything we could compute.
2. **Deterministic resolver, annotate-only.** Finding 2 is the mandate.
3. Re-read Findings 1, 2 and 3 in full before writing the resolver's contract —
   the numbers above are abstracts.
4. Nothing else. Findings 3 and 4 say the judge layer is not available to us at
   any reliability we would accept.
