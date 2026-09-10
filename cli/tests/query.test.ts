import { describe, expect, it } from "vitest";
import { queryRecords } from "../src/query.js";
import type { AgentCommitRecord } from "../src/types.js";

function record(overrides: Partial<AgentCommitRecord> = {}): AgentCommitRecord {
  return {
    subject: "subject",
    context: null,
    malformed: false,
    ambiguous: false,
    misplaced: false,
    ...overrides,
  };
}

// No `type` key anywhere here: SPEC.md is explicit that `type` isn't a
// field this format uses, so realistic fixtures shouldn't have one, and
// there's no --type filter to test against it (see query.ts and index.ts).
const fixtures: AgentCommitRecord[] = [
  record({
    subject: "fix: retry backoff",
    context: { why: "retries failed immediately, added backoff", breaking: false },
  }),
  record({
    subject: "feat: billing preview",
    context: { why: "proration preview requested by finance", refs: ["INFRA-441"] },
  }),
  record({
    subject: "refactor: drop LRU eviction",
    context: {
      why: "redis client lacked per-key timestamps for LRU",
      breaking: true,
      refs: ["INFRA-441", "INFRA-500"],
    },
  }),
  record({ subject: "chore: bump dependency", context: null }), // no trailer at all
  record({ subject: "fix: malformed trailer", context: null, malformed: true }),
  record({ subject: "fix: ambiguous trailer", context: null, ambiguous: true }),
  record({ subject: "fix: odd trailer", context: "just a string" }), // valid JSON, not an object
];

describe("queryRecords", () => {
  it("returns every record unchanged, including unusable ones, when no filters are set", () => {
    const result = queryRecords(fixtures, {});
    expect(result).toHaveLength(fixtures.length);
    expect(result).toEqual(fixtures);
    expect(result.map((r) => r.subject)).toContain("fix: ambiguous trailer");
    expect(result.map((r) => r.subject)).toContain("chore: bump dependency");
  });

  it("filters by breaking: true and excludes both absent and explicit-false breaking", () => {
    const result = queryRecords(fixtures, { breaking: true });
    expect(result.map((r) => r.subject)).toEqual(["refactor: drop LRU eviction"]);
  });

  it("filters by breaking: false and does not match records where breaking is simply absent", () => {
    // "feat: billing preview" has no breaking field at all; it must NOT count as false.
    const result = queryRecords(fixtures, { breaking: false });
    expect(result.map((r) => r.subject)).toEqual(["fix: retry backoff"]);
  });

  it("grep matches case-insensitively against why, and only against why", () => {
    const result = queryRecords(fixtures, { grep: "REDIS" });
    expect(result.map((r) => r.subject)).toEqual(["refactor: drop LRU eviction"]);
  });

  it("grep excludes records whose context has no string why field", () => {
    const result = queryRecords(fixtures, { grep: "anything" });
    expect(result).toHaveLength(0);
  });

  it("refs matches an exact entry inside the refs array", () => {
    const result = queryRecords(fixtures, { refs: "INFRA-500" });
    expect(result.map((r) => r.subject)).toEqual(["refactor: drop LRU eviction"]);
  });

  it("refs does not partial-match, INFRA-44 must not match INFRA-441", () => {
    const result = queryRecords(fixtures, { refs: "INFRA-44" });
    expect(result).toHaveLength(0);
  });

  it("combines multiple filters with AND semantics, not OR", () => {
    // breaking: true alone matches LRU eviction and nothing else; refs:
    // "INFRA-441" alone matches billing preview and LRU eviction. Together,
    // only the record satisfying both should survive.
    const result = queryRecords(fixtures, { breaking: true, refs: "INFRA-500" });
    expect(result.map((r) => r.subject)).toEqual(["refactor: drop LRU eviction"]);

    // A combination no single record satisfies must return nothing.
    const none = queryRecords(fixtures, { breaking: false, refs: "INFRA-441" });
    expect(none).toHaveLength(0);
  });

  it("never matches structured filters against a record whose context is valid JSON but not an object", () => {
    const result = queryRecords(fixtures, { grep: "" });
    expect(result.some((r) => r.subject === "fix: odd trailer")).toBe(false);
  });

  it("never matches structured filters against absent, malformed, or ambiguous trailers", () => {
    const result = queryRecords(fixtures, { refs: "NOTHING-MATCHES-THIS" });
    expect(result).toHaveLength(0);
    // Explicitly confirm none of the three unusable records ever appear for any filter.
    const anyFilterResult = queryRecords(fixtures, { grep: "" }); // empty grep matches any string why
    const subjects = anyFilterResult.map((r) => r.subject);
    expect(subjects).not.toContain("chore: bump dependency");
    expect(subjects).not.toContain("fix: malformed trailer");
    expect(subjects).not.toContain("fix: ambiguous trailer");
  });
});
