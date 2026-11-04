import { isAgentContextObject } from "./types.js";
import type { AgentCommitRecord } from "./types.js";

export interface QueryOptions {
  /** Exact match against context.breaking. Absent breaking never matches true or false. */
  breaking?: boolean;
  /** Case-insensitive substring match against context.why. */
  grep?: string;
  /** Exact match against an entry in context.refs. */
  refs?: string;
  /** Path match against context.touches, on whole path segments; see touchesPath. */
  touches?: string;
}

function hasAnyFilter(options: QueryOptions): boolean {
  return (
    options.breaking !== undefined ||
    options.grep !== undefined ||
    options.refs !== undefined ||
    options.touches !== undefined
  );
}

/**
 * Reduces a path to the canonical form SPEC.md asks `touches` to use
 * (repo-relative, no leading `./` or `/`), plus no trailing `/`, and
 * splits it into segments. Applied to both the query and each entry,
 * since an entry written slightly off-spec is still a real claim about
 * what the commit touched.
 */
function pathSegments(path: string): string[] {
  return path
    .trim()
    .replace(/^(\.\/|\/)+/, "")
    .split("/")
    .filter((segment) => segment !== "");
}

function isSegmentPrefix(prefix: string[], of: string[]): boolean {
  return prefix.length <= of.length && prefix.every((segment, i) => segment === of[i]);
}

/**
 * True if a `touches` entry and the queried path overlap, on whole path
 * segments, in either direction: an entry inside the queried path
 * (`src/auth/session.ts` for `src/auth`) and an entry containing it
 * (`src` for `src/auth/session.ts`, a commit claiming it touched the
 * broader area) both match. A partial segment never does: `src/au`
 * matches nothing under `src/auth`. Case-sensitive, like git paths.
 */
export function touchesPath(entry: string, query: string): boolean {
  const entrySegments = pathSegments(entry);
  const querySegments = pathSegments(query);
  if (entrySegments.length === 0 || querySegments.length === 0) return false;
  return isSegmentPrefix(entrySegments, querySegments) || isSegmentPrefix(querySegments, entrySegments);
}

/**
 * Filters records by the given options, AND semantics across whichever
 * options are set. Records with no trailer, a malformed trailer, an
 * ambiguous (duplicate) trailer, or a non-object trailer value never match
 * any filter, since none of those have usable fields to match against.
 * With no options set, returns every record unchanged, including the
 * ones above, filtering is opt-in.
 */
export function queryRecords(
  records: AgentCommitRecord[],
  options: QueryOptions = {},
): AgentCommitRecord[] {
  if (!hasAnyFilter(options)) {
    return records;
  }

  return records.filter((record) => {
    if (!isAgentContextObject(record.context)) return false;
    const ctx = record.context;

    if (options.breaking !== undefined && ctx.breaking !== options.breaking) {
      return false;
    }

    if (options.grep !== undefined) {
      if (typeof ctx.why !== "string") return false;
      if (!ctx.why.toLowerCase().includes(options.grep.toLowerCase())) return false;
    }

    if (options.refs !== undefined) {
      if (!Array.isArray(ctx.refs)) return false;
      if (!ctx.refs.includes(options.refs)) return false;
    }

    if (options.touches !== undefined) {
      const query = options.touches;
      if (!Array.isArray(ctx.touches)) return false;
      const matches = ctx.touches.some((entry) => typeof entry === "string" && touchesPath(entry, query));
      if (!matches) return false;
    }

    return true;
  });
}
