import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS_BLOCK, FORMAT_VERSION } from "./agentsBlock.js";

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Writes by creating a sibling temp file and renaming it into place, rather
 * than writing the target directly, so a process killed mid-write can never
 * leave it truncated: the target is always either its old complete content
 * or its new complete content, never neither. Reproduced directly: a plain
 * writeFileSync left a real AGENTS.md at 0 bytes when the process was
 * killed at exactly the wrong moment. The temp file lives in the same
 * directory as the target so the rename is guaranteed to be same-filesystem
 * (and therefore atomic on POSIX and Windows both).
 */
function writeFileAtomic(path: string, content: string): void {
  const tmpPath = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  writeFileSync(tmpPath, content);
  renameSync(tmpPath, path);
}

export interface InitOptions {
  /** Proceed even if an existing, unrelated commit-message convention was detected. */
  force?: boolean;
  /** Replace an outdated agent-commit block with the current one. Without this, a stale block is only reported, never touched. */
  update?: boolean;
  /** Skip creating or updating CLAUDE.md's @AGENTS.md import. */
  noClaudeCode?: boolean;
}

export type AgentsMdAction =
  | "created"
  | "appended"
  | "updated"
  | "unchanged"
  | "stale"
  | "ambiguous"
  | "symlink"
  | "skipped-existing-convention";

export type ClaudeMdAction = "created" | "updated" | "unchanged" | "symlink";

export interface InitResult {
  agentsMd: {
    path: string;
    action: AgentsMdAction;
    detail?: string;
  };
  claudeMd?: {
    path: string;
    action: ClaudeMdAction;
    detail?: string;
  };
}

const START_MARKER_RE = /^<!-- agent-commit-format-version: (\S+) -->$/m;
const END_MARKER_RE = /^<!-- \/agent-commit-format-version -->$/m;
// Global-flagged twins for counting every occurrence, not just the first.
// Safe to hold as module-level constants: matchAll doesn't mutate lastIndex
// on the regex object it's given, it iterates its own internal copy.
const START_MARKER_RE_G = /^<!-- agent-commit-format-version: (\S+) -->$/gm;
const END_MARKER_RE_G = /^<!-- \/agent-commit-format-version -->$/gm;

interface BlockSpan {
  /** Index of the start marker line. */
  startIndex: number;
  /** Index just past the end marker's line, or null if the block's extent can't be determined unambiguously. */
  endIndex: number | null;
  version: string;
}

/**
 * Locates the agent-commit block's exact extent via both markers, not just
 * "from the start marker to the end of the file" (an earlier version
 * assumed the block was always the last thing in AGENTS.md and replaced
 * everything from the marker onward on --update, silently deleting real
 * content after it) and not just "the first occurrence of each marker" (a
 * later version still misfired when a start or end marker was merely
 * quoted in documentation elsewhere in the same file, alongside a real
 * block: it could silently delete real prose between a quoted start marker
 * and the real end marker, or leave orphaned garbage behind a quoted end
 * marker. Both reproduced as actual data loss, not just theoretical).
 *
 * The only shape this trusts is exactly one start marker and exactly one
 * end marker, anywhere in the file, with the end after the start: anything
 * else (zero, or more than one, of either) can't be resolved without
 * guessing which occurrence is real, so it's reported as ambiguous instead.
 */
function findBlockSpan(text: string): BlockSpan | null {
  const startMatches = [...text.matchAll(START_MARKER_RE_G)];
  if (startMatches.length === 0) return null;

  const startIndex = startMatches[0].index;
  const version = startMatches[0][1];
  const endMatches = [...text.matchAll(END_MARKER_RE_G)];

  if (startMatches.length > 1 || endMatches.length !== 1) {
    return { startIndex, endIndex: null, version };
  }

  const endMatch = endMatches[0];
  if (endMatch.index < startIndex) {
    return { startIndex, endIndex: null, version };
  }

  return { startIndex, endIndex: endMatch.index + endMatch[0].length, version };
}

// Every config filename commitlint's own docs list as supported, resolved
// via cosmiconfig: https://commitlint.js.org/reference/configuration.html
const COMMITLINT_CONFIG_NAMES = [
  "commitlint.config.js",
  "commitlint.config.cjs",
  "commitlint.config.mjs",
  "commitlint.config.ts",
  "commitlint.config.cts",
  "commitlint.config.mts",
  ".commitlintrc",
  ".commitlintrc.json",
  ".commitlintrc.js",
  ".commitlintrc.cjs",
  ".commitlintrc.mjs",
  ".commitlintrc.ts",
  ".commitlintrc.cts",
  ".commitlintrc.mts",
  ".commitlintrc.yml",
  ".commitlintrc.yaml",
];

/**
 * Detects an existing commit-message convention this repo has already
 * committed to, so `init` doesn't overwrite someone else's decision by
 * default. Signals: a commitlint config file, a `commitlint` key inline in
 * package.json or package.yaml (cosmiconfig resolves both, and it's a
 * common pattern for small projects with no separate config file), or a
 * "commit message" heading in CONTRIBUTING.md. None is proof of an
 * incompatible convention, just enough to warrant asking for --force
 * rather than silently proceeding. package.yaml is checked with a plain
 * regex, not a real YAML parser, this project has no YAML dependency and
 * adding one just for a best-effort heuristic isn't worth it; a top-level
 * `commitlint:` key is enough of a signal either way.
 */
function detectExistingConvention(cwd: string): string | null {
  for (const name of COMMITLINT_CONFIG_NAMES) {
    if (existsSync(join(cwd, name))) return name;
  }
  const packageJsonPath = join(cwd, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const pkg: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      if (typeof pkg === "object" && pkg !== null && "commitlint" in pkg) {
        return "package.json (has a commitlint key)";
      }
    } catch {
      // Malformed package.json isn't this function's problem to report.
    }
  }
  const packageYamlPath = join(cwd, "package.yaml");
  if (existsSync(packageYamlPath)) {
    const text = readFileSync(packageYamlPath, "utf8");
    if (/^commitlint\s*:/m.test(text)) {
      return "package.yaml (has a commitlint key)";
    }
  }
  const contributingPath = join(cwd, "CONTRIBUTING.md");
  if (existsSync(contributingPath)) {
    const text = readFileSync(contributingPath, "utf8");
    if (/^#+.*commit\s*(message|convention)/im.test(text)) {
      return "CONTRIBUTING.md (has a commit message/convention section)";
    }
  }
  return null;
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function handleAgentsMd(cwd: string, options: InitOptions): InitResult["agentsMd"] {
  const path = join(cwd, "AGENTS.md");
  if (isSymlink(path)) {
    return { path, action: "symlink", detail: "AGENTS.md is a symlink; refusing to write through it to wherever it points, even with --force" };
  }
  const existing = readIfExists(path);

  if (existing === null) {
    if (!options.force) {
      const convention = detectExistingConvention(cwd);
      if (convention) {
        return { path, action: "skipped-existing-convention", detail: convention };
      }
    }
    writeFileAtomic(path, AGENTS_BLOCK);
    return { path, action: "created" };
  }

  const span = findBlockSpan(existing);
  if (!span) {
    if (!options.force) {
      return { path, action: "skipped-existing-convention", detail: "AGENTS.md already exists without an agent-commit block" };
    }
    const separator = existing.endsWith("\n") ? "\n" : "\n\n";
    writeFileAtomic(path, existing + separator + AGENTS_BLOCK);
    return { path, action: "appended" };
  }

  if (span.endIndex === null) {
    return {
      path,
      action: "ambiguous",
      detail: "found more or fewer than exactly one start marker and one end marker in this file (possibly one quoted in documentation alongside a real block); refusing to guess which is real rather than risk deleting or leaving behind the wrong content. Resolve by hand.",
    };
  }

  if (span.version === FORMAT_VERSION) {
    return { path, action: "unchanged", detail: `already at format version ${FORMAT_VERSION}` };
  }

  if (!options.update) {
    return {
      path,
      action: "stale",
      detail: `this repo has format version ${span.version}, current is ${FORMAT_VERSION}; rerun with --update to replace it`,
    };
  }

  const before = existing.slice(0, span.startIndex);
  const after = existing.slice(span.endIndex);
  writeFileAtomic(path, before + AGENTS_BLOCK + after);
  return { path, action: "updated", detail: `replaced format version ${span.version} with ${FORMAT_VERSION}` };
}

function handleClaudeMd(cwd: string, options: InitOptions): InitResult["claudeMd"] | undefined {
  if (options.noClaudeCode) return undefined;

  const path = join(cwd, "CLAUDE.md");
  if (isSymlink(path)) {
    return { path, action: "symlink", detail: "CLAUDE.md is a symlink; refusing to write through it to wherever it points" };
  }
  const existing = readIfExists(path);

  if (existing === null) {
    writeFileAtomic(path, "@AGENTS.md\n");
    return { path, action: "created" };
  }

  if (existing.includes("@AGENTS.md")) {
    return { path, action: "unchanged" };
  }

  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  writeFileAtomic(path, existing + separator + "@AGENTS.md\n");
  return { path, action: "updated" };
}

export function runInit(cwd: string, options: InitOptions = {}): InitResult {
  const agentsMd = handleAgentsMd(cwd, options);
  const claudeMd = handleClaudeMd(cwd, options);
  return claudeMd ? { agentsMd, claudeMd } : { agentsMd };
}

/** True if the result represents a state a script should treat as needing action (exit non-zero). */
export function needsAction(result: InitResult): boolean {
  return (
    result.agentsMd.action === "skipped-existing-convention" ||
    result.agentsMd.action === "stale" ||
    result.agentsMd.action === "ambiguous" ||
    result.agentsMd.action === "symlink" ||
    result.claudeMd?.action === "symlink"
  );
}

export function formatInitResult(result: InitResult): string {
  const lines: string[] = [];
  const a = result.agentsMd;
  switch (a.action) {
    case "created":
      lines.push(`created ${a.path}`);
      break;
    case "appended":
      lines.push(`appended the agent-commit block to ${a.path}`);
      break;
    case "updated":
      lines.push(`updated ${a.path} (${a.detail})`);
      break;
    case "unchanged":
      lines.push(`${a.path} is already up to date (${a.detail})`);
      break;
    case "stale":
      lines.push(`${a.path} is out of date: ${a.detail}`);
      break;
    case "ambiguous":
      lines.push(`${a.path}: ${a.detail}`);
      break;
    case "skipped-existing-convention":
      lines.push(`skipped ${a.path}: existing convention detected (${a.detail}). Rerun with --force to add the agent-commit block anyway.`);
      break;
    case "symlink":
      lines.push(`refused ${a.path}: ${a.detail}`);
      break;
    default: {
      // Exhaustiveness check: a missing case above is a compile error here,
      // not a silently empty summary line at runtime (how the "ambiguous"
      // case was first added without one).
      const _exhaustive: never = a.action;
      throw new Error(`unhandled AgentsMdAction: ${_exhaustive}`);
    }
  }
  if (result.claudeMd) {
    const c = result.claudeMd;
    switch (c.action) {
      case "created":
        lines.push(`created ${c.path} with an @AGENTS.md import`);
        break;
      case "updated":
        lines.push(`added an @AGENTS.md import to ${c.path}`);
        break;
      case "unchanged":
        lines.push(`${c.path} already imports @AGENTS.md`);
        break;
      case "symlink":
        lines.push(`refused ${c.path}: ${c.detail}`);
        break;
      default: {
        const _exhaustive: never = c.action;
        throw new Error(`unhandled ClaudeMdAction: ${_exhaustive}`);
      }
    }
  }
  return lines.join("\n");
}
