import { describe, expect, it } from "vitest";
import { formatJson, formatPretty, formatPrettyList, sanitizeForTerminal } from "../src/format.js";
import { FAKE_SHORT_HASH, record } from "./fixtures/record.js";

describe("formatPretty", () => {
  it("prints just the short hash and subject when there's no trailer", () => {
    const out = formatPretty(record({ subject: "chore: bump dependency" }));
    expect(out).toBe(`${FAKE_SHORT_HASH} chore: bump dependency`);
  });

  it("prints common fields in the documented order, not object insertion order", () => {
    // Deliberately inserted out of order (breaking, then why) to prove the
    // renderer imposes its own order rather than echoing insertion order.
    const out = formatPretty(
      record({
        subject: "fix: retry backoff",
        context: { breaking: false, why: "added exponential backoff" },
      }),
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe(`${FAKE_SHORT_HASH} fix: retry backoff`);
    expect(lines[1]).toBe("  why: added exponential backoff");
    expect(lines[2]).toBe("  breaking: false");
  });

  it("demotes type to an ordinary unrecognized field rather than giving it a priority slot, matching SPEC.md's 'deliberately not a field' stance", () => {
    const out = formatPretty(
      record({
        subject: "fix: retry backoff",
        context: { type: "fix", why: "added exponential backoff", breaking: false },
      }),
    );
    const lines = out.split("\n");
    // why/breaking still take the first two content lines, per the priority
    // order; type shows up, since nothing strips a key that's actually
    // present, just never first.
    expect(lines[1]).toBe("  why: added exponential backoff");
    expect(lines[2]).toBe("  breaking: false");
    expect(out).toContain("type: fix");
    expect(lines.indexOf("  type: fix")).toBeGreaterThan(2);
  });

  it("still prints an unrecognized field, since the format has no required schema", () => {
    const out = formatPretty(
      record({ subject: "feat: x", context: { totally_custom_field: "still shows up" } }),
    );
    expect(out).toContain("totally_custom_field: still shows up");
  });

  it("renders an array field as a comma-joined list", () => {
    const out = formatPretty(
      record({ subject: "fix: x", context: { refs: ["INFRA-441", "INFRA-500"] } }),
    );
    expect(out).toContain("refs: INFRA-441, INFRA-500");
  });

  it("marks a malformed trailer explicitly rather than showing nothing or crashing", () => {
    const out = formatPretty(record({ subject: "fix: broken", malformed: true, context: null }));
    expect(out).toContain("fix: broken");
    expect(out).toContain("malformed");
  });

  it("marks an ambiguous (duplicate-trailer) commit explicitly", () => {
    const out = formatPretty(record({ subject: "fix: dupes", ambiguous: true, context: null }));
    expect(out).toContain("ambiguous");
  });

  it("renders valid-but-non-object JSON (a bare string) without crashing or mislabeling it", () => {
    const out = formatPretty(record({ subject: "fix: odd", context: "just a string" }));
    expect(out).toBe(`${FAKE_SHORT_HASH} fix: odd\n  just a string`);
  });

  it("neutralizes a right-to-left override in a why value instead of applying it to the terminal", () => {
    // Reproduced directly: git places no restriction on trailer content, so
    // a commit with U+202E (RLO) in `why` rendered with the override
    // applied verbatim in a real terminal, visually scrambling the string,
    // the classic RLO-spoofing technique.
    const rlo = String.fromCodePoint(0x202e);
    const out = formatPretty(record({ subject: "fix: x", context: { why: `safe ${rlo}not-safe` } }));
    expect(out).not.toContain(rlo);
    expect(out).toContain("<U+202e>");
  });

  it("neutralizes a zero-width space rather than passing it through invisibly", () => {
    const zwsp = String.fromCodePoint(0x200b);
    const out = formatPretty(record({ subject: "fix: x", context: { why: `a${zwsp}b` } }));
    expect(out).not.toContain(zwsp);
    expect(out).toContain("<U+200b>");
  });

  it("neutralizes a raw ESC character, which could otherwise carry an ANSI/VT escape sequence", () => {
    const esc = String.fromCodePoint(0x1b);
    const out = formatPretty(record({ subject: "fix: x", context: { why: `a${esc}[31mb` } }));
    expect(out).not.toContain(esc);
    expect(out).toContain("<U+001b>");
  });

  it("neutralizes a dangerous subject line too, not just trailer values", () => {
    const rlo = String.fromCodePoint(0x202e);
    const out = formatPretty(record({ subject: `fix: safe ${rlo}not-safe` }));
    expect(out).not.toContain(rlo);
    expect(out).toContain("<U+202e>");
  });

  it("leaves ordinary text completely unchanged", () => {
    expect(sanitizeForTerminal("nothing dangerous here, just plain text 123")).toBe(
      "nothing dangerous here, just plain text 123",
    );
  });
});

// Known, accepted limitation, not a bug: a commit with no trailer at all and a
// commit whose trailer literally parses to JSON `null` are indistinguishable
// here, both produce context: null. Writing `Agent-Context: null` isn't a
// real use case (it satisfies no field this format defines), so no
// discriminator was added for it; noted rather than silently glossed over.

describe("formatPrettyList", () => {
  it("joins multiple records with a blank line between them", () => {
    const out = formatPrettyList([
      record({ shortHash: "aaaaaaa", subject: "first" }),
      record({ shortHash: "bbbbbbb", subject: "second", context: { why: "reason" } }),
    ]);
    expect(out).toBe("aaaaaaa first\n\nbbbbbbb second\n  why: reason");
  });

  it("returns an empty string for an empty list, not a stray separator", () => {
    expect(formatPrettyList([])).toBe("");
  });
});

describe("formatJson", () => {
  it("produces valid JSON that round-trips back to equivalent records", () => {
    const records = [
      record({ subject: "a", context: { why: "b" } }),
      record({ subject: "c", malformed: true }),
    ];
    const json = formatJson(records);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual(records);
  });

  it("does not crash on pathologically deep nesting, in either pretty or --json output", () => {
    // Reproduced directly: git places no limit on trailer content, so a
    // commit with deeply nested arrays in `why` crashed both output modes
    // with an uncaught RangeError and a raw stack trace, permanently
    // breaking log/show for the whole repo until that commit was rewritten
    // out of history. 500 levels here is already far past MAX_CONTEXT_DEPTH
    // (50) without needing tens of thousands to prove the point.
    let deep: unknown = "bottom";
    for (let i = 0; i < 500; i++) deep = [deep];
    const deepRecord = record({ subject: "test: deep", context: { why: deep } });

    expect(() => formatPretty(deepRecord)).not.toThrow();
    expect(formatPretty(deepRecord)).toContain("truncated: exceeds max nesting depth");

    expect(() => formatJson([deepRecord])).not.toThrow();
    const parsed = JSON.parse(formatJson([deepRecord]));
    expect(JSON.stringify(parsed)).toContain("truncated: exceeds max nesting depth");
  });
});
