import { afterEach, describe, expect, it } from "vitest";
import { blame, formatBlamePretty, parseBlamePorcelain, parseLineRange } from "../src/blame.js";
import { GitCommandError } from "../src/parser.js";
import { record } from "./fixtures/record.js";
import { TempRepo } from "./fixtures/temp-repo.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const ZERO = "0".repeat(40);

describe("parseBlamePorcelain", () => {
  it("groups lines by commit, compresses them into ranges, and orders commits by first line", () => {
    // Shape copied from real `git blame --porcelain` output: a header per
    // line (with a group size only on a group's first line), metadata once
    // per commit, and tab-prefixed content.
    const raw = [
      `${B} 1 1 2`,
      "author t",
      "summary second",
      "filename f.txt",
      "\tline one",
      `${B} 2 2`,
      "\tline two",
      `${A} 3 3 1`,
      "author t",
      "summary first",
      "boundary",
      "filename f.txt",
      "\tline three",
      `${B} 5 4 1`,
      "\tline four",
    ].join("\n");
    expect(parseBlamePorcelain(raw)).toEqual({
      entries: [
        { hash: B, lines: [[1, 2], [4, 4]] },
        { hash: A, lines: [[3, 3]] },
      ],
      uncommittedLines: 0,
    });
  });

  it("counts uncommitted lines (the all-zero hash) instead of attributing them", () => {
    const raw = [`${A} 1 1 1`, "\tkept", `${ZERO} 2 2 2`, "\tnew", `${ZERO} 3 3`, "\tnew too"].join("\n");
    expect(parseBlamePorcelain(raw)).toEqual({ entries: [{ hash: A, lines: [[1, 1]] }], uncommittedLines: 2 });
  });

  it("never mistakes line content or metadata for a header, even when it looks like one", () => {
    const raw = [
      `${A} 1 1 1`,
      `summary ${B} 1 1`,
      `previous ${B} f.txt`,
      `\t${B} 9 9 9`,
    ].join("\n");
    expect(parseBlamePorcelain(raw).entries).toEqual([{ hash: A, lines: [[1, 1]] }]);
  });

  it("accepts SHA-256 object names", () => {
    const sha256 = "c".repeat(64);
    expect(parseBlamePorcelain(`${sha256} 1 1 1\n\tx`).entries).toEqual([{ hash: sha256, lines: [[1, 1]] }]);
  });
});

describe("parseLineRange", () => {
  it("accepts a single line or an inclusive start,end pair", () => {
    expect(parseLineRange("42")).toEqual([42, 42]);
    expect(parseLineRange("40,60")).toEqual([40, 60]);
    expect(parseLineRange("7,7")).toEqual([7, 7]);
  });

  it("rejects zero, reversed ranges, and git's non-numeric -L forms", () => {
    for (const bad of ["0", "5,2", "abc", "", "1,", ",5", "-3", "1,+5", "/regex/", ":funcname"]) {
      expect(parseLineRange(bad)).toBeUndefined();
    }
  });
});

describe("formatBlamePretty", () => {
  it("puts each commit's line ranges directly under its subject", () => {
    const out = formatBlamePretty([
      {
        ...record({ shortHash: "aaaaaaa", subject: "fix: a", context: { why: "because" } }),
        lines: [[1, 3], [7, 7]],
      },
      { ...record({ shortHash: "bbbbbbb", subject: "chore: b" }), lines: [[4, 4]] },
    ]);
    expect(out).toBe("aaaaaaa fix: a\n  lines: 1-3, 7\n  why: because\n\nbbbbbbb chore: b\n  lines: 4");
  });
});

describe("blame, against a real temp git repo", () => {
  let repo: TempRepo;
  afterEach(() => repo?.cleanup());

  function seed(): void {
    repo = new TempRepo();
    repo.commitFile("f.txt", "a\nb\nc\n", 'feat: first\n\nAgent-Context: {"why":"original reason"}');
    repo.commitFile("f.txt", "a\nB\nc\nd\n", 'fix: second\n\nAgent-Context: {"why":"second reason"}');
  }

  it("returns the commits behind the requested lines with their trailers and line ranges", () => {
    seed();
    const { records, uncommittedLines, warnings } = blame("f.txt", [2, 3], repo.dir);
    expect(records.map((r) => [r.subject, r.context, r.lines])).toEqual([
      ["fix: second", { why: "second reason" }, [[2, 2]]],
      ["feat: first", { why: "original reason" }, [[3, 3]]],
    ]);
    expect(records[0].hash).toMatch(/^[0-9a-f]{40}$/);
    expect(uncommittedLines).toBe(0);
    expect(warnings).toHaveLength(0);
  });

  it("blames the whole file when no range is given", () => {
    seed();
    const { records } = blame("f.txt", undefined, repo.dir);
    expect(records.map((r) => [r.subject, r.lines])).toEqual([
      ["feat: first", [[1, 1], [3, 3]]],
      ["fix: second", [[2, 2], [4, 4]]],
    ]);
  });

  it("counts working-tree changes as uncommitted rather than attributing them", () => {
    seed();
    repo.writeFile("f.txt", "a\nB\nc\nd\nnew\n");
    const { records, uncommittedLines } = blame("f.txt", [4, 5], repo.dir);
    expect(records.map((r) => r.subject)).toEqual(["fix: second"]);
    expect(uncommittedLines).toBe(1);
  });

  it("returns no records, without running git log, when every line is uncommitted", () => {
    seed();
    repo.writeFile("f.txt", "a\nB\nc\nd\nnew\n");
    expect(blame("f.txt", [5, 5], repo.dir)).toEqual({ records: [], uncommittedLines: 1, warnings: [] });
  });

  it("surfaces git's own error for a range past the end of the file or an unknown path", () => {
    seed();
    expect(() => blame("f.txt", [9, 9], repo.dir)).toThrow(GitCommandError);
    expect(() => blame("f.txt", [9, 9], repo.dir)).toThrow(/has only 4 lines/);
    expect(() => blame("missing.txt", undefined, repo.dir)).toThrow(/no such path/);
  });

  it("treats a path starting with - as a path, never as a git option", () => {
    repo = new TempRepo();
    repo.commitFile("-L", "x\n", "chore: oddly named file");
    expect(blame("-L", undefined, repo.dir).records.map((r) => r.subject)).toEqual(["chore: oddly named file"]);
  });
});
