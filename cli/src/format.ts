import { isAgentContextObject } from "./types.js";
import type { AgentCommitRecord } from "./types.js";

/**
 * Preferred display order for the fields SPEC.md documents; anything else
 * still prints, just after these. Deliberately excludes `type`: SPEC.md
 * says that's not a field this format uses (it belongs in the subject
 * line), so nothing here should imply otherwise by giving it a slot,
 * even a low-priority one. If a commit's trailer does contain a `type`
 * key anyway, it still renders, just alongside the other unrecognized
 * fields rather than first.
 */
const COMMON_FIELD_ORDER = ["why", "breaking", "touches", "refs"];

const MAX_CONTEXT_DEPTH = 50;

/**
 * Caps recursion depth when walking a parsed Agent-Context value, applied
 * before any display or serialization. Reproduced directly: git places no
 * limit on trailer content, so a commit with a sufficiently deeply nested
 * `why` array (tens of thousands of levels, trivial to construct) crashed
 * both pretty and --json output with an uncaught RangeError and a raw
 * stack trace, with no way to skip just that one commit, permanently
 * breaking `log`/`show` for the whole repo until it's rewritten out of
 * history. 50 levels is far beyond anything a real trailer would ever use;
 * this bounds every path that walks parsed JSON so none of them can ever
 * recurse past a fixed, safe depth, rather than reacting to a stack
 * overflow after the fact.
 */
function capDepth(value: unknown, depth = 0): unknown {
  if (depth >= MAX_CONTEXT_DEPTH) {
    return "[truncated: exceeds max nesting depth]";
  }
  if (Array.isArray(value)) {
    return value.map((v) => capDepth(v, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      result[key] = capDepth(v, depth + 1);
    }
    return result;
  }
  return value;
}

// Named by numeric code point, deliberately, not as a typed escape-sequence
// string or a literal invisible/bidi character sitting in this source file:
// either would be just as unverifiable by eye as the bytes this function
// exists to catch in commit content. C0 controls (including ESC, which can
// carry arbitrary ANSI/VT escape sequences to a terminal) and DEL, zero-width
// space/joiners/marks, invisible math operators and word joiner, bidi
// embedding/override, bidi isolates, and the BOM/zero-width no-break space.
const DANGEROUS_CODE_POINT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f], // C0 controls
  [0x7f, 0x7f], // DEL
  [0x200b, 0x200f], // zero-width space/joiners, LTR/RTL marks
  [0x2060, 0x2064], // word joiner, invisible math operators
  [0x202a, 0x202e], // bidi embedding/override
  [0x2066, 0x2069], // bidi isolates
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
];

function isDangerousCodePoint(codePoint: number): boolean {
  return DANGEROUS_CODE_POINT_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi);
}

/**
 * Replaces terminal-dangerous characters in attacker-influenceable commit
 * content (subjects, trailer values) with a visible, harmless numeric
 * escape before printing, rather than passing them through raw. Reproduced
 * directly: a trailer value containing the right-to-left override
 * character rendered with the override applied verbatim in a real
 * terminal, scrambling the displayed text. This only applies to pretty
 * output, meant for a terminal; --json output stays a faithful, unaltered
 * representation of the data, for machine consumption, not something
 * printed raw.
 */
export function sanitizeForTerminal(text: string): string {
  return Array.from(text)
    .map((ch) => {
      const codePoint = ch.codePointAt(0);
      if (codePoint === undefined || !isDangerousCodePoint(codePoint)) return ch;
      const hex = codePoint.toString(16).padStart(4, "0");
      return ["<U+", hex, ">"].join("");
    })
    .join("");
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => formatValue(v)).join(", ");
  if (value === null) return "null";
  if (typeof value === "object") return sanitizeForTerminal(JSON.stringify(value));
  return sanitizeForTerminal(String(value));
}

function formatContextFields(context: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const key of COMMON_FIELD_ORDER) {
    if (key in context) {
      lines.push(`  ${key}: ${formatValue(context[key])}`);
      seen.add(key);
    }
  }

  for (const key of Object.keys(context)) {
    if (!seen.has(key)) {
      lines.push(`  ${key}: ${formatValue(context[key])}`);
    }
  }

  return lines;
}

/**
 * Renders one record as human-readable text. Field order favors SPEC.md's
 * common fields but never drops an unrecognized key, the format has no
 * required schema, so the renderer can't assume one either.
 */
export function formatPretty(record: AgentCommitRecord): string {
  const lines = [sanitizeForTerminal(record.subject)];

  if (record.malformed) {
    lines.push("  (malformed Agent-Context trailer, could not parse as JSON)");
  } else if (record.ambiguous) {
    lines.push("  (ambiguous: more than one Agent-Context trailer found on this commit)");
  } else if (record.context === null) {
    // No trailer at all. Nothing further to show; per SPEC.md this is a
    // complete, honest commit on its own, not a lesser one.
  } else if (isAgentContextObject(record.context)) {
    lines.push(...formatContextFields(capDepth(record.context) as Record<string, unknown>));
  } else {
    // Valid JSON per SPEC.md, just not an object (a bare string/number/etc).
    lines.push(`  ${formatValue(capDepth(record.context))}`);
  }

  return lines.join("\n");
}

/** Renders a list of records as human-readable text, blank-line separated. */
export function formatPrettyList(records: AgentCommitRecord[]): string {
  return records.map(formatPretty).join("\n\n");
}

/**
 * Renders records as machine-readable JSON: the full record shape, nothing
 * summarized away, except that `context` is depth-capped the same way the
 * pretty printer is (see capDepth), so a pathologically nested trailer
 * can't crash --json output either.
 */
export function formatJson(records: AgentCommitRecord[]): string {
  const capped = records.map((record) => ({ ...record, context: capDepth(record.context) }));
  return JSON.stringify(capped, null, 2);
}
