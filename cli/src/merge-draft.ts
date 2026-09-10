import { sanitizeForTerminal } from "./format.js";
import { isAgentContextObject } from "./types.js";
import type { AgentCommitRecord } from "./types.js";

export interface MergeDraft {
  /** Deduped union of every commit's `touches` array in the range, ordered by first appearance in `git log`'s default (newest-first) order, not chronological or alphabetical. */
  touches: string[];
  /** Deduped union of every commit's `refs` array in the range, same ordering caveat as `touches`. */
  refs: string[];
  /** True if any commit in the range had `breaking: true`; undefined (omit) otherwise. */
  breaking: true | undefined;
  /**
   * Raw `why` values from each commit that had one, newest-first, matching
   * `git log`'s own default order, not chronological.
   * Deliberately not condensed into one sentence: that requires judgment
   * this deterministic tool doesn't have, per SPEC.md, "the branch's net
   * intent, not a concatenation." Whoever calls this (an agent with its
   * own reasoning, or a human) condenses these themselves.
   */
  whyCandidates: string[];
}

/**
 * Deterministically gathers raw material for a squash-merge's condensed
 * Agent-Context trailer from a source branch's per-commit trailers. Never
 * writes anything, never calls a model, never invents a `why`. See
 * SPEC.md, "Squash merges: the merge commit must carry its own trailer."
 */
export function buildMergeDraft(records: AgentCommitRecord[]): MergeDraft {
  const touches = new Set<string>();
  const refs = new Set<string>();
  let breaking = false;
  const whyCandidates: string[] = [];

  for (const record of records) {
    if (!isAgentContextObject(record.context)) continue;
    const ctx = record.context;

    if (Array.isArray(ctx.touches)) {
      for (const t of ctx.touches) {
        if (typeof t === "string") touches.add(t);
      }
    }
    if (Array.isArray(ctx.refs)) {
      for (const r of ctx.refs) {
        if (typeof r === "string") refs.add(r);
      }
    }
    if (ctx.breaking === true) breaking = true;
    if (typeof ctx.why === "string" && ctx.why.trim() !== "") {
      whyCandidates.push(ctx.why);
    }
  }

  return {
    touches: [...touches],
    refs: [...refs],
    breaking: breaking ? true : undefined,
    whyCandidates,
  };
}

/** Renders a MergeDraft as a human/agent-readable skeleton, not a finished trailer. */
export function formatMergeDraft(draft: MergeDraft): string {
  const skeleton: Record<string, unknown> = {
    why: "TODO: condense the candidates below into one sentence",
  };
  if (draft.touches.length > 0) skeleton.touches = draft.touches;
  if (draft.refs.length > 0) skeleton.refs = draft.refs;
  if (draft.breaking) skeleton.breaking = true;

  const lines = [
    "Draft Agent-Context for this merge. Review and condense before using; why is",
    "never synthesized automatically, only listed as candidates below.",
    "",
    `Agent-Context: ${JSON.stringify(skeleton)}`,
  ];

  if (draft.whyCandidates.length > 0) {
    lines.push("", "Per-commit why values to condense from:");
    for (const why of draft.whyCandidates) {
      lines.push(`- ${sanitizeForTerminal(why)}`);
    }
  } else {
    lines.push("", "(no per-commit why values found on this range)");
  }

  return lines.join("\n");
}
