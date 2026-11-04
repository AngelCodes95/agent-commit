import type { AgentCommitRecord } from "../../src/types.js";

/** Builds a synthetic AgentCommitRecord with neutral defaults, overriding only what a test cares about. */
export function record(overrides: Partial<AgentCommitRecord> = {}): AgentCommitRecord {
  return {
    subject: "subject",
    context: null,
    malformed: false,
    ambiguous: false,
    misplaced: false,
    ...overrides,
  };
}
