# The agent-commit format

Version 0.2 (draft). A specification for adding a machine-readable layer to a git commit message, without changing how commits are made or requiring any tool to write one. Versioned independently of the CLI in `cli/`, the same way Conventional Commits versions its spec separately from commitlint: this number tracks the format itself, not any particular tool's release.

## Summary

An agent-commit is an ordinary git commit whose message has two parts: a normal, human-readable summary line (nothing new: this is just a good commit subject), and, as the very last part of the message, after any body text, a single optional line of structured data describing the change for other agents to read later. This isn't a style choice: git only recognizes trailers when they form a contiguous block at the very end of the message, so the structured line has to come after the body, not directly under the subject. Nothing about how the commit gets made changes. The diff still gets read, intent still gets formed, `git commit` still runs. Only the shape of the message differs.

## Why this exists

Most commits today are proposed by a coding agent and glanced at, if at all, by a human. The agent that wrote the change already knows why it made the change it made. The moment that knowledge actually gets needed later is usually narrow and specific: an agent runs `git blame` on a confusing line, lands on the one commit responsible, and needs to know why, right then, not by reading the surrounding history for context. Today that commit's message is the only clue, and when it doesn't say, the agent is guessing, or re-deriving the reasoning from a diff that shows what changed, never why, non-deterministically, and the guess doesn't get cheaper with repetition. That one-commit, blame-time lookup is the case this format is actually built for; reconstructing intent across a longer stretch of history benefits too, but it's the secondary win. When a trailer is present, it should be enough by itself to tell another agent whether that change is relevant to the task in front of it, without opening the diff. When it isn't present, that's information too: it means whoever wrote the commit judged the summary line sufficient on its own.

This is the same idea as [Conventional Commits](https://www.conventionalcommits.org/), structure a commit message so tooling can use it, with one real difference worth being upfront about: Conventional Commits gets its reliability from `commitlint` enforcing the grammar in CI. Nothing here is enforced. agent-commit borrows the same trailer mechanism `Co-Authored-By:` already uses (plain git, no new file format, survives any tool that doesn't know about it), but the reliability model is closer to a commit message itself: informative when present, absent when nobody bothered, never guaranteed.

## Format

```
refactor(events): switch from polling to webhooks

Agent-Context: {"why":"polling caused high load and delayed updates; webhooks via the provider's event API fixed both, rejected increasing the poll interval since it still added meaningful latency","refs":["INFRA-441"]}
```

That trailer is doing real work: neither the subject nor a diff of this change would tell a future reader that increasing the poll interval was tried and rejected, or why. That's the bar for what belongs in the trailer, information the diff and the subject line genuinely don't carry, not a restatement of either.

This trailer doesn't require exclusivity. Several agents, Claude Code among them, already append their own trailers automatically, most commonly `Co-Authored-By:`. `Agent-Context:` simply joins whatever trailer block already exists at the end of the message; git treats the trailers in that block as a set, not an ordered sequence, and `%(trailers:key=Agent-Context,valueonly)` extracts by key regardless of what else is present or where it sits within the block.

Two parts:

1. **The summary line.** Required, in the sense that every commit has one anyway: this is just an ordinary, well-written git commit subject. Nothing about it changes under this spec. If nothing else in this document is followed, this line alone still makes the commit more useful than an unstructured one.
2. **The `Agent-Context:` trailer.** Optional, single line, valid JSON, no pretty-printing (git trailers are one value per line, this is a hard requirement of the mechanism, not a style preference: a multi-line, indented JSON block is not extractable by `%(trailers:key=...)`, it just becomes unstructured body text). If a compact single-line trailer is hard to scan by eye, that's expected and intentional, this format optimizes for one-command machine extraction at write time, not for human readability while scrolling `git log`. Rendering it as readable, pretty-printed output on demand is a reader-tool concern (see README.md), not something this format sacrifices its core mechanism for. Present only when there's something to say that the summary and body genuinely don't already carry. A commit with nothing further to add omits the trailer entirely: an absent trailer is not an error and is not a lesser commit, it just means the summary line was already sufficient. Write exactly one per commit: git technically permits repeating a trailer key, and `%(trailers:key=Agent-Context,valueonly)` will return every occurrence it finds, but this format doesn't define what more than one means on a single commit. A reader that finds more than one should treat the commit as ambiguous rather than guessing which is authoritative.

## Writing it safely

The trailer is JSON, which means it contains its own double quotes. Building the whole commit message through a shell-interpolated `git commit -m "..."` and hand-escaping those quotes is a common way to silently corrupt the message. Prefer passing the complete message (subject, blank line, body if any, blank line, trailer) via `git commit -F -` with the message piped or heredoc'd in, or `git commit -F <path>` from a file, rather than hand-escaping quotes inside a `-m` argument.

Two details that matter if you're heredoc'ing the message in: use a quoted delimiter (`<<'EOF'`, not `<<EOF`) so the shell doesn't expand a stray `$` or backtick that happens to appear inside a `why` string, and make sure the JSON itself is actually valid before it goes in: no literal newlines inside string values, and any double quote that appears inside a string value escaped as `\"`. A trailer that isn't valid JSON is worse than no trailer at all, it looks structured and isn't.

## Fields

There is no required schema inside the trailer beyond "valid JSON." The following fields are common, not mandatory, and exist as shared vocabulary so that agents across different repos converge on the same keys instead of each inventing their own.

One asymmetry worth naming: the "omit when in doubt" guidance below is calibrated for a human typing a commit by hand, where every field has a real cost. An agent applying this convention doesn't have that cost, it already has the diff and the reasoning sitting in context, so for agent-authored commits specifically, default toward including `why` (and `touches` when it applies) whenever there's real content for them, rather than defaulting to omission. Consistency is what makes structured data queryable later, and agents are the one class of writer that can actually deliver it at near-zero marginal cost.

| Field | Meaning |
|---|---|
| `why` | Reasoning the subject and body don't already carry: a rejected alternative, a non-obvious constraint, the actual cause behind a fix. This is usually the only field worth the space, and it's the one piece of this format that a diff can never reconstruct. It must be a concrete, specific thing, not a plausible-sounding guess: if there isn't a real alternative, constraint, or cause to point to, omit the field entirely rather than inventing one to fill it. An absent `why` is honest; a fabricated one isn't, and structure doesn't make a claim more true, only easier to search. If `why` would just restate the subject, leave it out. |
| `touches` | Files, directories, or named components meaningfully affected. This is the one deliberate exception to the "genuinely new information" bar above: it's derivable from the diff, but capturing it saves a future reader the cost of diffing just to check relevance. Worth including on changes that span multiple files or components in a way that isn't obvious from the subject; skip it on single-file changes where the diff stat already tells the whole story (for agent-authored commits, per the asymmetry above, err toward including it anyway). Use repo-relative paths from the repository root, forward slashes, no leading `./` or `/`; prefer the most specific meaningful path over a vague top-level guess (`src/auth/session.ts` or `src/auth`, not just `auth`). This isn't validated, but it's what makes exact-match filtering later actually find things: `auth` and `src/auth` are different strings to a query even when they mean the same thing to a person. |
| `breaking` | Present only when true, and only when it's actually a judgment call worth flagging: a change to a public contract, an exported signature, a config shape. Omit rather than writing `false` by default; absence means "nothing flagged," not "confirmed safe." |
| `refs` | Ticket, issue, or related-commit references, when they exist. Use the tracker's own short reference form consistently: the bare ticket ID for systems like Jira (`INFRA-441`), or `#123` for GitHub issues and PRs. Never a full URL, and don't mix forms for the same tracker within one repo, that's specifically what breaks exact-match lookups on `refs` later. |

**Deliberately not a field: `type`.** If a repo already prefixes subjects with a Conventional-Commits-style type (`fix(auth): ...`), repeating it in the trailer just creates a second copy that can quietly disagree with the first, with no rule for which one wins. If a repo doesn't use that convention, the kind of change is usually clear enough from the summary that a dedicated field isn't worth the space. Either way, the subject line is the one place `type` belongs.

None of these fields are required, none are validated by any tool, and the list is expected to change as real usage shows what's actually worth including. Include a field because it's useful to the next reader, not because a schema demands it.

## What this is not

- Not a replacement for the summary line. The summary line is the commit message. The trailer is an addition, never a substitute for writing a clear subject.
- Not verified or enforced by anything in this spec. The trailer is a claim, the same way a commit message has always been a claim. Nothing here checks that `touches` is accurate or that `breaking: true` is correct, and nothing here reconciles a trailer against what the diff actually shows if the two seem to disagree, a `breaking: true` next to a trivially safe-looking diff, or the reverse, is a judgment call for whoever reads it, not something this format resolves on its own. Treat it the way you'd treat any commit message: informative, not proof.
- Not a package to install. Writing an agent-commit requires nothing beyond a normal `git commit`. The one-time step of adding this convention to a repo (see `README.md`) is a plain text edit to an existing file, not a download or a dependency.

## Squash merges: the merge commit must carry its own trailer

GitHub's default squash-merge concatenates the messages of every squashed commit into one new commit, but git's trailer parser (`%(trailers)`, `git interpret-trailers`) only recognizes the trailer block at the very end of a message, so a squash keeps only the last commit's trailer as machine-readable data; earlier ones degrade into plain text and stop being extractable. In practice it's often worse than that: many squash-merge setups use the pull request's title and description instead of any individual commit's message, in which case every trailer on the branch is dropped, not just the earlier ones.

This matters more than an ordinary edge case, because it's exactly where this format's main payoff lives. An agent cold-reading history months later is reading `main`, and `main` is where most repos squash-merge. If per-commit trailers only survive on feature branches nobody keeps around, the format delivers its value nowhere that matters.

**The rule: whoever performs a squash-merge writes a condensed `Agent-Context` trailer into the resulting commit, at merge time, as part of composing that commit's message.** This is not a new mechanism, it's the same rule as any other commit in this spec, just applied to the commit a squash-merge produces. In practice, that means passing the trailer through the merge command itself, for example:

```
gh pr merge --squash --subject "refactor(events): switch from polling to webhooks" \
  --body 'Agent-Context: {"why":"polling caused high load and delayed updates, rejected a shorter poll interval as a half-fix","touches":["api/events"],"refs":["#18"]}'
```

The condensed trailer summarizes the branch's net intent, not a concatenation of every commit on it: the key decisions, constraints, or rejected alternatives that mattered, `touches` for what the branch affected overall, `refs` for the PR and any tickets, `breaking` if anything on the branch was breaking. Per-commit trailers on the source branch remain useful during review; the merge commit's trailer is what survives onto the branch that gets read later.

**Confirmed by direct test, not assumed**: passing `--body` replaces the squash commit's message wholesale, and does not preserve any `Co-authored-by:` line GitHub would otherwise have generated for a multi-author PR. Verified against a real two-author PR on a scratch repo: squash-merging without `--body` produced a commit with `Co-authored-by:` appended automatically; squash-merging the same PR shape with a plain `--body` produced one with no `Co-authored-by:` line at all. The fix is to include those lines yourself, in the same string, glued to the same final block as the trailer with no blank line between:

```
gh pr merge --squash --subject "refactor(events): switch from polling to webhooks" \
  --body 'Agent-Context: {"why":"polling caused high load and delayed updates, rejected a shorter poll interval as a half-fix","touches":["api/events"],"refs":["#18"]}
Co-authored-by: Name <email>'
```

Also verified directly: both trailers extract independently and correctly this way (`%(trailers:key=Agent-Context,valueonly)` and `%(trailers:key=Co-authored-by,valueonly)` each return their own value, nothing bleeds between them). Whoever runs the merge is responsible for listing every other author on the branch; nothing restores this automatically once `--body` is supplied, not a reason to avoid `--body`, just a step it doesn't do for you.

**What this deliberately does not do, and why**: a bot or CI step cannot add this after the merge has already happened without rewriting a commit that's already on a shared branch, which means force-pushing over history other people and other tooling may already depend on. That's a dangerous operation this spec will not recommend automating. There is no retrofit for old squash-merges missing a trailer, and no attempt to invent one; this rule only applies going forward, to merges performed after a repo adopts it. `agent-commit check` (see the CLI) reports on this, read-only, it never attempts to write one in after the fact.

### The real trap: placement, not the merge strategy itself

A human merging through GitHub's web UI is not defeated by GitHub secretly appending content after what they type, whatever sits in the merge dialog's editable boxes when they confirm becomes the message verbatim. The actual trap is upstream of that: GitHub's squash dialog **prefills** those boxes, and depending on the repo's commit-message setting, that prefill often already ends with a trailer block of its own, typically one or more `Co-authored-by:` lines, sometimes preceded by a `---------` divider. Verified against real squash-merge commits. If a human (or an agent) writes `Agent-Context:` into the description text above that prefilled block, with a blank line separating the two, the result is two disconnected trailer-shaped blocks instead of one contiguous one, and git's trailer parser only recognizes the last contiguous block. The `Agent-Context:` line silently stops being a trailer, even though it's sitting right there in the message, readable by eye.

**The rule this implies: whatever GitHub (or anything else) has already prefilled into the merge commit's message, the `Agent-Context:` trailer has to join that same final block, not sit above it separated by a blank line.** If the prefill ends with `Co-authored-by:` lines, put `Agent-Context:` immediately adjacent to them, no blank line between. `agent-commit check` (see the CLI) can catch this exact failure after the fact: it distinguishes a commit with no trailer at all from one where an `Agent-Context:` line exists in the message but wasn't recognized as a trailer, reported as `MISPLACED` rather than `MISS`, so the two don't get confused with each other.

**A known, accepted limitation of `MISPLACED` worth stating plainly rather than glossing over**: it's a text heuristic, not a semantic one. It requires a line starting with `Agent-Context:` followed by something that looks like the start of a JSON value, which filters out plain prose that happens to mention the term (a commit body reading "write the Agent-Context: trailer at the end" is correctly ignored). It cannot, and structurally never will, filter out a commit that quotes a complete, valid-looking example as documentation, for instance a commit explaining this exact section of this exact spec. That commit's body is textually identical to a real misplaced trailer; no regex can tell "demonstrating the wrong shape" apart from "an actual attempt that landed wrong." Treat a `MISPLACED` report the way you'd treat any other claim this format makes: informative, not proof.

## A related ambiguity: amends can drop a trailer silently

`git commit --amend` can drop the trailer entirely if whoever amends the message doesn't preserve it, not just make its claims stale. A reader has no way to tell a commit that never had a trailer apart from one that lost it during an amend; both simply look like an ordinary commit with no `Agent-Context` trailer. The same staleness applies to any rebase that changes a commit's diff after its trailer was written: the trailer's claims may no longer describe the code precisely.

## A known limitation: commitlint's default line-length rules

Repos that enforce Conventional Commits via `commitlint`'s default rule set apply `footer-max-line-length: 100` and `body-max-line-length: 100`. A realistic `Agent-Context` trailer runs 200 to 400 characters on one line, well past that limit, since the whole point is fitting a rejected alternative or a constraint into a single trailer value. That means in exactly the repos most likely to already have structured-commit tooling in place, and so be the most receptive to this, the default commitlint config rejects every agent-commit outright. This isn't an edge case, it's the default configuration.

There's no fix on agent-commit's side; it produces long lines by design. Repos that want both need to either relax `footer-max-line-length` and `body-max-line-length`, or write a custom commitlint rule or plugin that specifically exempts trailer lines from the length check, since commitlint's built-in `ignores` option skips a whole commit that matches a pattern, not individual lines within one, so it can't scope this down to just the trailer. Worth checking before adopting this in a repo that already runs commitlint, since otherwise CI will reject every agent-commit and the failure won't be obvious from the trailer's own content.

## Reading it back

No tool is required to read this either (requires roughly git 2.15+, when `%(trailers:key=...)` was added). For a single commit:

```
git log -1 --format='%s%n%(trailers:key=Agent-Context,valueonly)'
```

returns the summary line followed by its raw `Agent-Context` JSON (when present), parseable with any JSON library in any language. Against the example above, that's actually:

```
refactor(events): switch from polling to webhooks
{"why":"polling caused high load and delayed updates; webhooks via the provider's event API fixed both, rejected increasing the poll interval since it still added meaningful latency","refs":["INFRA-441"]}
```

**Reading more than one commit needs a delimiter.** The format string above has no record separator, and `%(trailers:...)` resolves to an empty line when a commit has no trailer, so scanning several commits at once, some with a trailer and some without, gives a consumer no reliable way to tell where one commit's block ends and the next one's begins. Add a delimiter, but not a printable one: an earlier draft of this spec used a plain string here (literally `---AGENT-COMMIT---`), and a real commit whose body happened to quote that string, for instance one documenting this exact format, silently split into two records instead of one. Use a NUL byte instead, via git's own `%x00` escape, which is the one thing guaranteed to never appear inside a commit message, git itself won't allow it through:

```
git log --format='%s%n%(trailers:key=Agent-Context,valueonly)%x00'
```

Split the output on the NUL byte (`\0` in most languages, `tr '\0' '\n'` at a shell); each resulting chunk is exactly one commit's summary line, optionally followed by its trailer JSON, with no risk of a commit's own content ever being mistaken for the delimiter. Verified against a real multi-commit history, including a commit whose body literally contains the old, retired string delimiter, to confirm it no longer causes a split.

This already works today, verified against a real commit, not just described; see `README.md`, "What the CLI does today," for the working tool built on top of it.

The CLI's own internal format goes one step further than the two commands above: it also captures each commit's raw message body, specifically so it can tell a genuinely absent trailer apart from one that exists in the message but landed outside the position git recognizes as a trailer (see "The real trap: placement, not the merge strategy itself" above). That's a CLI capability, not a requirement of the format itself; the plain two-field commands here remain everything a reader needs with nothing installed.
