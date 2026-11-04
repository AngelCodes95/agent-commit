import type { AgentCommitRecord } from "../../src/types.js";

/** A fixed, obviously fake hash for synthetic records. Tests that care about real hashes use TempRepo instead. */
export const FAKE_HASH = "0123456789abcdef0123456789abcdef01234567";
export const FAKE_SHORT_HASH = "0123456";

/** Builds a synthetic AgentCommitRecord with neutral defaults, overriding only what a test cares about. */
export function record(overrides: Partial<AgentCommitRecord> = {}): AgentCommitRecord {
  return {
    hash: FAKE_HASH,
    shortHash: FAKE_SHORT_HASH,
    subject: "subject",
    context: null,
    malformed: false,
    ambiguous: false,
    misplaced: false,
    ...overrides,
  };
}
