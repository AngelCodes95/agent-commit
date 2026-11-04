import { describe, expect, it } from "vitest";
import { checkRecords } from "../src/check.js";
import { record } from "./fixtures/record.js";

describe("checkRecords", () => {
  it("marks a commit with a valid object trailer as ok", () => {
    const [result] = checkRecords([record({ subject: "fix: x", context: { why: "y" } })]);
    expect(result).toEqual({ subject: "fix: x", status: "ok" });
  });

  it("marks a commit with valid-but-non-object JSON as miss, ok requires an object shape", () => {
    const [result] = checkRecords([record({ subject: "fix: odd", context: "just a string" })]);
    expect(result.status).toBe("miss");
  });

  it("marks a commit with no trailer at all as miss", () => {
    const [result] = checkRecords([record({ subject: "chore: bump", context: null })]);
    expect(result).toEqual({ subject: "chore: bump", status: "miss" });
  });

  it("marks a malformed trailer as miss, it's not usable even though something was written", () => {
    const [result] = checkRecords([record({ subject: "fix: broken", malformed: true })]);
    expect(result.status).toBe("miss");
  });

  it("marks an ambiguous (duplicate) trailer as miss, since nothing can be trusted as authoritative", () => {
    const [result] = checkRecords([record({ subject: "fix: dupes", ambiguous: true })]);
    expect(result.status).toBe("miss");
  });

  it("marks a misplaced trailer as its own distinct status, not miss and not ok", () => {
    const [result] = checkRecords([record({ subject: "fix: misplaced", misplaced: true })]);
    expect(result.status).toBe("misplaced");
  });

  it("misplaced takes precedence even if other fields happen to be set", () => {
    // Shouldn't occur in practice from parseLog (misplaced is only ever set when
    // context is null and nothing else is true), but the check logic itself
    // should still resolve deterministically if it ever did.
    const [result] = checkRecords([record({ subject: "fix: weird", misplaced: true, malformed: false })]);
    expect(result.status).toBe("misplaced");
  });

  it("preserves record order and count across a mixed batch", () => {
    const results = checkRecords([
      record({ subject: "a", context: { why: "1" } }),
      record({ subject: "b", context: null }),
      record({ subject: "c", malformed: true }),
      record({ subject: "d", misplaced: true }),
    ]);
    expect(results.map((r) => [r.subject, r.status])).toEqual([
      ["a", "ok"],
      ["b", "miss"],
      ["c", "miss"],
      ["d", "misplaced"],
    ]);
  });

  it("reports miss for a bare, non-object trailer value, matching query.ts's object-shape bar", () => {
    // Agent-Context: 42 is valid JSON per SPEC.md and correctly placed, but
    // check's "ok" requires an object shape, the same bar query.ts's
    // structured filters use (isAgentContextObject), so the two never
    // disagree about what's usable.
    const [result] = checkRecords([record({ subject: "fix: bare number", context: 42 })]);
    expect(result.status).toBe("miss");
  });
});
