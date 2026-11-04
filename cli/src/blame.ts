import { formatPretty } from "./format.js";
import { parseLog, runGit, runGitLog } from "./parser.js";
import type { AgentCommitRecord, ParseWarning } from "./types.js";

/** An inclusive range of line numbers in the blamed file, as it currently stands. */
export type LineRange = [start: number, end: number];

export interface BlameEntry {
  /** Full hash of the commit that last changed these lines. */
  hash: string;
  /** Every line attributed to this commit, compressed into ranges, in file order. */
  lines: LineRange[];
}

export interface BlameParseResult {
  /** One entry per distinct commit, ordered by where its first line appears in the file. */
  entries: BlameEntry[];
  /** Lines changed in the working tree but not committed yet; git attributes them to an all-zero hash. */
  uncommittedLines: number;
}

export interface BlameRecord extends AgentCommitRecord {
  lines: LineRange[];
}

export interface BlameResult {
  records: BlameRecord[];
  uncommittedLines: number;
  warnings: ParseWarning[];
}

/**
 * Header lines in `git blame --porcelain` output: the commit hash, the
 * line number in that commit's version, the line number in the file as it
 * stands now, and (on the first line of a group only) the group's size.
 * Verified against real git output. Every other line is either commit
 * metadata starting with a lowercase keyword (`author`, `summary`,
 * `previous`, `boundary`, ...) or the line's own content prefixed with a
 * tab, so neither can be mistaken for a header. Accepts SHA-1 and SHA-256
 * object names.
 */
const PORCELAIN_HEADER = /^([0-9a-f]{40}|[0-9a-f]{64}) \d+ (\d+)(?: \d+)?$/;
const UNCOMMITTED_HASH = /^0+$/;

function toRanges(lineNumbers: number[]): LineRange[] {
  const sorted = [...lineNumbers].sort((a, b) => a - b);
  const ranges: LineRange[] = [];
  for (const line of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && line === last[1] + 1) {
      last[1] = line;
    } else {
      ranges.push([line, line]);
    }
  }
  return ranges;
}

/** Parses `git blame --porcelain` output into the distinct commits responsible for the blamed lines. */
export function parseBlamePorcelain(raw: string): BlameParseResult {
  const linesByHash = new Map<string, number[]>();
  let uncommittedLines = 0;

  for (const line of raw.split("\n")) {
    const match = PORCELAIN_HEADER.exec(line);
    if (!match) continue;
    const [, hash, finalLine] = match;
    if (UNCOMMITTED_HASH.test(hash)) {
      uncommittedLines += 1;
      continue;
    }
    const existing = linesByHash.get(hash);
    if (existing) {
      existing.push(Number(finalLine));
    } else {
      linesByHash.set(hash, [Number(finalLine)]);
    }
  }

  const entries = [...linesByHash].map(([hash, lineNumbers]) => ({ hash, lines: toRanges(lineNumbers) }));
  entries.sort((a, b) => a.lines[0][0] - b.lines[0][0]);
  return { entries, uncommittedLines };
}

/**
 * Parses a `-L` value: `<start>` or `<start>,<end>`, 1-based and
 * inclusive, the numeric subset of git blame's own `-L` syntax. git's
 * regex and function-name forms are deliberately not accepted, so every
 * value that reaches git here is known to be plain numbers.
 */
export function parseLineRange(value: string): LineRange | undefined {
  const match = /^(\d+)(?:,(\d+))?$/.exec(value.trim());
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (start < 1 || end < start) return undefined;
  return [start, end];
}

/**
 * Finds the commits that last changed the given lines of a file (the
 * whole file if no range is given), then reads each one's Agent-Context.
 * Blames the working tree, like plain `git blame`, so lines not committed
 * yet are counted rather than attributed to anything.
 */
export function blame(file: string, range?: LineRange, cwd?: string): BlameResult {
  const blameArgs = ["blame", "--porcelain"];
  if (range) blameArgs.push("-L", `${range[0]},${range[1]}`);
  // `--` ends option parsing, so a path starting with "-" is read as a path.
  blameArgs.push("--", file);

  const { entries, uncommittedLines } = parseBlamePorcelain(runGit(blameArgs, cwd));
  if (entries.length === 0) return { records: [], uncommittedLines, warnings: [] };

  // --no-walk=unsorted reads exactly these commits, in the order given.
  const { records, warnings } = parseLog(
    runGitLog(["--no-walk=unsorted", ...entries.map((entry) => entry.hash)], cwd),
  );
  const linesByHash = new Map(entries.map((entry) => [entry.hash, entry.lines]));
  return {
    records: records.map((record) => ({ ...record, lines: linesByHash.get(record.hash) ?? [] })),
    uncommittedLines,
    warnings,
  };
}

function formatRanges(ranges: LineRange[]): string {
  return ranges.map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`)).join(", ");
}

/** Renders blame results like `log`'s pretty output, with each commit's line ranges right under its subject. */
export function formatBlamePretty(records: BlameRecord[]): string {
  return records
    .map((record) => {
      const [head, ...rest] = formatPretty(record).split("\n");
      return [head, `  lines: ${formatRanges(record.lines)}`, ...rest].join("\n");
    })
    .join("\n\n");
}
