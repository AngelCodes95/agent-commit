# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/), applied to the CLI in `cli/`, not
to the format itself (see `SPEC.md` for the format's own, separately tracked
version).

## [Unreleased]

## [0.1.0] - 2026-09-11

First published release.

### Added

- `agent-commit log`: filter commit history by `--breaking`, `--grep`
  (case-insensitive substring match against `why`), `--refs`, `--since`,
  `--until`; pretty-printed by default, `--json` for machine consumption.
- `agent-commit show <ref>`: show a single commit's `Agent-Context` trailer.
- `agent-commit check`: read-only report on whether recent commits have a
  usable trailer, distinguishing a trailer that was never written from one
  that exists in the message but wasn't recognized as a trailer
  (`MISPLACED`), exactly what a mishandled squash-merge produces.
- `agent-commit merge-draft <range>`: deterministically unions a branch's
  `touches`/`refs`/`breaking` and lists per-commit `why` candidates as a
  starting point for a squash-merge commit's trailer.
- `agent-commit init [directory]`: writes the `AGENTS.md` block (with a
  version marker) into a target repo instead of an agent hand-transcribing
  it from the README, links `CLAUDE.md` unless `--no-claude-code` is
  passed, and refuses to touch an existing, unrelated commit-message
  convention or an already-set-up repo without `--force`/`--update`.
- `--version`, reading the installed version live from `package.json`.
- Full test suite covering the parser, query filters, check semantics,
  merge-draft unioning, init's filesystem logic (including symlink refusal
  and atomic-write safety), depth-capped and terminal-sanitized rendering,
  and the AGENTS.md/README/agentsBlock.ts doc-sync tooling, including
  real-git integration tests, adversarial-input tests, and pinned
  regression tests for every bug found during review. (Deliberately not
  stating a count here: it drifted stale in this file on every previous
  round this project went through. Run `npm test` for the real number.)

### Security

- Fixed argument injection: `check --range`, `show <ref>`, and
  `merge-draft <range>` now reject any value starting with `-` before it
  reaches `git`'s argv, closing a path where a crafted value could make
  `git log --output=<path>` write to an arbitrary file.
- Fixed a crash: a commit trailer with pathologically deep JSON nesting
  (trivial to construct, git places no limit on trailer content) crashed
  `log`/`show` in both pretty and `--json` output with an uncaught
  `RangeError` and a raw stack trace, with no way to skip just that one
  commit, so a single such commit permanently broke reading a repo's
  history. Fixed by capping walk depth on any parsed `Agent-Context`
  value before it's displayed or serialized, rather than reacting to a
  stack overflow after the fact.
- Fixed terminal spoofing: commit subjects and trailer values (`why` in
  particular) are attacker-influenceable content read from git history
  that isn't necessarily trusted, this is explicitly part of the tool's
  purpose. A trailer containing a right-to-left override character (or
  other bidi control, zero-width, or C0 control character, including raw
  ESC, which can carry arbitrary ANSI/VT sequences to a terminal)
  rendered with that character applied verbatim in a real terminal,
  visually scrambling or hiding the displayed text. Every path that
  prints commit-derived text to a terminal (`log`, `show`, `check`,
  `merge-draft`'s text output) now neutralizes those characters into a
  visible, harmless `<U+XXXX>` marker first. `--json` output is
  deliberately unaffected: it's meant to be a faithful, unaltered
  representation of the data for machine consumption, not something
  printed raw to a terminal.
- Fixed a data-loss bug in `init --update`: the block written into a
  target repo's `AGENTS.md` is bounded by a start and end marker, and an
  earlier version of the matching logic trusted the *first* occurrence of
  each marker found in the file. A documentation example that merely
  quoted the marker syntax on its own line, alongside a real block
  elsewhere in the same file, could make `--update` silently delete real
  prose between a quoted start marker and the real end marker, or leave
  orphaned garbage (an unbalanced code fence, stale leftover text, a
  duplicate marker line) behind a quoted end marker, while still
  reporting success. Both reproduced directly. Fixed by requiring exactly
  one start marker and exactly one end marker anywhere in the file;
  anything else (none, or more than one, of either) is reported as
  `ambiguous` and the file is left untouched rather than guessed at. This
  also closes a separate case found the same way: a second, genuinely
  stale block pair elsewhere in the file used to go silently invisible
  to every future `init`/`--update` run.
- Fixed non-atomic writes: `init` used to write `AGENTS.md`/`CLAUDE.md`
  directly, so a process killed at exactly the wrong moment mid-write
  could leave the file truncated or empty, losing its prior content with
  nothing to recover from. Reproduced directly against a large file under
  repeated kill signals. Fixed by writing to a sibling temp file and
  renaming it into place, an atomic operation on the same filesystem, so
  the target is always either its old complete content or its new
  complete content, never neither.
- Fixed symlink following: `init` used to write straight through
  `AGENTS.md`/`CLAUDE.md` if either was a symlink, with no check,
  including with `--force`. Reproduced directly: a symlink pointing
  outside the target directory caused `init` to write into that external
  file instead. `init` now refuses to write through a symlinked target
  at all, unconditionally, and reports why.

### Fixed

- The CI test matrix included Node 18 to verify `package.json`'s `>=18`
  engines floor, but vitest 4 itself requires Node `^20 || ^22 || >=24`
  (its own engines field), so `npm test` crashed inside vitest's own
  dependency chain before running a single test, on every push, by
  design, not a flaky failure. Fixed by dropping 18 from the main test
  matrix (`[20, 22, 24]`, the versions that can actually run the dev
  toolchain) and adding a separate `node-18-smoke-test` job that builds
  with a newer Node and then runs the compiled CLI directly under Node 18
  against a real git repo, verifying the actual published floor without
  needing the toolchain to run there too.
- `check --count 0` (or any non-positive value) now fails cleanly instead
  of silently succeeding having checked nothing.
- `check`'s definition of a usable trailer now requires an object shape,
  matching what `query`'s structured filters actually require, instead of
  accepting any valid JSON as "ok."
- `init` no longer silently ignores an extra positional argument and
  always writes to the current directory; it now accepts an optional
  `[directory]` argument and targets that instead, and fails cleanly (not
  a raw stack trace) if the target doesn't exist.
- `init`'s existing-convention detection now also checks a `commitlint`
  key inline in `package.json`/`package.yaml` (cosmiconfig resolves both;
  a common pattern for small projects with no separate config file), and
  several previously-missing commitlint config file extensions
  (`.mjs`/`.cts`/`.mts` variants), against commitlint's own documented
  config resolution.
- `init`'s result formatter used to fall through with a blank, unexplained
  line when a newly-added result status (`ambiguous`) had no matching
  case, so the CLI would exit 1 with no indication why. Fixed, and a
  compile-time exhaustiveness check (`const _exhaustive: never = ...`) now
  guards both the `AGENTS.md` and `CLAUDE.md` result formatters, so a
  future status added without a matching case is a `tsc` error, not a
  silent runtime gap.
- Added a `prepare` script (`npm run build`) so an install that skips the
  npm registry entirely builds `dist/` (gitignored, and not part of the
  published tarball, so without this a non-registry install would ship a
  package with no working binary). This alone is not enough to make a bare
  `npm install git+https://github.com/AngelCodes95/agent-commit.git` work,
  since `package.json` lives at `cli/`, not the repo root; npm's git
  installer expects it at the root and fails before `prepare` ever runs
  (confirmed directly: `npm error enoent Could not read package.json`).
  A previous version of this entry claimed a `#<ref>?subdirectory=cli`
  suffix was the documented workaround; that was wrong, not just
  unverified, and the correction is worth recording plainly rather than
  quietly editing away: `subdirectory` was never a real npm query
  parameter. The actual mechanism (`gitSubdir`, syntax
  `#<ref>::path:<dir>`) only just landed in `pacote` (merged into pacote
  as of this writing, not yet in the npm version this was tested with,
  `10.9.2`; confirmed the older syntax fails identically against the real
  pushed GitHub URL, not just over `file://` as first assumed), and even
  the newest available npm at the time of testing (`12.0.2`) disables git
  installs entirely by default (`EALLOWGIT`). Given all of that, a
  git-URL install of this package is **not currently a recommended path**
  on any commonly-installed npm version; the registry install (`npm
  install -g agent-commit`, `npx agent-commit`) is unaffected by any of
  this and is the supported way to get the CLI. It was verified
  end-to-end via a real `npm pack` + clean install in an isolated
  directory.
- The published npm package was missing `LICENSE` and a registry
  `README.md` entirely: npm only auto-includes those from the package's
  own directory, and this repo keeps both at the root, one level above
  `cli/`. Added a `LICENSE` copy and a CLI-focused `cli/README.md` inside
  the package itself.
- Fixed a bug in the internal doc-sync tooling (not shipped, but it wrote
  README.md and cli/src/agentsBlock.ts): its regex replacement used a
  replacement *string* built via template-literal interpolation, and the
  AGENTS.md content it was inserting contains a literal `` `$` `` (in the
  prose about shell expansion); `String.replace()` interprets `` $` `` in
  a replacement string specially regardless of where the text came from,
  which silently spliced the whole preceding document into the middle of
  the generated block. Fixed by switching to a replacer function, whose
  return value is inserted literally; added regression tests covering
  this and the other special replacement sequences (`$&`, `$$`, `` $' ``,
  `$9`).

[Unreleased]: https://github.com/AngelCodes95/agent-commit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/AngelCodes95/agent-commit/releases/tag/v0.1.0
