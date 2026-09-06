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

**Untracking is not erasure.** All three remain in git HISTORY. Removing them from there is
a separate gaveled scrub that rewrites history and needs Erik's explicit go at the moment
of running, because forks must re-fork.

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
