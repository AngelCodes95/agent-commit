# agent-commit

Reader, query tool, and setup helper for the `agent-commit` format: a
normal commit subject plus an optional, single-line `Agent-Context: {json}`
git trailer that captures the reasoning an AI coding agent already has at
commit time, so the next agent (or human) doesn't have to re-derive it from
the diff. Full format spec, rationale, and the `AGENTS.md` block to adopt it
in a project: [github.com/AngelCodes95/agent-commit](https://github.com/AngelCodes95/agent-commit).

Reading the format back never actually requires this CLI, plain `git log`
with a trailer format string does it (see the main repo's `SPEC.md`,
"Reading it back"). This package adds structured filtering, an advisory
check, and a deterministic setup command on top of that.

## Install

```
npm install -g agent-commit
```

Or run it without installing: `npx agent-commit <command>`.

A bare `npm install git+https://...` won't work, since this package lives
in a subdirectory (`cli/`), not the repository root. The fix is a
`#<ref>?subdirectory=cli` suffix on the URL:

```
npm install git+https://github.com/AngelCodes95/agent-commit.git#main?subdirectory=cli
```

That's real, general npm behavior for a repo shaped like this one, though
it hasn't been tested against this specific URL yet, there's no live
GitHub remote to test against until this repo is pushed. When in doubt,
use the registry install above instead.

## Commands

`agent-commit init [directory]`
Writes the `AGENTS.md` block a repo needs to adopt the format into the
target directory (the current directory if none is given), and links
`CLAUDE.md` to it unless `--no-claude-code` is passed. Refuses to touch
an existing, unrelated commit-message convention or an already-set-up
repo without `--force`/`--update`.

`agent-commit log [--breaking] [--grep <text>] [--refs <ref>] [--since <date>] [--until <date>] [--json]`
Filters commit history by `Agent-Context` fields. `--grep` is a
case-insensitive substring match against `why`, not semantic search.
`--refs` is an exact match, see the main repo's `SPEC.md` for why ref
form consistency matters.

`agent-commit show <ref> [--json]`
Shows a single commit's `Agent-Context` trailer.

`agent-commit check [--range <range>] [--count <n>] [--json]`
Read-only, advisory report on whether recent commits have a usable
trailer. Distinguishes a commit with no trailer at all from one where an
`Agent-Context:` line exists in the message but wasn't recognized as a
trailer (`MISPLACED`), which is what a mishandled squash-merge produces.
Never writes anything.

`agent-commit merge-draft <range> [--json]`
Deterministically unions `touches`/`refs`/`breaking` across a range of
commits and lists each one's raw `why` as a candidate, for composing a
squash-merge commit's trailer by hand. Never synthesizes a `why`.

`agent-commit --version`

## What this deliberately doesn't do

No semantic or meaning-based search, `--grep` is literal substring
matching. No mandatory schema, no enforcement by default, `check` is
advisory and never blocks. Both are intentional, not unfinished, see the
main repo's `SPEC.md` and `CONTRIBUTING.md`.

## License

Apache License 2.0. See `LICENSE`.
