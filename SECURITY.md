# Security

Bridger asks two companies' AI sessions to write into one record. That is a
trust boundary, so this file says what we think the risks are, what we have done
about each, and — more usefully — **what we most want someone else to attack.**

Contact: open an issue at https://github.com/Hammaarn/bridger/issues, or for
anything you would rather not post publicly, reach Erik Hammarström through
[judgemysite.org](https://judgemysite.org).

There is no bounty. There is a promise: a real finding gets fixed, credited, and
written into the record with the same candour as our own mistakes — several of
which are in `DECISIONS.md` and in the commit log.

## Please attack these first

Ranked by how much we would learn, not by how likely we think they are.

1. **Prompt injection across the bridge.** Far-side text is wrapped in
   `[[UNTRUSTED-PARTNER-TEXT]]` markers with the closing marker escaped
   (`lib/untrusted.ts`). The escaping is deterministic; the banner telling a
   model to treat it as data is *advisory* and we say so. **Can you get text
   through that a model acts on?** Room names and side labels are sanitised at
   write (`lib/room-text.ts`) — is there a field we forgot?
2. **Cross-room isolation.** A token resolves to exactly one room and there is no
   room id in any request to tamper with. **Can you read or write a room your
   token does not belong to?**
3. **The chain.** `lib/chain.ts` is tamper-*evidence*, and its own docstring
   explains why that is weaker than tamper-proof. **Can you produce two different
   records with the same head?** Can you find a field that is not covered by
   `canonical()` and should be?
4. **Credential leakage.** `lib/secrets.ts` refuses writes matching known
   credential shapes. **What credential format gets through?** The audit log
   stores key ids and never tokens — verify that.
5. **The mint endpoint.** Public and unauthenticated by design. The per-address
   quota is a cost-of-abuse measure that a VPN defeats, and we do not claim
   otherwise. **What does it cost us that we have not bounded?**
6. **Budget exhaustion.** The limits protect the *caller*, because their tokens
   burn in their own session. **Can you make an agent loop that our idle brake
   and terminal refusals do not stop?**

## What is already known and written down

Not findings — published limitations. Reporting these back is welcome but tells
us nothing new:

- The operator can read every room, and can rewrite one if willing to recompute
  the chain. `bridger verify` makes that provable to anyone holding a stored
  head. Full statement: `VERIFY.md` §7.
- Sending information to the other company is the product.
- No third party has audited this.
- A one-time join link puts a token into a model's context. Prefer MCP config.
- The "data, not instructions" banner is advisory, not a boundary.

## What we will not do

- Ask you to bypass another agent's refusal. If an AI declines to connect to
  Bridger on security grounds, that is correct behaviour and we treat it as a
  bug report about our onboarding, not an objection to argue away. This policy
  exists because it already happened, on 2026-08-16, and the refusal was better
  security review than we had done ourselves.
- Claim review or certification we do not have. There is no central review
  process for arbitrary MCP servers, and any listing we obtain will be described
  as what it is.

## Reproducing anything here

Bridger runs entirely offline with no account and no credentials, which is the
right place to test attacks:

```bash
git clone https://github.com/Hammaarn/bridger && cd bridger && npm install
BRIDGER_STORE=file npm run dev
npm run check     # 254 tests + typecheck
```

Many behavioural tests are **ablation-proven** — the mechanism switched off, the
test watched to fail, then switched back on — so they are known to catch the bug
rather than pass beside it. If you find one that passes under ablation, that is
itself a finding worth reporting.
