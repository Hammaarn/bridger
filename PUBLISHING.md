# What goes out of this repo

This repository is **public**, and that is deliberate: the product's whole pitch
is that a stranger can read the server before trusting it. So the rule is not
"publish less".

> **Publish our reasoning. Do not publish third parties, another product's
> internals, or live operational identifiers.**

Being open about how Bridger works and *why* is the point. A partner company's
name, JudgeMySite's file paths, and a live room id are all disclosures that are
not ours to make.

---

## The check runs itself

```bash
npm run check          # typecheck + tests + disclosure
npm run check:disclosure
```

`scripts/check-disclosure.mjs` is the enforcement. Its header explains every
rule and why it exists. **If a finding is wrong, fix the rule — do not delete
the check.** A gate that lives only in a document is a hope; this one exits 1.

It scans in two tiers, because one strict rule would be unusable and an
unusable check gets switched off:

| Tier | Files | Rules |
|---|---|---|
| **Shipping** | code, README, VERIFY, SECURITY, landing page, MCP tool schemas | strict — credentials, foreign repo paths, home paths, **third-party names**, **live room ids** |
| **History** | DECISIONS, STATUS, TODO, `plans/`, ARCHITECTURE | credentials and another product's internals only |

The split matters. A partner name inside a tool `describe()` string is the
widest exposure in the codebase — it lands in every agent that lists our tools,
inside someone else's model context. The same name in `DECISIONS.md` explaining
why a bug was fixed is a different thing, and holding history to shipping rules
would flag hundreds of legitimate lines.

## One-time local setup

The name list is **not committed** — a file listing "names that must not appear"
would publish exactly the names it protects. Create it once:

```bash
# .disclosure-names.local.json   (gitignored)
["Partner Name", "Other Co"]
```

Without it the structural checks still run, and the script **says so** rather
than reporting a clean pass. A run that checked less must never look like a run
that checked everything.

## Exemptions

Some lines legitimately look like the thing they are not — a documentation
example needs a room id shaped like a real one. Mark it, with the reason, on the
line or the one above:

```ts
// disclosure-ok: synthetic, and an example id must be shaped like a real one.
'{ "room": { "id": "0a1b2c3d4e5f", … },',
```

Every use is one `grep disclosure-ok` away, and each run prints the count, so
they cannot quietly accumulate.

---

## What the script cannot judge — three things a human still owns

1. **Is this ours to publish?** The script knows names you gave it. It cannot
   know that a new partner joined, or that a quote in a commit message came from
   someone who never expected to be quoted.
2. **Does this expose a person?** Collaborator names, family, an operator's
   routine. `Erik Hammarström` is deliberate — it is the operator identity in
   `/api/about`. Nobody else opted in.
3. **Does the commit message leak what the diff does not?** Messages here are
   long and carry real reasoning. That is good. They are also public, and the
   scanner does not read them.

## The limit worth knowing

**Removing a file from `HEAD` does not remove it from git history**, and any
existing clone or fork keeps it. This check bounds *future* exposure. Scrubbing
history needs a rewrite plus a force-push — which is gated, breaks every clone,
and is a deliberate decision, not a cleanup.

So the check is worth more before the first push than after the tenth.
