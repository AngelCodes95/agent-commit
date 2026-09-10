# Contributing

## Setting up

```
cd cli
npm install
npm run build
npm test
```

`npm test` runs the full suite (`vitest run`), including tests that build
real temporary git repos and run the compiled CLI against them end to end,
not just unit tests against internal functions. `npx tsc --noEmit` should
also report clean before opening a PR.

## What kind of changes fit here

The CLI is a reader and query tool for the `agent-commit` format described
in `SPEC.md`. Bug fixes, better error messages, new read-side filters on
`agent-commit log`, and test coverage for cases the suite doesn't hit yet
are all welcome.

Two things are deliberately out of scope, not just unfinished, and a PR
proposing either will need a strong argument to be reconsidered, not just
implemented:

- **No semantic or meaning-based search.** `agent-commit log --grep` does
  literal, case-insensitive substring matching against `why`, on purpose.
  Real semantic search needs an embedding index or a model call at query
  time, and this project has chosen to stay fully deterministic. See
  `SPEC.md` and the README's "What's not built" section for the reasoning.
- **No mandatory schema, no enforcement by default.** Nothing about this
  format requires a linter, a CI gate, or a specific field to be present.
  `agent-commit check` is read-only and advisory by design; it reports,
  it never blocks. If you want enforcement in your own repo, wire
  `agent-commit check`'s exit code into your own CI, that's the intended
  extension point, not a change to this tool's own defaults.

## Changing the format itself

`SPEC.md` is versioned independently of the CLI (see its own header for
why). A change to the format, a new common field, a change to how
squash-merges or amends are handled, should be proposed as an issue
first, since it affects every repo that's already adopted the convention,
not just this codebase.

## Commit messages

This repo dogfoods its own format. If you're comfortable with it, write
your commits the way `AGENTS.md` describes: a normal subject line, and,
only when there's real non-obvious reasoning behind the change, a single
`Agent-Context: {...}` trailer at the end. It's not required, human or
agent, plain commits are always fine here too, the format's whole premise
is that nothing about it is mandatory.
