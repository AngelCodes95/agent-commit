/** An Agent-Context value once it's been confirmed to actually be a JSON object, not just any valid JSON. */
export type AgentContextValue = Record<string, unknown>;

export interface AgentCommitRecord {
  /** The commit's subject line. */
  subject: string;
  /**
   * Parsed Agent-Context JSON, or null if this commit has no trailer, is malformed, or is ambiguous.
   * Typed as `unknown`, not `AgentContextValue`: SPEC.md only requires "valid JSON", not an object
   * shape, so a trailer like `Agent-Context: "oops"` or `Agent-Context: 42` parses successfully here
   * and must be narrowed with `isAgentContextObject` before field access, not assumed to be a record.
   */
  context: unknown;
  /** True if a trailer was present but did not parse as valid JSON. */
  malformed: boolean;
  /** True if more than one Agent-Context trailer was found on this commit (SPEC.md: treat as ambiguous, not authoritative). */
  ambiguous: boolean;
  /**
   * True if an `Agent-Context:` line exists somewhere in the raw commit
   * message but git did not recognize it as a trailer, so nothing was
   * extracted. This is what happens when the line isn't in the same
   * contiguous final block as the message's other trailers, exactly what
   * GitHub's squash-merge prefill can silently produce (see SPEC.md,
   * "Squash merges"). Distinct from malformed: here the JSON may well be
   * perfectly valid, it's the position that broke, not the content.
   */
  misplaced: boolean;
}

/** Narrows a parsed Agent-Context value to a plain object, excluding arrays and primitives. */
export function isAgentContextObject(value: unknown): value is AgentContextValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ParseWarning {
  subject: string;
  reason: "malformed-json" | "ambiguous-trailer" | "misplaced-trailer";
}

export interface ParseResult {
  records: AgentCommitRecord[];
  warnings: ParseWarning[];
}
