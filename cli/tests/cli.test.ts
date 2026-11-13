import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { TempRepo } from "./fixtures/temp-repo.js";

// This file exists specifically because index.ts's argument parsing, exit
// codes, and output formatting were previously untested end to end: every
// other test calls the underlying functions (checkRecords, parseLog, etc.)
// directly, never the compiled CLI itself. A real column-alignment bug in
// the check command's output lived undetected in that gap; these tests
// cover the layer where it happened.

const cliDir = dirname(dirname(fileURLToPath(import.meta.url)));
const binPath = join(cliDir, "dist", "index.js");

beforeAll(() => {
  // Build fresh, don't trust a stale dist/ left over from a previous run.
  execFileSync("npm", ["run", "build"], { cwd: cliDir, encoding: "utf8" });
}, 30_000);

function runCli(args: string[], cwd: string) {
  const result = spawnSync("node", [binPath, ...args], { cwd, encoding: "utf8" });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe("agent-commit blame, against the compiled binary", () => {
  let repo: TempRepo;
  afterEach(() => repo?.cleanup());

  it("prints each commit's lines and trailer, and notes uncommitted lines on stderr only", () => {
    repo = new TempRepo();
    repo.commitFile("f.txt", "a\nb\n", 'feat: first\n\nAgent-Context: {"why":"the reason"}');
    repo.writeFile("f.txt", "a\nb\nnew\n");
    const { stdout, stderr, status } = runCli(["blame", "f.txt", "-L", "1,3"], repo.dir);
    expect(status).toBe(0);
    expect(stdout).toMatch(/^[0-9a-f]{7,} feat: first\n  lines: 1-2\n  why: the reason\n$/);
    expect(stderr).toContain("1 line(s) not committed yet");
  });

  it("emits records with a lines field under --json", () => {
    repo = new TempRepo();
    repo.commitFile("f.txt", "a\n", "chore: one");
    const { stdout, status } = runCli(["blame", "f.txt", "--json"], repo.dir);
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject([{ subject: "chore: one", lines: [[1, 1]] }]);
  });

  it("rejects a malformed -L before calling git, and reports git's own errors cleanly", () => {
    repo = new TempRepo();
    repo.commitFile("f.txt", "a\n", "chore: one");
    const bad = runCli(["blame", "f.txt", "-L", "5,2"], repo.dir);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("-L must be <start> or <start>,<end>");
    const missing = runCli(["blame", "nope.txt"], repo.dir);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/^agent-commit: fatal: no such path/);
    expect(missing.stdout).toBe("");
  });
});

describe("agent-commit log, against the compiled binary", () => {
  let repo: TempRepo;
  afterEach(() => repo?.cleanup());

  it("prints pretty output by default and exits 0", () => {
    repo = new TempRepo();
    repo.commit('fix: real one\n\nAgent-Context: {"why":"a real reason"}');
    const { stdout, status } = runCli(["log"], repo.dir);
    expect(status).toBe(0);
    expect(stdout).toMatch(/^[0-9a-f]{7,} fix: real one$/m);
    expect(stdout).toContain("why: a real reason");
  });

  it("emits valid, parseable JSON with --json", () => {
    repo = new TempRepo();
    repo.commit('fix: json one\n\nAgent-Context: {"why":"x"}');
    const { stdout, status } = runCli(["log", "--json"], repo.dir);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed[0].subject).toBe("fix: json one");
    expect(parsed[0].hash).toMatch(/^[0-9a-f]{40}$/);
    expect(parsed[0].context).toEqual({ why: "x" });
  });

  it("filters by --touches on path segments", () => {
    repo = new TempRepo();
    repo.commit('feat: auth\n\nAgent-Context: {"why":"a","touches":["src/auth/session.ts"]}');
    repo.commit('feat: authz\n\nAgent-Context: {"why":"b","touches":["src/authz"]}');
    const { stdout, status } = runCli(["log", "--touches", "src/auth", "--json"], repo.dir);
    expect(status).toBe(0);
    expect(JSON.parse(stdout).map((r: { subject: string }) => r.subject)).toEqual(["feat: auth"]);
  });

  it("routes parse warnings to stderr, never mixed into stdout's structured output", () => {
    repo = new TempRepo();
    repo.commit('fix: broken\n\nAgent-Context: {not valid json}');
    const { stdout, stderr } = runCli(["log", "--json"], repo.dir);
    expect(stderr).toContain("malformed-json");
    // stdout must still be valid JSON on its own, uncontaminated by the warning line.
    expect(() => JSON.parse(stdout)).not.toThrow();
  });
});

describe("agent-commit show, against the compiled binary", () => {
  let repo: TempRepo;
  afterEach(() => repo?.cleanup());

  it("shows the requested commit and exits 0", () => {
    repo = new TempRepo();
    repo.commit('fix: target\n\nAgent-Context: {"why":"y"}');
    const { stdout, status } = runCli(["show", "HEAD"], repo.dir);
    expect(status).toBe(0);
    expect(stdout).toContain("fix: target");
  });

  it("fails cleanly on a bad ref: single stderr message, exit 1, no raw stack trace", () => {
    repo = new TempRepo();
    repo.commit("chore: seed");
    const { stdout, stderr, status } = runCli(["show", "not-a-real-ref"], repo.dir);
    expect(status).toBe(1);
    expect(stderr).toContain("agent-commit:");
    expect(stderr).not.toContain("at Object"); // a raw Node stack trace frame
    expect(stdout).toBe("");
  });
});

describe("agent-commit check, against the compiled binary", () => {
  let repo: TempRepo;
  afterEach(() => repo?.cleanup());

  it("neutralizes a right-to-left override in a commit subject instead of applying it to the terminal", () => {
    const rlo = String.fromCodePoint(0x202e);
    repo = new TempRepo();
    repo.commit(`fix: safe ${rlo}not-safe`);
    const { stdout, status } = runCli(["check"], repo.dir);
    expect(status).toBe(1);
    expect(stdout).not.toContain(rlo);
    expect(stdout).toContain("<U+202e>");
  });

  it("prints aligned OK/MISS/MISPLACED labels and exits 1 when anything isn't OK", () => {
    repo = new TempRepo();
    repo.commit('fix: ok one\n\nAgent-Context: {"why":"fine"}');
    repo.commit("chore: no trailer");
    repo.commit(
      'fix: misplaced one\n\nAgent-Context: {"why":"lost"}\n\nCo-authored-by: a <a@example.com>',
    );

    const { stdout, status } = runCli(["check", "--count", "3"], repo.dir);
    const lines = stdout.trim().split("\n");

    expect(lines).toHaveLength(3);
    // The exact bug that shipped: MISPLACED landed one column right of
    // OK/MISS because they were hand-padded to different widths. Assert
    // the label field itself, not just that the words appear somewhere.
    const [misplacedLine, missLine, okLine] = lines;
    const labelOf = (line: string) => line.split(/\s{2,}/)[0];
    expect(labelOf(misplacedLine)).toBe("MISPLACED");
    expect(labelOf(missLine)).toBe("MISS");
    expect(labelOf(okLine)).toBe("OK");
    // The real definition of "aligned": the subject text itself must start
    // at the same column on every line. Comparing "index of the first
    // space" would NOT have caught the original bug, OK/MISS pad
    // internally at different points even when correctly padded to the
    // same total width; the subject's start column is what actually
    // shifted when MISPLACED was one character wider than its padding.
    const subjectColumn = (line: string, subject: string) => line.indexOf(subject);
    const columns = [
      subjectColumn(misplacedLine, "fix: misplaced one"),
      subjectColumn(missLine, "chore: no trailer"),
      subjectColumn(okLine, "fix: ok one"),
    ];
    expect(columns.every((c) => c >= 0)).toBe(true);
    expect(new Set(columns).size).toBe(1);

    expect(status).toBe(1);
  });

  it("exits 0 when every checked commit is OK", () => {
    repo = new TempRepo();
    repo.commit('fix: fine\n\nAgent-Context: {"why":"fine"}');
    const { status } = runCli(["check"], repo.dir);
    expect(status).toBe(0);
  });

  it("rejects --count 0 with a clear error instead of silently checking nothing and exiting 0", () => {
    repo = new TempRepo();
    repo.commit('fix: fine\n\nAgent-Context: {"why":"fine"}');
    const { stdout, stderr, status } = runCli(["check", "--count", "0"], repo.dir);
    expect(status).toBe(1);
    expect(stderr).toContain("--count must be a positive integer");
    expect(stdout).toBe("");
  });

  it("rejects a negative or non-numeric --count the same way", () => {
    repo = new TempRepo();
    repo.commit("chore: seed");
    for (const bad of ["-1", "abc"]) {
      const { status, stderr } = runCli(["check", "--count", bad], repo.dir);
      expect(status).toBe(1);
      expect(stderr).toContain("--count must be a positive integer");
    }
  });

  it("emits valid JSON with --json, matching CheckResult shape", () => {
    repo = new TempRepo();
    repo.commit('fix: fine\n\nAgent-Context: {"why":"fine"}');
    const { stdout, status } = runCli(["check", "--json"], repo.dir);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    const hash = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo.dir, encoding: "utf8" }).trim();
    const shortHash = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo.dir, encoding: "utf8" }).trim();
    expect(parsed).toEqual([{ hash, shortHash, subject: "fix: fine", status: "ok" }]);
  });

  it("prints the MISPLACED explanation to stderr only when something is actually misplaced", () => {
    repo = new TempRepo();
    repo.commit('fix: fine\n\nAgent-Context: {"why":"fine"}');
    const clean = runCli(["check"], repo.dir);
    expect(clean.stderr).not.toContain("MISPLACED means");

    repo.commit(
      'fix: misplaced\n\nAgent-Context: {"why":"lost"}\n\nCo-authored-by: a <a@example.com>',
    );
    const withMisplaced = runCli(["check", "--count", "2"], repo.dir);
    expect(withMisplaced.stderr).toContain("MISPLACED means");
  });

  it("--range takes precedence over --count when both would otherwise apply, and isolates the correct commit", () => {
    repo = new TempRepo();
    repo.commit("chore: base"); // gives the middle commit a parent, so `<sha>^` resolves
    repo.commit('fix: middle, ok\n\nAgent-Context: {"why":"middle"}');
    repo.commit("chore: newest, no trailer");
    const middleSha = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: repo.dir, encoding: "utf8" }).trim();

    const { stdout } = runCli(["check", "--range", `${middleSha}^..${middleSha}`, "--count", "5"], repo.dir);
    // The range isolates exactly the middle commit (OK), the --count value
    // must be ignored once --range is given, not silently combined.
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("fix: middle, ok");
  });
});

describe("agent-commit check, AGENTS.md block version note", () => {
  let repo: TempRepo;
  afterEach(() => repo?.cleanup());

  const block = (version: string) =>
    `<!-- agent-commit-format-version: ${version} -->\n\n## Commit messages\n\n<!-- /agent-commit-format-version -->\n`;

  it("notes an older block on stderr without changing the exit code or stdout", () => {
    repo = new TempRepo();
    repo.commit('fix: ok\n\nAgent-Context: {"why":"fine"}');
    const clean = runCli(["check"], repo.dir);
    repo.writeFile("AGENTS.md", block("0.1"));
    const { stdout, stderr, status } = runCli(["check"], repo.dir);
    expect(status).toBe(0);
    expect(stdout).toBe(clean.stdout);
    expect(stderr).toContain("format 0.1");
    expect(stderr).toContain("agent-commit init --update");
  });

  it("finds the block at the repository root when run from a subdirectory", () => {
    repo = new TempRepo();
    repo.commitFile("AGENTS.md", block("0.1"), 'docs: add block\n\nAgent-Context: {"why":"fine"}');
    execFileSync("mkdir", ["-p", join(repo.dir, "sub", "dir")]);
    const { stderr } = runCli(["check"], join(repo.dir, "sub", "dir"));
    expect(stderr).toContain("format 0.1");
  });

  it("says nothing about the block when it is current or absent", () => {
    repo = new TempRepo();
    repo.commit('fix: ok\n\nAgent-Context: {"why":"fine"}');
    expect(runCli(["check"], repo.dir).stderr).toBe("");
    runCli(["init", "--no-claude-code"], repo.dir);
    expect(runCli(["check"], repo.dir).stderr).toBe("");
  });

  it("neutralizes terminal escapes smuggled into the block's version marker", () => {
    repo = new TempRepo();
    repo.commit('fix: ok\n\nAgent-Context: {"why":"fine"}');
    const esc = String.fromCodePoint(0x1b);
    repo.writeFile("AGENTS.md", block(`0.1${esc}]0;pwned${String.fromCodePoint(0x07)}`));
    const { stderr } = runCli(["check"], repo.dir);
    expect(stderr).toContain("agent-commit: note:");
    expect(stderr).not.toContain(esc);
  });

  it("does not turn a failing check into a passing one or vice versa", () => {
    repo = new TempRepo();
    repo.commit("chore: no trailer");
    repo.writeFile("AGENTS.md", block("0.1"));
    const { stdout, stderr, status } = runCli(["check"], repo.dir);
    expect(status).toBe(1);
    expect(stdout).toContain("MISS");
    expect(stderr).toContain("format 0.1");
  });
});

describe("agent-commit merge-draft, against the compiled binary", () => {
  let repo: TempRepo;
  afterEach(() => repo?.cleanup());

  it("neutralizes a right-to-left override in a why candidate instead of applying it to the terminal", () => {
    const rlo = String.fromCodePoint(0x202e);
    repo = new TempRepo();
    repo.commit("chore: base");
    repo.commit(`feat: step one\n\nAgent-Context: {"why":"safe ${rlo}not-safe"}`);
    const { stdout, status } = runCli(["merge-draft", "HEAD~1..HEAD"], repo.dir);
    expect(status).toBe(0);
    expect(stdout).not.toContain(rlo);
    expect(stdout).toContain("<U+202e>");
  });

  it("unions a real branch range end to end and exits 0", () => {
    repo = new TempRepo();
    repo.commit("chore: base");
    repo.commit('feat: step one\n\nAgent-Context: {"why":"first","touches":["a"]}');
    repo.commit('feat: step two\n\nAgent-Context: {"why":"second","touches":["b"],"breaking":true}');

    const { stdout, status } = runCli(["merge-draft", "HEAD~2..HEAD"], repo.dir);
    expect(status).toBe(0);
    expect(stdout).toContain("first");
    expect(stdout).toContain("second");
    // Union order is newest-first, matching git log's default and the
    // documented whyCandidates order, not insertion/chronological order.
    expect(stdout).toContain('"touches":["b","a"]');
  });

  it("emits valid JSON matching MergeDraft shape with --json", () => {
    repo = new TempRepo();
    repo.commit("chore: base");
    repo.commit('feat: only\n\nAgent-Context: {"why":"x","refs":["T-1"]}');

    const { stdout, status } = runCli(["merge-draft", "HEAD~1..HEAD", "--json"], repo.dir);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.refs).toEqual(["T-1"]);
    expect(parsed.whyCandidates).toEqual(["x"]);
  });
});

describe("agent-commit outside a git repo, against the compiled binary", () => {
  it("fails cleanly with one message and exit 1, no stack trace", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-commit-cli-not-a-repo-"));
    try {
      const { stdout, stderr, status } = runCli(["log"], dir);
      expect(status).toBe(1);
      expect(stderr).toContain("not a git repository");
      expect(stderr).not.toContain("at Object");
      expect(stdout).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("agent-commit rejects option-like ref/range arguments, against the compiled binary", () => {
  // Regression tests for a real argument-injection finding: a ref/range value
  // starting with "-" used to reach git's argv unguarded, and git log accepts
  // --output=<path>, redirecting its formatted output to an arbitrary file
  // instead of stdout. execFileSync never goes through a shell, so this was
  // never shell injection, but git itself has no such protection. Each test
  // confirms both the clean rejection AND that no file actually gets written,
  // since a command that merely exits non-zero isn't proof the underlying
  // git call never ran (show's old behavior: it reported failure while the
  // file write had already silently succeeded).
  let repo: TempRepo;
  let pocPath: string;

  afterEach(() => {
    repo?.cleanup();
    if (pocPath && existsSync(pocPath)) rmSync(pocPath);
  });

  function pocFile(): string {
    pocPath = join(mkdtempSync(join(tmpdir(), "agent-commit-poc-")), "poc.txt");
    return pocPath;
  }

  it("show: rejects an --output=<path>-shaped ref instead of writing the file", () => {
    repo = new TempRepo();
    repo.commit("chore: seed");
    const poc = pocFile();
    const { stdout, stderr, status } = runCli(["show", "--", `--output=${poc}`], repo.dir);
    expect(status).toBe(1);
    expect(stderr).toContain("must not start with");
    expect(stdout).toBe("");
    expect(existsSync(poc)).toBe(false);
  });

  it("check --range: rejects an --output=<path>-shaped range instead of writing the file", () => {
    repo = new TempRepo();
    repo.commit("chore: seed");
    const poc = pocFile();
    const { stderr, status } = runCli(["check", `--range=--output=${poc}`], repo.dir);
    expect(status).toBe(1);
    expect(stderr).toContain("must not start with");
    expect(existsSync(poc)).toBe(false);
  });

  it("merge-draft: rejects an --output=<path>-shaped range instead of writing the file", () => {
    repo = new TempRepo();
    repo.commit("chore: seed");
    const poc = pocFile();
    const { stderr, status } = runCli(["merge-draft", "--", `--output=${poc}`], repo.dir);
    expect(status).toBe(1);
    expect(stderr).toContain("must not start with");
    expect(existsSync(poc)).toBe(false);
  });
});

describe("agent-commit init, against the compiled binary", () => {
  // init needs no git repo at all, so a plain temp dir is enough here;
  // runInit's own logic (convention detection, stale/--update, appending to
  // an unrelated AGENTS.md) is already covered directly in init.test.ts.
  // This block only checks that the CLI's flag wiring reaches runInit
  // correctly and that exit codes/output modes work end to end.
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates AGENTS.md and CLAUDE.md, exits 0", () => {
    dir = mkdtempSync(join(tmpdir(), "agent-commit-cli-init-"));
    const { stdout, status } = runCli(["init"], dir);
    expect(status).toBe(0);
    expect(stdout).toContain("created");
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
  });

  it("--no-claude-code skips CLAUDE.md", () => {
    dir = mkdtempSync(join(tmpdir(), "agent-commit-cli-init-"));
    const { status } = runCli(["init", "--no-claude-code"], dir);
    expect(status).toBe(0);
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
  });

  it("exits 1 and writes nothing when an existing convention is detected", () => {
    dir = mkdtempSync(join(tmpdir(), "agent-commit-cli-init-"));
    writeFileSync(join(dir, "commitlint.config.js"), "module.exports = {};");
    const { stderr, status } = runCli(["init"], dir);
    expect(status).toBe(1);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    expect(stderr).toBe("");
    // init's summary goes to stdout even on a "needs action" exit, matching
    // check's own convention of reporting on stdout and signaling via
    // exit code, not stderr, since this isn't an unexpected failure.
  });

  it("--force proceeds past a detected convention", () => {
    dir = mkdtempSync(join(tmpdir(), "agent-commit-cli-init-"));
    writeFileSync(join(dir, "commitlint.config.js"), "module.exports = {};");
    const { status } = runCli(["init", "--force"], dir);
    expect(status).toBe(0);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
  });

  it("an explicit [directory] argument targets that directory, not cwd", () => {
    dir = mkdtempSync(join(tmpdir(), "agent-commit-cli-init-"));
    const target = join(dir, "target");
    const cwd = join(dir, "cwd");
    execFileSync("mkdir", ["-p", target, cwd]);
    const { status } = runCli(["init", target], cwd);
    expect(status).toBe(0);
    expect(existsSync(join(target, "AGENTS.md"))).toBe(true);
    // Regression: init used to silently ignore an extra positional argument
    // and always write to cwd, with no error, which made a typo like this
    // easy to invoke and easy to miss.
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
  });

  it("fails cleanly, no stack trace, when the target directory doesn't exist", () => {
    dir = mkdtempSync(join(tmpdir(), "agent-commit-cli-init-"));
    const { stderr, stdout, status } = runCli(["init", join(dir, "does-not-exist")], dir);
    expect(status).toBe(1);
    expect(stderr).toContain("is not a directory");
    expect(stderr).not.toContain("at ");
    expect(stdout).toBe("");
  });

  it("--json emits parseable structured output", () => {
    dir = mkdtempSync(join(tmpdir(), "agent-commit-cli-init-"));
    const { stdout, status } = runCli(["init", "--json"], dir);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.agentsMd.action).toBe("created");
  });
});

describe("agent-commit --version, against the compiled binary", () => {
  it("prints the version from package.json, not a hardcoded string", () => {
    // Reads the same package.json index.ts reads at runtime, so this fails
    // if the two ever disagree, not just if --version stops working at all.
    const { version } = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8")) as {
      version: string;
    };
    const { stdout, status } = runCli(["--version"], cliDir);
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(version);
  });
});
