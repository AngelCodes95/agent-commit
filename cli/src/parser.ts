import { execFileSync } from "node:child_process";
import type { AgentCommitRecord, ParseResult, ParseWarning } from "./types.js";

/**
 * A single NUL byte, as a field separator between a commit's trailer
 * extraction and its raw body. A NUL byte is the one thing guaranteed to
 * never appear inside a git commit message, git itself won't let one
 * through, so it can't collide with real content the way an earlier,
 * printable-string version of this separator once did (a commit whose
 * body happened to contain that literal string, for example one
 * documenting this very format, silently split into phantom records; see
 * SPEC.md, "Reading it back," for the incident this replaced).
 */
export const FIELD_SEP = "\0";
/** Two NUL bytes in a row, as the boundary between one commit's record and the next. Unambiguous for the same reason FIELD_SEP is: content can never contain even one NUL, let alone two adjacent ones. */
export const SENTINEL = "\0\0";
/**
 * Internal to the CLI, deliberately richer than the plain-git example in
 * SPEC.md's "Reading it back" section. That example stays a minimal
 * two-field command anyone can run with no tool; this format adds the raw
 * commit body so the CLI can detect a trailer that's present in the
 * message but sitting outside git's recognized trailer block (see the
 * MISPLACED detection in parseLog below), which the plain two-field
 * command cannot see at all. The subject is derived from the body's first
 * line rather than fetched separately, one fewer field, one fewer thing
 * that could disagree with itself.
 *
 * Uses `%x00`, git's own escape syntax for emitting a NUL byte, not a
 * literal NUL character in this string: this format string is passed as a
 * command-line argument, and a real embedded NUL there is invalid at the
 * OS/argv level (Node rejects it outright). Git converts `%x00` into an
 * actual NUL byte only in its captured *output*, a different code path
 * with no such restriction, that output byte is what FIELD_SEP/SENTINEL
 * above are matching against in parseLog. Verified by inspecting git's
 * raw output byte-for-byte before writing this.
 */
export const LOG_FORMAT = "%(trailers:key=Agent-Context,valueonly)%x00%B%x00%x00";
// Tolerates optional whitespace before the colon (git itself does: `Agent-Context : {...}`
// is extracted as a trailer just as readily as `Agent-Context: {...}`, verified against real
// git) and is case-insensitive to match git's own case-insensitive trailer key matching.
// Without either, a misplaced trailer in one of those shapes would silently read as MISS
// rather than MISPLACED, a false negative in exactly the case this detector exists to catch.
//
// Also requires what follows the colon to look like the start of a JSON
// value (an object, array, string, number, or literal), not just any text.
// This filters out plain prose that happens to start a line with the
// literal words "Agent-Context:" but was never attempting to be a trailer
// at all. It does NOT, and structurally cannot, filter out a line that
// quotes a full, valid-looking example, a docs commit demonstrating "here's
// what a trailer looks like" is textually identical to a real misplaced
// one; no regex can distinguish demonstration from intent. That's a known,
// accepted limitation, not something this tightening claims to solve; see
// SPEC.md.
const AGENT_CONTEXT_LINE = /^Agent-Context\s*:\s*("|[{[]|-?\d|true|false|null)/im;
const MIN_GIT_VERSION: [number, number, number] = [2, 15, 0];

export class GitVersionTooOldError extends Error {
  constructor(public readonly detected: string) {
    super(
      `agent-commit requires git 2.15 or newer for %(trailers:key=...) support, detected: ${detected}`,
    );
    this.name = "GitVersionTooOldError";
  }
}

export class NotAGitRepositoryError extends Error {
  constructor() {
    super("not a git repository (or any of the parent directories)");
    this.name = "NotAGitRepositoryError";
  }
}

/** Any git failure that isn't specifically "not a repository", a bad ref, a corrupt object, etc. Carries git's own stderr rather than swallowing it. */
export class GitCommandError extends Error {
  constructor(stderr: string) {
    super(stderr.trim() || "git command failed");
    this.name = "GitCommandError";
  }
}

export class GitNotFoundError extends Error {
  constructor() {
    super("git was not found on PATH; agent-commit requires git to be installed");
    this.name = "GitNotFoundError";
  }
}

function isEnoent(err: unknown): boolean {
  return (err as { code?: unknown }).code === "ENOENT";
}

function parseGitVersion(raw: string): [number, number, number] {
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(actual: [number, number, number], min: [number, number, number]): boolean {
  for (let i = 0; i < min.length; i++) {
    if (actual[i] > min[i]) return true;
    if (actual[i] < min[i]) return false;
  }
  return true;
}

/** Throws GitVersionTooOldError if the installed git predates trailer key filtering, or GitNotFoundError if git isn't installed at all. */
export function checkGitVersion(cwd?: string): void {
  let raw: string;
  try {
    raw = execFileSync("git", ["--version"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    if (isEnoent(err)) throw new GitNotFoundError();
    throw err;
  }
  const version = parseGitVersion(raw);
  if (!versionAtLeast(version, MIN_GIT_VERSION)) {
    throw new GitVersionTooOldError(raw.trim());
  }
}

/** Runs `git log` with the sentinel-delimited format from SPEC.md. Extra args are passed through (revision ranges, --since, path filters, etc). */
export function runGitLog(extraArgs: string[] = [], cwd?: string): string {
  try {
    return execFileSync("git", ["log", `--format=${LOG_FORMAT}`, ...extraArgs], {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 64,
      stdio: ["ignore", "pipe", "pipe"],
      // Forces git's own error text to English regardless of the caller's
      // locale, so the /not a git repository/i match below can't miss on a
      // machine with translated git .mo catalogs installed.
      env: { ...process.env, LC_ALL: "C" },
    });
  } catch (err) {
    if (isEnoent(err)) throw new GitNotFoundError();
    const stderr = String((err as { stderr?: unknown }).stderr ?? "");
    if (/not a git repository/i.test(stderr)) {
      throw new NotAGitRepositoryError();
    }
    if ((err as { status?: unknown }).status !== undefined) {
      // git itself exited non-zero (bad ref, corrupt object, etc): surface its
      // own message cleanly instead of leaking a raw execFileSync stack trace.
      throw new GitCommandError(stderr);
    }
    throw err;
  }
}

/**
 * Parses raw `git log --format=<LOG_FORMAT>` output into records. Each
 * commit's record (between SENTINELs, two adjacent NULs) has two fields
 * split on a single NUL: the trailer extraction (0, 1, or 2+ non-empty
 * lines: 0 means no trailer, 1 means a normal trailer, 2+ means a
 * duplicate, treated as ambiguous per SPEC.md rather than guessing which
 * is authoritative), and the raw commit body, whose first line is the
 * subject and whose full text is used only to detect a trailer that's
 * present in the message but not in the position git recognizes as a
 * trailer, exactly what GitHub's squash-merge prefill can silently
 * produce (see SPEC.md, "Squash merges").
 */
export function parseLog(raw: string): ParseResult {
  const records: AgentCommitRecord[] = [];
  const warnings: ParseWarning[] = [];

  const chunks = raw.split(SENTINEL);

  for (const chunk of chunks) {
    const trimmed = chunk.replace(/^\n+/, "").replace(/\n+$/, "");
    if (trimmed === "") continue;

    const sepIndex = trimmed.indexOf(FIELD_SEP);
    const trailerSection = sepIndex === -1 ? "" : trimmed.slice(0, sepIndex);
    const rawBody = sepIndex === -1 ? trimmed : trimmed.slice(sepIndex + FIELD_SEP.length);
    const subject = rawBody.split("\n")[0] ?? "";
    const trailerLines = trailerSection.split("\n").filter((line) => line.trim() !== "");

    if (trailerLines.length === 0) {
      const misplaced = AGENT_CONTEXT_LINE.test(rawBody);
      if (misplaced) warnings.push({ subject, reason: "misplaced-trailer" });
      records.push({ subject, context: null, malformed: false, ambiguous: false, misplaced });
      continue;
    }

    if (trailerLines.length > 1) {
      warnings.push({ subject, reason: "ambiguous-trailer" });
      records.push({ subject, context: null, malformed: false, ambiguous: true, misplaced: false });
      continue;
    }

    try {
      const context: unknown = JSON.parse(trailerLines[0]);
      records.push({ subject, context, malformed: false, ambiguous: false, misplaced: false });
    } catch {
      warnings.push({ subject, reason: "malformed-json" });
      records.push({ subject, context: null, malformed: true, ambiguous: false, misplaced: false });
    }
  }

  return { records, warnings };
}
