# agent-commit

[![npm version](https://img.shields.io/npm/v/agent-commit.svg)](https://www.npmjs.com/package/agent-commit)
[![test](https://github.com/AngelCodes95/agent-commit/actions/workflows/test.yml/badge.svg)](https://github.com/AngelCodes95/agent-commit/actions/workflows/test.yml)
[![license](https://img.shields.io/npm/l/agent-commit.svg)](./LICENSE)

![agent-commit: the 5 Ws, commits written by agents, for agents.](./agent-commit-diagram.png)

A git commit convention that gives agents a predictable place to write down why a change was made, so the next agent that lands on it through `git blame` doesn't have to guess.

```
refactor(events): switch from polling to webhooks

Agent-Context: {"why":"polling caused high load and delayed updates; webhooks via the provider's event API fixed both, rejected increasing the poll interval since it still added meaningful latency","refs":["INFRA-441"]}
```

A normal subject and body for people, then one optional line of JSON for agents. Writing it needs nothing installed, and reading it needs only git. The format is specified in [`SPEC.md`](./SPEC.md) (currently version 0.3); the optional CLI is on npm as `agent-commit`.

## The problem

An agent looking at a confusing line runs `git blame`, lands on the commit that wrote it, and needs to know why. The diff shows what changed, never why. The context the original agent had, an alternative it tried and rejected or a constraint it worked around, is gone once its session ends. So the next agent guesses, and two agents can guess differently about the same commit.

agent-commit fixes the part of that a commit message can fix. The agent writing the commit already has the context, so it writes it down where the next agent knows to look. When the trailer is there, it should be enough to tell whether a change matters to the task at hand without opening the diff. When it's absent, the subject line was judged sufficient.

## The format

To someone running `git log` who has never heard of this, it's a commit with one extra trailer, the same kind of line as `Co-authored-by:`. Because it's the last line of the message, git's own trailer parser extracts it:

```
git log -1 --format='%(trailers:key=Agent-Context,valueonly)'
```

Fields, all optional: `why` (reasoning the subject and body don't carry), `touches` (paths affected), `refs` (ticket IDs), and `breaking` (only ever `true`). The bar for anything in the trailer is information the subject and diff don't already carry, and a `why` is never invented to fill the field: an absent one is honest, a fabricated one looks just as authoritative.

Like [Conventional Commits](https://www.conventionalcommits.org/), it's a convention on top of plain git. Unlike Conventional Commits, nothing enforces it, on purpose; see `SPEC.md` for that tradeoff.

## Why structured, and not just better prose?

Prose is fine for a person skimming ten commits. It breaks down when an agent has to filter hundreds: every reader reinterprets it, and nothing marks where the reasoning is. A few fixed keys mean the same thing every time and can be queried directly. The tradeoff is that nothing forces them to be there.

`why` is the field that compounds. The reasoning behind a rejected alternative is exactly what no diff, ticket, or PR comment reliably keeps, so the longer a repo uses this, the more its history is worth.

## How it compares

Several projects put agent context into git. They differ mostly in where the data lives and what question it answers.

| | Where it lives | What it records | Required fields | Tool needed |
|---|---|---|---|---|
| **agent-commit** | One `Agent-Context:` trailer, single-line JSON | Why, paths, refs, breaking | None | No; CLI optional |
| [Lore](https://arxiv.org/abs/2603.15566) | Several trailers (`Constraint:`, `Rejected:`, `Confidence:`, `Directive:`, `Tested:`, and more) | A decision record: constraints, rejected alternatives, confidence, risk, test coverage | None | No; CLI optional |
| [QAC](https://github.com/hubtheocoelho/qac-spec) | Four trailers: `Agent:`, `Mode:`, `What:`, `Why:` | Which agent, whether a human approved it, the effect, the reason | All four, on every agent commit | No; optional commit-msg hook |
| [Agent Note](https://github.com/wasabeef/AgentNote) | Git notes (`refs/notes/agentnote`) | Prompts, responses, changed files, share of AI-written lines | Recorded automatically | Yes; installs agent and git hooks |
| [Agent Trace](https://agent-trace.dev) | Left to the implementer (files, git notes, a database) | Line-level attribution (AI, human, mixed) with a link to the conversation | Defined by its JSON schema | A spec, with a reference implementation |

- **Lore** is the closest relative and came first (a March 2026 preprint): the same mechanism, git trailers, for the same goal of recording decisions. It has a richer vocabulary of separate plain-text trailers. agent-commit keeps a smaller set in one JSON line, so the whole record comes out of a single trailer lookup and parses with any JSON library. If you want fields like confidence, reversibility, or test coverage, Lore has them.
- **QAC** answers a different question first: which agent made the commit, and whether a human approved it. Making its fields mandatory makes that answer reliable. agent-commit makes everything optional so a trailer is never padded with filler, at the cost of no guarantee one exists.
- **Agent Note** keeps the full conversation outside the commit message, in git notes, which its hooks write and push. That's far more detail. agent-commit keeps only the distilled reason, inside the commit itself, so it travels wherever the commit does; git doesn't fetch notes on a plain clone unless configured to.
- **Agent Trace** is about attribution, which code an AI wrote, not why. It's complementary: it records nothing in the commit message, so a repo can use both.

## The CLI

Optional; everything above works with plain git. Run it with `npx agent-commit <command>`, or install it with `npm install -g agent-commit`.

- `log`: commits with their trailers. Filters: `--breaking`, `--grep <text>` (case-insensitive substring of `why`), `--refs <ref>` (exact entry in `refs`), `--touches <path>` (whole path segments, in both directions: `src/auth` finds `src/auth`, `src/auth/session.ts`, and `src`, never `src/authz`), `--since`, `--until`.
- `show <ref>`: one commit's trailer.
- `blame <file> [-L <start>[,<end>]]`: runs `git blame` and shows the trailer of each commit behind those lines. This is the lookup described under "The problem", in one step.
- `check [--range <range>] [--count <n>]`: read-only report of which commits have a usable trailer. Tells a missing trailer (`MISS`) apart from one git didn't recognize because of where it sits (`MISPLACED`, usually after a squash-merge), and notes when this repo's `AGENTS.md` block is out of date.
- `merge-draft <range>`: drafts a squash-merge trailer by combining a branch's `touches`, `refs`, and `breaking`, and lists each commit's `why` for you to condense.
- `init`: writes the `AGENTS.md` block (see below).

Every command takes `--json`, and results from `log`, `show`, `blame`, and `check` include the commit hash, so anything found can go straight to `git show`. `--refs` is only as reliable as the repo's consistency: a repo that mixes `INFRA-441` and `#441` for one ticket won't find one form by searching for the other. Full reference: [`cli/README.md`](./cli/README.md). To build from source: `cd cli && npm install && npm run build && node dist/index.js log`.

## What's not built

Search by meaning. `--grep webhooks` finds a `why` that contains that word, not one that says "moved off polling" without it. Real semantic search needs an embedding index or a model call at query time, and the tool has stayed fully deterministic so far. Whether that's worth changing is an open question.

## How to use it

Tell your agent to "agent-commit" your changes. The first time in a repo, it needs the block below in `AGENTS.md`:

- **With the CLI:** `npx agent-commit init`. It writes the block with a version marker and adds an `@AGENTS.md` import to `CLAUDE.md` (skip that with `--no-claude-code`). It won't overwrite an existing commit-message convention or an existing block unless you pass `--force` or `--update`. When the block changes, `check` tells you, and `init --update` replaces it.
- **By hand:** copy the block into `AGENTS.md`, creating the file if needed.

Which file your agent reads:

- Most agents (Cursor, Codex, OpenCode, and others) read `AGENTS.md` natively.
- Claude Code v2.1.277 and later reads `AGENTS.md` only when there's no `CLAUDE.md` (or `CLAUDE.local.md`); once one exists, `AGENTS.md` is ignored unless imported. A single `@AGENTS.md` line in `CLAUDE.md` is Anthropic's documented way to use both, and it also covers older versions. Claude Code skips an `AGENTS.md` it has already loaded, so it's never read twice. See [Claude Code's memory docs](https://code.claude.com/docs/en/memory).
- Gemini CLI reads `GEMINI.md` by default. Either add `AGENTS.md` to `context.fileName` in `.gemini/settings.json`, or copy the block into `GEMINI.md` too.

An agent that finds this page in a repo without the block can do the same setup itself: add the block, commit that separately from the change it was asked to make (or ask first, if the repo's conventions or the user's instructions make an unprompted commit inappropriate), then write the requested commit.

The block's last section only matters if your repo squash-merges or runs commitlint.

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

## License

Apache License 2.0. See [`LICENSE`](./LICENSE). Chosen for the explicit patent grant, which matters if this ever gets used as part of an organization's commit pipeline.
