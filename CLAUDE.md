@AGENTS.md

# Bridger — project rules

**This repository is PUBLIC** (`Hammaarn/bridger`, Apache-2.0). Everything tracked here
is readable by anyone who finds the repo, including people evaluating the product. Read
every rule below through that fact.

## 1. Internal working docs are NOT published

`DECISIONS.md`, `STATUS.md` and `TODO.md` live on disk and are **deliberately untracked**.
Gaveled S#286, Erik verbatim:

> *"Remove it and make sure docs like that aren't pushed to a public viewing, this is our
> internal stuff, worst case scenario they can leak API keys"*

**Do not `git add` them, and do not "fix" the .gitignore that excludes them.**
`scripts/check-disclosure.mjs` fails the build if any becomes tracked again — that gate is
the rule; this paragraph is only the explanation.

**Before writing anything into a tracked file, ask whether it would embarrass or expose us
in front of a stranger:** internal source paths for other projects, production commit SHAs,
partner or customer names, room ids, credentials, unfixed security findings, revenue or
cost figures. The check script catches credential SHAPES and a third-party name list; it
cannot catch judgement.

**A finding about an exposure must not reproduce the exposure.** Describe it and give the
command that reveals it — do not paste the leaked string into a tracked file. (S#290: this
was nearly done in `TODO.md` while documenting that very leak.)

**Still open, and it is Erik's call, not yours:** `plans/` (~105 KB) and `ARCHITECTURE.md`
(~38 KB) remain tracked. The S#286 gavel named only the three files above. Do not widen or
narrow the rule on your own judgement.

**The scrub is DONE (S#290).** History was rewritten with `git filter-repo` and force-pushed:
197 → 140 commits, `master` now `fd9b4d1`. The four paths, the partner's name and five room
ids are gone from every branch, verified on a fresh clone from GitHub. **It is still not
finished** — `refs/pull/1/head` and `refs/pull/2/head` keep pre-rewrite commits reachable and
only GitHub Support can purge them, and the fork `Baltsar/bridger` must be **deleted**, not
re-cloned. Both are tracked in `TODO.md` items 0a/0b.

**These docs have their own git history, in a repo with no remote.** `.git-internal/` is a
separate gitdir over this same work-tree, tracking only `DECISIONS.md`, `STATUS.md`,
`TODO.md` and `plans/`. Use it:

```
git --git-dir=.git-internal --work-tree=. status
git --git-dir=.git-internal --work-tree=. add -f TODO.md && \
git --git-dir=.git-internal --work-tree=. commit -m "..."
```

`add -f` is required because this work-tree's own `.gitignore` outranks the internal repo's
`info/exclude` — that is expected, not a misconfiguration. **It has NO remote on purpose:**
the protection is not "remember not to push", it is that there is nowhere to push to. Do not
add one. `.git-internal/` is itself gitignored by the public repo.

Why it exists: removing these from the public repo left the project's entire decision log
and status with no version control at all — a single unversioned copy on one disk, which is
a worse failure mode than the exposure it fixed, only quieter.

## 2. Never claim state you have not read

The public surface is the sensor: `curl -s https://bridger.nexus/api/about`. Do not report
a deployed commit, a live capability or a room's contents from prose, a handover, a commit
message or this file. Repository visibility is mutable config owned by GitHub — confirm it
with `gh repo view Hammaarn/bridger --json visibility` before publishing anything, rather
than trusting a note (including this heading).

## 3. Credentials

The MCP token expires and is rotated with `npm run bridger -- rotate --room <id> --side <a|b>`.
A token in `~/.claude.json` is not part of the record: nothing in a room is lost when it
expires. Never paste a `br_live_...` value into any file here — the gate will catch the
shape, but the gate is the backstop, not the plan.
