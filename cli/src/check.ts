import { isAgentContextObject } from "./types.js";
import type { AgentCommitRecord } from "./types.js";

export type CheckStatus = "ok" | "miss" | "misplaced";

export interface CheckResult {
  hash: string;
  shortHash: string;
  subject: string;
  status: CheckStatus;
}

/**
 * Read-only, advisory check: reports whether each record has a usable
 * trailer, and distinguishes two different reasons it might not:
 * "miss" (no Agent-Context line anywhere in the message, or one that
 * doesn't parse as an object) from "misplaced" (the line exists but sits
 * outside the position git recognizes as a trailer, so nothing was
 * extracted). Never writes anything, never modifies history. See
 * SPEC.md, "Squash merges: the merge commit must carry its own trailer"
 * for why this exists as a report rather than an enforcement mechanism.
 */
export function checkRecords(records: AgentCommitRecord[]): CheckResult[] {
  return records.map((record) => {
    const base = { hash: record.hash, shortHash: record.shortHash, subject: record.subject };
    if (record.misplaced) {
      return { ...base, status: "misplaced" };
    }
    // "ok" requires an object-shaped trailer, the same bar query.ts's
    // structured filters use (isAgentContextObject). SPEC.md allows any
    // valid JSON to parse without erroring, but every documented usage
    // (SPEC.md, the AGENTS.md block) writes an object; a bare
    // Agent-Context: 42 or "oops" is syntactically valid JSON but not a
    // usable trailer by any real definition, and reporting it as ok gave
    // a false green light query.ts could never act on. Malformed and
    // ambiguous trailers already fall through to miss below.
    const ok = isAgentContextObject(record.context) && !record.malformed && !record.ambiguous;
    return { ...base, status: ok ? "ok" : "miss" };
  });
}
