#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { blame, formatBlamePretty, parseLineRange } from "./blame.js";
import { checkRecords } from "./check.js";
import { formatJson, formatPrettyList, sanitizeForTerminal } from "./format.js";
import { formatInitResult, needsAction, runInit } from "./init.js";
import { buildMergeDraft, formatMergeDraft } from "./merge-draft.js";
import {
  checkGitVersion,
  GitCommandError,
  GitNotFoundError,
  GitVersionTooOldError,
  NotAGitRepositoryError,
  parseLog,
  runGitLog,
} from "./parser.js";
import { queryRecords } from "./query.js";
import type { QueryOptions } from "./query.js";
import type { ParseWarning } from "./types.js";

function fail(message: string): never {
  process.stderr.write(`agent-commit: ${message}\n`);
  process.exit(1);
}

/**
 * A ref/range value that starts with `-` would otherwise reach `git log`'s
 * argv as-is (execFileSync never goes through a shell, so this isn't shell
 * injection, but git itself has no such protection: `--output=<path>`
 * redirects git's own formatted output to an arbitrary file instead of
 * stdout). No real git ref or revision range legitimately starts with `-`,
 * so rejecting it outright costs nothing. Commander's own unknown-option
 * rejection does not cover this: a `--` before the value defeats it and
 * the literal string still reaches this argument.
 */
function rejectOptionLikeArg(value: string, label: string): void {
  if (value.startsWith("-")) {
    fail(`${label} must not start with "-", got "${value}"`);
  }
}

function runFatal<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (
      err instanceof GitVersionTooOldError ||
      err instanceof NotAGitRepositoryError ||
      err instanceof GitCommandError ||
      err instanceof GitNotFoundError
    ) {
      fail(err.message);
    }
    throw err;
  }
}

function printWarnings(warnings: ParseWarning[]): void {
  for (const warning of warnings) {
    process.stderr.write(
      `agent-commit: warning: ${warning.reason} on commit ${warning.shortHash} "${sanitizeForTerminal(warning.subject)}", skipped\n`,
    );
  }
}

// Read at runtime rather than importing the JSON module directly: this file
// compiles to dist/index.js, one directory below package.json, and that
// relative position is the one thing guaranteed stable whether run from a
// local build or an npm-installed bin symlink.
const packageJsonPath = new URL("../package.json", import.meta.url);
const { version } = JSON.parse(readFileSync(fileURLToPath(packageJsonPath), "utf8")) as {
  version: string;
};

const program = new Command();

program
  .name("agent-commit")
  .description("Reader and query tool for agent-commit formatted git history")
  .version(version);

program
  .command("log")
  .description("query agent-commit history")
  // No --type filter: SPEC.md is explicit that `type` is deliberately not a
  // field (it belongs in the subject line, per Conventional Commits style),
  // so a spec-conforming commit never has one to match against. A --type
  // flag here would silently never match anything on a correctly-written
  // repo, which is worse than not having it.
  .option("--breaking", "filter to breaking: true only")
  .option("--grep <text>", "case-insensitive substring match against why")
  .option("--refs <ref>", "filter to commits whose refs array contains this exact value")
  .option(
    "--touches <path>",
    "filter to commits whose touches overlaps this path, on whole path segments (src/auth matches src/auth/session.ts and src)",
  )
  .option("--since <date>", "passed through to git log --since")
  .option("--until <date>", "passed through to git log --until")
  .option("--json", "output machine-readable JSON instead of pretty text")
  .action((opts: {
    breaking?: boolean;
    grep?: string;
    refs?: string;
    touches?: string;
    since?: string;
    until?: string;
    json?: boolean;
  }) => {
    runFatal(() => checkGitVersion());

    const extraArgs: string[] = [];
    if (opts.since) extraArgs.push(`--since=${opts.since}`);
    if (opts.until) extraArgs.push(`--until=${opts.until}`);

    const raw = runFatal(() => runGitLog(extraArgs));
    const { records, warnings } = parseLog(raw);
    printWarnings(warnings);

    const queryOptions: QueryOptions = {};
    if (opts.breaking) queryOptions.breaking = true;
    if (opts.grep) queryOptions.grep = opts.grep;
    if (opts.refs) queryOptions.refs = opts.refs;
    if (opts.touches !== undefined) queryOptions.touches = opts.touches;

    const filtered = queryRecords(records, queryOptions);

    process.stdout.write((opts.json ? formatJson(filtered) : formatPrettyList(filtered)) + "\n");
  });

program
  .command("show")
  .argument("<ref>", "a git revision, defaults to HEAD-style refs git already understands")
  .description("show a single commit's Agent-Context")
  .option("--json", "output machine-readable JSON instead of pretty text")
  .action((ref: string, opts: { json?: boolean }) => {
    rejectOptionLikeArg(ref, "<ref>");
    runFatal(() => checkGitVersion());

    const raw = runFatal(() => runGitLog(["-1", ref]));
    const { records, warnings } = parseLog(raw);
    printWarnings(warnings);

    if (records.length === 0) {
      fail(`no commit found for ${ref}`);
    }

    process.stdout.write((opts.json ? formatJson(records) : formatPrettyList(records)) + "\n");
  });

program
  .command("blame")
  .argument("<file>", "a file in the repository, as it currently stands in the working tree")
  .description(
    "shows the Agent-Context of each commit that last changed the given lines (the whole file " +
      "without -L), via git blame. One entry per commit, ordered by where its lines first " +
      "appear in the file. Lines not committed yet are counted on stderr, not attributed.",
  )
  .option("-L <start[,end]>", "only these lines, 1-based and inclusive, e.g. -L 42 or -L 40,60")
  .option("--json", "output machine-readable JSON instead of pretty text")
  .action((file: string, opts: { L?: string; json?: boolean }) => {
    let range: ReturnType<typeof parseLineRange>;
    if (opts.L !== undefined) {
      range = parseLineRange(opts.L);
      if (!range) {
        fail(`-L must be <start> or <start>,<end> with 1 <= start <= end, got "${opts.L}"`);
      }
    }
    runFatal(() => checkGitVersion());

    const { records, uncommittedLines, warnings } = runFatal(() => blame(file, range));
    printWarnings(warnings);
    if (uncommittedLines > 0) {
      process.stderr.write(
        `agent-commit: ${uncommittedLines} line(s) not committed yet, so no commit to show for them\n`,
      );
    }

    process.stdout.write((opts.json ? formatJson(records) : formatBlamePretty(records)) + "\n");
  });

program
  .command("check")
  .description(
    "advisory, read-only: reports which recent commits are missing a usable Agent-Context " +
      "trailer, and distinguishes MISS (no trailer at all) from MISPLACED (a trailer exists " +
      "in the message but git didn't recognize it as one). Never writes anything. Exits " +
      "non-zero if any checked commit isn't OK, so it can be used as a local gate if a repo " +
      "wants that, but nothing here enforces it by default.",
  )
  .option("--range <range>", "a git revision range to check, e.g. origin/main..HEAD")
  .option("--count <n>", "check only the last N commits", "1")
  .option("--json", "output machine-readable JSON instead of the aligned text table")
  .action((opts: { range?: string; count: string; json?: boolean }) => {
    runFatal(() => checkGitVersion());

    if (opts.range) {
      rejectOptionLikeArg(opts.range, "--range");
    } else {
      const count = Number(opts.count);
      if (!Number.isInteger(count) || count < 1) {
        fail(`--count must be a positive integer, got "${opts.count}"`);
      }
    }

    const extraArgs = opts.range ? [opts.range] : [`-${opts.count}`];
    const raw = runFatal(() => runGitLog(extraArgs));
    const { records, warnings } = parseLog(raw);
    printWarnings(warnings);

    const results = checkRecords(records);

    if (opts.json) {
      process.stdout.write(JSON.stringify(results, null, 2) + "\n");
    } else {
      // Computed, not hand-padded: hand-counted spaces are exactly how this
      // misaligned the first time (MISPLACED is 9 chars, OK/MISS were
      // padded to 8).
      const labelWidth = Math.max("OK".length, "MISS".length, "MISPLACED".length);
      const labels: Record<(typeof results)[number]["status"], string> = {
        ok: "OK".padEnd(labelWidth),
        miss: "MISS".padEnd(labelWidth),
        misplaced: "MISPLACED".padEnd(labelWidth),
      };
      for (const result of results) {
        process.stdout.write(
          `${labels[result.status]}  ${result.shortHash}  ${sanitizeForTerminal(result.subject)}\n`,
        );
      }
    }

    if (results.some((r) => r.status === "misplaced")) {
      process.stderr.write(
        "agent-commit: MISPLACED means an Agent-Context line exists in the message but git\n" +
          "didn't recognize it as a trailer, usually a blank line between it and the rest of\n" +
          "the trailer block (see SPEC.md, \"Squash merges\").\n",
      );
    }

    if (results.some((r) => r.status !== "ok")) {
      process.exitCode = 1;
    }
  });

program
  .command("merge-draft")
  .argument("<range>", "a git revision range for the source branch, e.g. main..feature or origin/main..HEAD")
  .description(
    "read-only: reads the range's per-commit trailers and drafts a starting point for the " +
      "condensed Agent-Context a squash-merge commit needs (see SPEC.md). Deterministically " +
      "unions touches/refs/breaking; why is never synthesized, only listed as raw candidates " +
      "for whoever finalizes the trailer, an agent using its own reasoning or a human, to " +
      "condense by hand. Never writes anything.",
  )
  .option("--json", "output the draft as structured JSON instead of the text skeleton")
  .action((range: string, opts: { json?: boolean }) => {
    rejectOptionLikeArg(range, "<range>");
    runFatal(() => checkGitVersion());

    const raw = runFatal(() => runGitLog([range]));
    const { records, warnings } = parseLog(raw);
    printWarnings(warnings);

    const draft = buildMergeDraft(records);
    process.stdout.write((opts.json ? JSON.stringify(draft, null, 2) : formatMergeDraft(draft)) + "\n");
  });

program
  .command("init")
  .argument("[directory]", "target directory, defaults to the current directory")
  .description(
    "writes the agent-commit AGENTS.md block into the target directory (and, unless " +
      "--no-claude-code, links CLAUDE.md to it), so an agent doesn't have to hand-transcribe " +
      "it from the README. Refuses to touch an existing, unrelated commit-message convention " +
      "or overwrite an outdated block unless told to. Never touches git.",
  )
  .option("--force", "add the block even if an existing, unrelated commit-message convention was detected")
  .option("--update", "replace an outdated agent-commit block with the current version")
  .option("--no-claude-code", "skip creating or updating CLAUDE.md's @AGENTS.md import")
  .option("--json", "output the result as structured JSON instead of a text summary")
  .action((directory: string | undefined, opts: { force?: boolean; update?: boolean; claudeCode: boolean; json?: boolean }) => {
    const target = directory ?? process.cwd();
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      fail(`"${target}" is not a directory`);
    }

    const result = runInit(target, {
      force: opts.force,
      update: opts.update,
      noClaudeCode: !opts.claudeCode,
    });

    process.stdout.write((opts.json ? JSON.stringify(result, null, 2) : formatInitResult(result)) + "\n");

    if (needsAction(result)) {
      process.exitCode = 1;
    }
  });

program.parse();
