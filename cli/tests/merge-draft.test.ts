import { afterEach, describe, expect, it } from "vitest";
import { buildMergeDraft, formatMergeDraft } from "../src/merge-draft.js";
import { parseLog, runGitLog } from "../src/parser.js";
import type { AgentCommitRecord } from "../src/types.js";
import { TempRepo } from "./fixtures/temp-repo.js";

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

describe("buildMergeDraft", () => {
  it("unions touches and refs across commits, deduped", () => {
    const draft = buildMergeDraft([
      record({ context: { touches: ["src/cache"], refs: ["INFRA-441"] } }),
      record({ context: { touches: ["src/cache", "src/auth"], refs: ["INFRA-441", "INFRA-500"] } }),
    ]);
    expect(draft.touches.sort()).toEqual(["src/auth", "src/cache"]);
    expect(draft.refs.sort()).toEqual(["INFRA-441", "INFRA-500"]);
  });

  it("ORs breaking across commits: true if any commit was breaking", () => {
    const draft = buildMergeDraft([
      record({ context: { why: "a" } }),
      record({ context: { why: "b", breaking: true } }),
      record({ context: { why: "c" } }),
    ]);
    expect(draft.breaking).toBe(true);
  });

  it("omits breaking (undefined, not false) when nothing in the range was breaking", () => {
    const draft = buildMergeDraft([record({ context: { why: "a" } })]);
    expect(draft.breaking).toBeUndefined();
  });

  it("lists why values as raw candidates, in commit order, never condensed", () => {
    const draft = buildMergeDraft([
      record({ context: { why: "first reason" } }),
      record({ context: { why: "second reason" } }),
    ]);
    expect(draft.whyCandidates).toEqual(["first reason", "second reason"]);
  });

  it("skips commits with no usable trailer entirely, never crashes on them", () => {
    const draft = buildMergeDraft([
      record({ context: null }),
      record({ malformed: true }),
      record({ ambiguous: true }),
      record({ misplaced: true }),
      record({ context: "just a string" }), // valid JSON, not an object
      record({ context: { why: "the only real one" } }),
    ]);
    expect(draft.whyCandidates).toEqual(["the only real one"]);
    expect(draft.touches).toEqual([]);
  });

  it("ignores a non-string why and non-string entries inside touches/refs, rather than crashing or including garbage", () => {
    const draft = buildMergeDraft([
      record({ context: { why: 42, touches: ["ok", 7, null], refs: [true, "REAL-1"] } }),
    ]);
    expect(draft.whyCandidates).toEqual([]);
    expect(draft.touches).toEqual(["ok"]);
    expect(draft.refs).toEqual(["REAL-1"]);
  });

  it("ignores a blank-string why rather than listing an empty candidate", () => {
    const draft = buildMergeDraft([record({ context: { why: "   " } })]);
    expect(draft.whyCandidates).toEqual([]);
  });
});

describe("formatMergeDraft", () => {
  it("produces a valid Agent-Context trailer with the union already filled in, and a TODO for why", () => {
    const text = formatMergeDraft({
      touches: ["src/cache"],
      refs: ["INFRA-441"],
      breaking: true,
      whyCandidates: ["reason one", "reason two"],
    });
    const trailerLine = text.split("\n").find((l) => l.startsWith("Agent-Context:"));
    expect(trailerLine).toBeDefined();
    const json = JSON.parse(trailerLine!.slice("Agent-Context: ".length));
    expect(json.touches).toEqual(["src/cache"]);
    expect(json.refs).toEqual(["INFRA-441"]);
    expect(json.breaking).toBe(true);
    expect(typeof json.why).toBe("string");
    expect(text).toContain("reason one");
    expect(text).toContain("reason two");
  });

  it("omits touches/refs/breaking from the skeleton entirely when the union found none, not empty arrays or false", () => {
    const text = formatMergeDraft({ touches: [], refs: [], breaking: undefined, whyCandidates: [] });
    const trailerLine = text.split("\n").find((l) => l.startsWith("Agent-Context:"))!;
    const json = JSON.parse(trailerLine.slice("Agent-Context: ".length));
    expect(json).not.toHaveProperty("touches");
    expect(json).not.toHaveProperty("refs");
    expect(json).not.toHaveProperty("breaking");
    expect(text).toContain("no per-commit why values found");
  });
});

describe("buildMergeDraft, against a real temp git repo and a real revision range", () => {
  let repo: TempRepo;

  afterEach(() => {
    repo?.cleanup();
  });

  it("unions a real two-commit feature branch's trailers via base..head", () => {
    repo = new TempRepo();
    repo.commit("chore: base commit"); // no trailer, the merge base
    repo.commit(
      'feat: step one\n\nAgent-Context: {"why":"first step reason","touches":["src/a"]}',
    );
    repo.commit(
      'feat: step two\n\nAgent-Context: {"why":"second step reason","touches":["src/b"],"breaking":true}',
    );

    const raw = runGitLog(["HEAD~2..HEAD"], repo.dir);
    const { records } = parseLog(raw);
    const draft = buildMergeDraft(records);

    expect(draft.whyCandidates).toEqual(["second step reason", "first step reason"]);
    expect(draft.touches.sort()).toEqual(["src/a", "src/b"]);
    expect(draft.breaking).toBe(true);
  });
});
