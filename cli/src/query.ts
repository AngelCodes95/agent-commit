import { isAgentContextObject } from "./types.js";
import type { AgentCommitRecord } from "./types.js";

export interface QueryOptions {
  /** Exact match against context.breaking. Absent breaking never matches true or false. */
  breaking?: boolean;
  /** Case-insensitive substring match against context.why. */
  grep?: string;
  /** Exact match against an entry in context.refs. */
  refs?: string;
}

function hasAnyFilter(options: QueryOptions): boolean {
  return options.breaking !== undefined || options.grep !== undefined || options.refs !== undefined;
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

    return true;
  });
}
