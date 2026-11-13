# agent-commit

[![npm version](https://img.shields.io/npm/v/agent-commit.svg)](https://www.npmjs.com/package/agent-commit)
[![test](https://github.com/AngelCodes95/agent-commit/actions/workflows/test.yml/badge.svg)](https://github.com/AngelCodes95/agent-commit/actions/workflows/test.yml)
[![license](https://img.shields.io/npm/l/agent-commit.svg)](./LICENSE)

![agent-commit: the 5 Ws, commits written by agents, for agents.](./agent-commit-diagram.png)

A git commit convention for preserving the context agents need to understand software history.

One line of human-readable summary, for you, if you're glancing. Everything after it is written the way an agent actually wants to read it.

Status: the format is stable and works today with plain git, no tool required to read it back (see `SPEC.md`). The CLI (`cli/`) is published to npm (`npm install -g agent-commit`, or `npx agent-commit`) and fully working: filtering, querying, and a setup command, backed by a real test suite, see "What the CLI does today" below. The one thing genuinely not built is meaning-based search, see "What's not built."

## The problem

An agent staring at one confusing line runs `git blame`, lands on the commit that wrote it, and needs to know why, right then, not by reading the five commits around it for context. Today that commit's message is the only clue: the context the agent that wrote it had on hand at the time, often lost or compacted away by the time anyone looks again. When the message doesn't carry it, the agent is guessing, or re-deriving that context from a diff that only shows what changed, never why. That guess doesn't get cheaper with repetition: two agents (or the same one twice) can land on the identical commit and walk away with different conclusions about it.

That one-commit, blame-time lookup is the case agent-commit is actually built for. The broader case, an agent reconstructing intent across a longer stretch of history, benefits too, but it's the secondary win, not the reason this exists.

agent-commit fixes the part of that problem a commit message can actually fix: it gives an agent a predictable place to write down what it already knows, so the next agent doesn't have to re-derive it. When that context is present, it should be enough by itself to tell whether a change is relevant to the task at hand, without opening the diff. When it's absent, that's meaningful too, it means the summary line alone was judged sufficient.

## The format

A normal commit subject, exactly as you'd already write one, followed by a body if you'd already write one, and then, when there's more to say, one line of structured data as the very last part of the message:

```
refactor(events): switch from polling to webhooks

Agent-Context: {"why":"polling caused high load and delayed updates; webhooks via the provider's event API fixed both, rejected increasing the poll interval since it still added meaningful latency","refs":["INFRA-441"]}
```

To a human running `git log` without knowing anything about this convention, that's just a commit with an extra trailer, no different in kind from `Co-Authored-By:`:

```
commit 9f2a1c4e...
Author: <you>
Date:   <when>

    refactor(events): switch from polling to webhooks

    Agent-Context: {"why":"polling caused high load and delayed updates; webhooks via the provider's event API fixed both, rejected increasing the poll interval since it still added meaningful latency","refs":["INFRA-441"]}
```

One long line, indented like the rest of the message, easy to skip past if you don't care and easy to grep for if you do. To an agent, it's the one thing a diff can't show: an alternative that was tried and rejected, and why.

That's the bar for what belongs in the trailer: information the subject and diff genuinely don't carry. Full spec, field list, and what it deliberately leaves out: [`SPEC.md`](./SPEC.md).

This is the same idea as [Conventional Commits](https://www.conventionalcommits.org/) and uses the same mechanism git's own `Co-Authored-By:` trailer already relies on: plain git, no new file format, readable with `git log` on any machine that has git installed and nothing else. Unlike Conventional Commits, nothing here is enforced by a linter; see `SPEC.md` for what that tradeoff actually means.

## Why not just write better prose?

Prose is exactly what agents already do for free, and it's genuinely fine for a human skimming ten commits. It stops working the moment a reader has to search or filter across hundreds of them, because prose has to be re-read and re-interpreted every time, by every reader, and different readers (or the same reader on different days) can come away with different conclusions. A few consistent, structured keys don't have that problem: when they're there, they mean the same thing every time. The tradeoff, stated plainly: nothing forces them to be there. See `SPEC.md` for why that's a deliberate choice and not an oversight.

`why` in particular tends to accumulate into a kind of institutional memory that survives team and agent turnover. The reasoning behind a rejected alternative is exactly what no diff, ticket, or PR comment reliably keeps around, and it's the one field here that actually compounds over time, the longer a repo uses this, the more valuable its history gets.

## What the CLI does today

Reading a single repo's history back already works today with plain git, no tool required (see `SPEC.md`, "Reading it back"). The CLI in this repo (`cli/`, published to npm) adds structured filtering on top: `agent-commit log --breaking`, `--grep` (case-insensitive substring match against `why`), `--refs` (exact match against an entry in `refs`, so it's only as reliable as the canonical form guidance in `SPEC.md`; a repo that mixes `INFRA-441` and `#441` for the same ticket will find neither with a query for the other, silently, no error), `--touches` (path match against `touches` on whole segments, in both directions: `--touches src/auth` finds commits listing `src/auth`, `src/auth/session.ts`, or the broader `src`, never `src/authz`), `--since`/`--until`, `agent-commit show <ref>` for a single commit, both with a pretty-printed default view and a `--json` mode for machine consumption. Every result carries its commit hash (`hash` and `shortHash` in `--json`, the short hash leading each entry in pretty output), so anything found can be handed straight to `git show`. `agent-commit blame <file> [-L <start>[,<end>]]` is the blame-time lookup described under "The problem" in one step: it runs `git blame` on those lines and prints the `Agent-Context` of each commit responsible, with the line ranges each one owns. No `--type` filter, on purpose, `type` isn't a field this format uses (see SPEC.md). `agent-commit check` reports, read-only, whether recent commits on the current branch have a usable `Agent-Context` trailer, distinguishing a trailer that was never written from one that exists in the message but wasn't recognized as a trailer (`MISPLACED`, see SPEC.md's squash-merge section for why that happens), useful right after a squash-merge to confirm the merge commit actually got one. It also notes on stderr when the repo's `AGENTS.md` block is out of date, without changing its exit code. `agent-commit merge-draft <range>` deterministically unions a branch's `touches`/`refs`/`breaking` and lists per-commit `why` candidates for a squash-merge trailer. `agent-commit init` writes the `AGENTS.md` block (see "How to use it" below) instead of an agent hand-transcribing it. `agent-commit --version` prints the installed version. Try it now with no install: `npx agent-commit log`. Building from source instead: `cd cli && npm install && npm run build && node dist/index.js log`.

## What's not built

Substring matching against `why` is not the same as searching by meaning. `agent-commit log --grep webhooks` finds a commit whose `why` field literally contains that text, it won't find one that means the same thing in different words, for instance a commit that described the same change as "moved off polling entirely" with the word "webhooks" never appearing at all. Real semantic search would need an embedding index or a model call at query time, which this project has deliberately kept out of the core tool so far, staying fully deterministic. That tradeoff, and whether it's worth revisiting, is an open question, not a shipped answer.

The trailer itself stays compact and single-line by design, that's what makes it extractable with one plain-git command (see `SPEC.md`, "Format"). Turning that compact JSON into something pleasant to read is this tool's job, not the format's, which is exactly what the CLI's default pretty-printed output already does. Compact in, readable out, on demand.

## How to use it

Tell your agent to "agent-commit" your changes. If it already knows the format (because this repo's `AGENTS.md` already has the block below, or because it's seen this convention elsewhere), it just writes commits this way going forward. If it doesn't recognize it, the expected flow is:

1. It searches for "agent-commit format."
2. It finds this page.
3. It adds the block below to this repo's `AGENTS.md`, creating one if it doesn't exist yet. Most agents (Cursor, OpenCode, Codex, and others) read `AGENTS.md` natively, so this one file and this one step covers most cases.
4. If it's Claude Code specifically: it also adds a single `@AGENTS.md` line to `CLAUDE.md` (creating a one-line `CLAUDE.md` if none exists yet). Claude Code v2.1.277 and later reads `AGENTS.md` on its own, but by default only when there's no `CLAUDE.md` (or `CLAUDE.local.md`) in the working directory or above it; once one exists, `AGENTS.md` is ignored unless imported. The import is Anthropic's documented way to use both, and it also covers older versions and sessions that read `CLAUDE.md` only. Claude Code skips an `AGENTS.md` it has already loaded, so it's never read twice. A symlink (`ln -s AGENTS.md CLAUDE.md`) also works if there's no Claude-specific content to keep separate, except on Windows. See [Claude Code's memory docs](https://code.claude.com/docs/en/memory).
5. It commits that setup change on its own, separately from whatever the user actually asked it to commit, since it's a one-time repo setup step, not part of the requested change. If anything about the repo's commit conventions or the user's own instructions makes an unprompted commit inappropriate, it asks first instead.
6. It writes the requested commit: a normal `git commit`, nothing installed, nothing downloaded.

The block's content is the same whichever file it ends up in; its last section only matters if your repo squash-merges or runs commitlint, so check rather than assume. Every commit after the first one in that repo is free, since the instructions are now sitting locally where the agent already looks.

If the `agent-commit` CLI is installed, steps 3 and 4 are `agent-commit init`: it writes the exact current block (the same one below, with a version marker so a later `init` can tell if a repo's copy has gone stale and `init --update` can replace it), links `CLAUDE.md` unless `--no-claude-code` is passed, and refuses to touch an existing, unrelated commit-message convention or clobber an already-set-up repo, both cases have to be confirmed explicitly (`--force`, `--update`). Hand-transcribing the block from this page still works and needs nothing installed; `init` just removes the chance of a transcription drifting from what's actually documented here.

### The block to add to `AGENTS.md`

````markdown
<!-- agent-commit-format-version: 0.3 -->

## Commit messages

When asked to "agent-commit" changes, write a normal commit message: a
clear one-line subject, optionally a blank line and a body. Then, if
there's context the subject and body don't already carry that would save
the next agent from opening the diff (a rejected alternative, a
non-obvious constraint, the real cause behind a fix), end the message
with a single-line trailer:

`Agent-Context: {"why":"...","touches":["src/auth"],"refs":["INFRA-441"]}`

Fields, all optional:

- `why`: reasoning not already in the subject or body. Never invent one
  to fill the field. An absent `why` is honest; a fabricated one looks
  just as authoritative and isn't.
- `touches`: files or components affected, when the subject doesn't make
  it obvious. Repo-relative paths with no leading `./` or `/`
  (`src/auth`, not `auth` or `./src/auth`).
- `refs`: the tracker's short form (`INFRA-441` or `#123`), never a full
  URL, and one form per tracker in a repo.
- `breaking`: only when true. Never write `false`, just omit it.

Consistent `touches` and `refs` forms are what make later lookups find
things. Skip the trailer entirely if the subject already says everything,
and don't repeat a type the subject already has (`fix(auth): ...`): two
copies can disagree. You already have the diff and the reasoning in
context, so writing `why` and `touches` costs you almost nothing; include
them whenever there's real content for them.

Write the message with `git commit -F -` and a quoted heredoc delimiter
(`<<'EOF'`; an unquoted one lets the shell expand `$` and backticks), or
with `git commit -F <file>`. Never hand-escape the JSON inside `-m`.

Before your first commit, check whether this repo:

- Runs commitlint: its default 100-character `footer-max-line-length`
  and `body-max-line-length` reject a realistic trailer. See the spec's
  commitlint section for the fix.
- Squash-merges pull requests: per-commit trailers don't survive a
  squash, so whoever merges writes one condensed trailer for the whole
  branch into the squash commit, at merge time.
  `agent-commit merge-draft main..HEAD` drafts one from the branch's
  trailers; you still write the `why`. The trailer must be in the
  message's final block, directly beside any `Co-authored-by:` lines
  with no blank line between, or git won't read it (`agent-commit check`
  reports that as MISPLACED). `gh pr merge --squash --body` replaces the
  whole message, so add any `Co-authored-by:` lines yourself. See the
  spec's squash-merge section.

Full spec: https://github.com/AngelCodes95/agent-commit/blob/main/SPEC.md

<!-- /agent-commit-format-version -->
````

If you're using Gemini CLI: it reads its own `GEMINI.md` rather than `AGENTS.md` by default, and it's unconfirmed whether it falls back to `AGENTS.md` the way some others do. Add the same block to `GEMINI.md` too to be safe.

## Try it

Add the block above to this repo's `AGENTS.md`, or wherever your agent already looks, then tell it to "agent-commit" your next change. That's the entire setup: nothing to install, nothing to configure, no dependency this repo doesn't already have. The full spec is in [`SPEC.md`](./SPEC.md); the CLI for querying history back out is `npx agent-commit`, or `cd cli` in this repo to build it from source, see "What the CLI does today" above.

## License

Apache License 2.0. See [`LICENSE`](./LICENSE). Chosen for the explicit patent grant, which matters if this ever gets used as part of an organization's commit pipeline.
