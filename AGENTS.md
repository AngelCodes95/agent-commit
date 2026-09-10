<!-- agent-commit-format-version: 0.2 -->

## Commit messages

When asked to "agent-commit" changes, format the commit message as:

1. A normal, clear one-line summary, same as any good commit subject.
2. Optionally, a blank line and a body, same as any normal commit.
3. Optionally, if there's context the summary and body don't already carry
   that would save the next agent from having to open the diff (a rejected
   alternative, a non-obvious constraint, the real cause behind a fix), add
   a single-line trailer as the very last part of the message:

   `Agent-Context: {"why":"...","refs":["TICKET-123"]}`

Never invent a `why` just to fill the field: only write one if there's a
real, specific alternative, constraint, or cause behind it. If there isn't,
omit it. An absent `why` is honest; a fabricated one looks just as
authoritative and isn't.

Common fields: `why` (reasoning not already in the subject/body, usually
the only field worth including), `touches` (files or components affected,
only when it's not obvious from the subject), `breaking` (only when true;
never write `false`, just omit it), `refs` (ticket/issue links). None are
required. Skip the trailer entirely if the summary line already says
everything worth saying, and never repeat the commit's type in the
trailer if the subject already has one (e.g. `fix(auth): ...`), that
just creates two copies that can disagree.

Keep `touches` and `refs` in a consistent form, that's what makes later
lookups actually find things: repo-relative paths with no leading `./` or
`/` for `touches` (`src/auth`, not `auth` or `./src/auth`), and the
tracker's own short form for `refs` (`INFRA-441` or `#123`, never a full
URL, never both forms for the same tracker in one repo).

You're an agent applying this, not a human typing by hand, so your cost
to fill in `why` and `touches` is close to zero, you already have the
diff and the reasoning in context. Default toward including them
whenever there's real content for them, rather than defaulting to
omission the way a human typing by hand reasonably would.

Build the message via `git commit -F -` (piped, or heredoc'd with a
quoted delimiter like `<<'EOF'`, an unquoted one lets the shell expand
`$` and backticks inside `why`) or `git commit -F <file>`, rather than
hand-escaping the JSON's quotes inside a `-m` argument, since that's a
common way to corrupt the message.

If this repo squash-merges pull requests or runs commitlint, read the
appendix below before your first commit, both change what you need to do.

Full spec: https://github.com/AngelCodes95/agent-commit/blob/main/SPEC.md

### Appendix: squash-merges and commitlint

If this repo runs commitlint, check for `footer-max-line-length` or
`body-max-line-length` before your first commit. Their defaults (100)
reject a realistic Agent-Context trailer outright, this isn't an edge
case, it's the default config in exactly the repos most likely to
already care about structured commits. See SPEC.md's commitlint
section for the fix (relax those two rules, or exempt trailer lines).

When squash-merging a pull request, write a condensed Agent-Context
trailer into the resulting merge commit yourself, at merge time, the
same way you would for any other commit, summarizing the branch's net
intent rather than every individual commit on it. If the `agent-commit`
CLI is available, get a starting point first instead of writing it
from nothing:

```
agent-commit merge-draft main..HEAD
```

This deterministically unions `touches`/`refs`/`breaking` from the
branch's own per-commit trailers and lists each commit's raw `why` as
a candidate; it never writes a finished `why` for you; condense those
candidates into one sentence yourself, then merge:

```
gh pr merge --squash --subject "..." --body 'Agent-Context: {"why":"...","refs":["#18"]}'
```

Confirmed, not just a caveat: `--body` replaces the squash commit's
message wholesale, which drops any `Co-authored-by:` line GitHub would
otherwise add for a multi-author PR. If there's more than one author on
the branch, include their `Co-authored-by:` lines yourself, in the same
`--body` string, glued to the same final block as the trailer with no
blank line between:

```
gh pr merge --squash --subject "..." --body 'Agent-Context: {"why":"...","refs":["#18"]}
Co-authored-by: Name <email>'
```

See SPEC.md for how this was verified.

This is the one case where it matters: per-commit trailers on a source
branch don't survive a squash-merge (see SPEC.md), so the merge commit
is the only place a trailer can land on the branch that gets read
later. Skipping this step means the branch's context is lost the
moment it's squashed onto the default branch.

If a human merges through GitHub's web UI instead, the same rule
applies but the trap is different: GitHub's squash dialog often
prefills the message with its own trailer block (usually
Co-authored-by: lines). Agent-Context: has to join that same final
block, with no blank line separating them, not sit above it in the
description text, or git won't recognize it as a trailer at all. Run
`agent-commit check` afterward; it reports this exact failure as
MISPLACED, distinct from a trailer that was never written.

<!-- /agent-commit-format-version -->
