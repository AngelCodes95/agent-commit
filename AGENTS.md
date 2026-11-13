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
