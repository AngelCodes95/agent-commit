import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FORMAT_VERSION } from "../src/agentsBlock.js";
import { formatInitResult, needsAction, runInit } from "../src/init.js";

describe("runInit", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-commit-init-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates AGENTS.md and CLAUDE.md in an empty directory", () => {
    const result = runInit(dir);
    expect(result.agentsMd.action).toBe("created");
    expect(result.claudeMd?.action).toBe("created");
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain(
      `<!-- agent-commit-format-version: ${FORMAT_VERSION} -->`,
    );
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toContain("@AGENTS.md");
    expect(needsAction(result)).toBe(false);
  });

  it("skips CLAUDE.md when --no-claude-code is set (noClaudeCode: true)", () => {
    const result = runInit(dir, { noClaudeCode: true });
    expect(result.claudeMd).toBeUndefined();
  });

  it("running init twice reports unchanged the second time, no duplicate writes", () => {
    runInit(dir);
    const before = readFileSync(join(dir, "AGENTS.md"), "utf8");
    const result = runInit(dir);
    expect(result.agentsMd.action).toBe("unchanged");
    expect(result.claudeMd?.action).toBe("unchanged");
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe(before);
  });

  it("skips a fresh AGENTS.md write when a commitlint config is present, without --force", () => {
    writeFileSync(join(dir, "commitlint.config.js"), "module.exports = {};");
    const result = runInit(dir, { noClaudeCode: true });
    expect(result.agentsMd.action).toBe("skipped-existing-convention");
    expect(result.agentsMd.detail).toBe("commitlint.config.js");
    expect(needsAction(result)).toBe(true);
  });

  it("skips when CONTRIBUTING.md has its own commit message section, without --force", () => {
    writeFileSync(join(dir, "CONTRIBUTING.md"), "# Contributing\n\n## Commit Message Format\n\nUse Conventional Commits.\n");
    const result = runInit(dir, { noClaudeCode: true });
    expect(result.agentsMd.action).toBe("skipped-existing-convention");
  });

  it("--force adds the block even with a detected convention present", () => {
    writeFileSync(join(dir, "commitlint.config.js"), "module.exports = {};");
    const result = runInit(dir, { force: true, noClaudeCode: true });
    expect(result.agentsMd.action).toBe("created");
  });

  it("skips an AGENTS.md that already exists without our marker, without --force", () => {
    writeFileSync(join(dir, "AGENTS.md"), "# Unrelated project instructions\n");
    const result = runInit(dir, { noClaudeCode: true });
    expect(result.agentsMd.action).toBe("skipped-existing-convention");
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe("# Unrelated project instructions\n");
  });

  it("--force appends the block to an existing unrelated AGENTS.md, preserving its content", () => {
    writeFileSync(join(dir, "AGENTS.md"), "# Unrelated project instructions\n");
    const result = runInit(dir, { force: true, noClaudeCode: true });
    expect(result.agentsMd.action).toBe("appended");
    const content = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(content).toContain("# Unrelated project instructions");
    expect(content).toContain(`<!-- agent-commit-format-version: ${FORMAT_VERSION} -->`);
  });

  it("reports stale, and does not touch the file, when the marker version is older and --update isn't passed", () => {
    writeFileSync(
      join(dir, "AGENTS.md"),
      "<!-- agent-commit-format-version: 0.0 -->\n\n## Commit messages\nold\n\n<!-- /agent-commit-format-version -->\n",
    );
    const result = runInit(dir, { noClaudeCode: true });
    expect(result.agentsMd.action).toBe("stale");
    expect(needsAction(result)).toBe(true);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("format-version: 0.0");
  });

  it("--update replaces a stale block with the current one, preserving content before AND after it", () => {
    writeFileSync(
      join(dir, "AGENTS.md"),
      "# Keep this part\n\n<!-- agent-commit-format-version: 0.0 -->\n\n## Commit messages\nold\n\n" +
        "<!-- /agent-commit-format-version -->\n\n## Team notes\n\nKeep this part too.\n",
    );
    const result = runInit(dir, { update: true, noClaudeCode: true });
    expect(result.agentsMd.action).toBe("updated");
    const content = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(content).toContain("# Keep this part");
    expect(content).toContain(`<!-- agent-commit-format-version: ${FORMAT_VERSION} -->`);
    expect(content).not.toContain("format-version: 0.0");
    // Regression: an earlier version replaced everything from the marker to
    // the end of the file, silently deleting real content a human had added
    // after the block (team notes, other sections). Reproduced as actual
    // data loss before this fix; must survive now.
    expect(content).toContain("## Team notes");
    expect(content).toContain("Keep this part too.");
  });

  it("reports ambiguous, and does not touch the file, when a start marker has no matching end marker", () => {
    // What a documentation example that quotes the marker alone on its own
    // line (a plausible, non-adversarial thing to do) looks like, followed
    // by real content. There's no way to tell this apart from a genuinely
    // malformed block by regex alone, so the safe behavior is to refuse,
    // not guess where the block ends.
    writeFileSync(
      join(dir, "AGENTS.md"),
      "# Docs\n\nExample:\n\n```\n<!-- agent-commit-format-version: 0.0 -->\n```\n\n## Real section\n\nMust survive.\n",
    );
    const result = runInit(dir, { update: true, noClaudeCode: true });
    expect(result.agentsMd.action).toBe("ambiguous");
    expect(needsAction(result)).toBe(true);
    const content = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(content).toContain("## Real section");
    expect(content).toContain("Must survive.");
  });

  it("reports ambiguous, and preserves everything, when a doc-quoted end marker appears before the real one", () => {
    // A second reviewer found this: findBlockSpan used to trust the FIRST
    // end-marker match, so a fenced doc example quoting the end marker
    // between the real start and real end markers made it pick the wrong
    // one, leaving orphaned garbage (an unbalanced fence, stale leftover
    // text, a duplicate end-marker line) in the "successfully updated" file.
    writeFileSync(
      join(dir, "AGENTS.md"),
      "<!-- agent-commit-format-version: 0.1 -->\n## Commit messages\nreal content\nExample: ```\n" +
        "<!-- /agent-commit-format-version -->\n```\nmore real content\n<!-- /agent-commit-format-version -->\n\nTeam notes after.\n",
    );
    const before = readFileSync(join(dir, "AGENTS.md"), "utf8");
    const result = runInit(dir, { update: true, noClaudeCode: true });
    expect(result.agentsMd.action).toBe("ambiguous");
    expect(needsAction(result)).toBe(true);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe(before);
  });

  it("reports ambiguous, and preserves everything, when a doc-quoted start marker appears before the real block", () => {
    // Same finding, the other direction: a doc-quoted START marker earlier
    // in the file made findBlockSpan anchor there instead of the real
    // block, silently deleting genuine prose between the quoted example
    // and the real end marker.
    writeFileSync(
      join(dir, "AGENTS.md"),
      "# Docs\nHere's an example of the marker: ```\n<!-- agent-commit-format-version: X -->\n```\n" +
        "That's just documentation, not a real block.\n\n<!-- agent-commit-format-version: 0.1 -->\n" +
        "## Commit messages\nreal actual block content\n<!-- /agent-commit-format-version -->\n\nTeam notes after (must survive).\n",
    );
    const before = readFileSync(join(dir, "AGENTS.md"), "utf8");
    const result = runInit(dir, { update: true, noClaudeCode: true });
    expect(result.agentsMd.action).toBe("ambiguous");
    expect(needsAction(result)).toBe(true);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe(before);
  });

  it("detects an inline commitlint key in package.json as an existing convention", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", commitlint: { extends: ["@commitlint/config-conventional"] } }));
    const result = runInit(dir, { noClaudeCode: true });
    expect(result.agentsMd.action).toBe("skipped-existing-convention");
    expect(result.agentsMd.detail).toBe("package.json (has a commitlint key)");
  });

  it("detects an inline commitlint key in package.yaml as an existing convention", () => {
    writeFileSync(join(dir, "package.yaml"), "name: x\ncommitlint:\n  extends: ['@commitlint/config-conventional']\n");
    const result = runInit(dir, { noClaudeCode: true });
    expect(result.agentsMd.action).toBe("skipped-existing-convention");
    expect(result.agentsMd.detail).toBe("package.yaml (has a commitlint key)");
  });

  it("does not false-positive on a package.json with no commitlint key", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    const result = runInit(dir, { noClaudeCode: true });
    expect(result.agentsMd.action).toBe("created");
  });

  it("does not crash on a malformed package.json, just doesn't treat it as a signal", () => {
    writeFileSync(join(dir, "package.json"), "{ not valid json");
    const result = runInit(dir, { noClaudeCode: true });
    expect(result.agentsMd.action).toBe("created");
  });

  it("creates CLAUDE.md with the import when missing", () => {
    const result = runInit(dir);
    expect(result.claudeMd).toEqual({ path: join(dir, "CLAUDE.md"), action: "created" });
  });

  it("appends the import to an existing CLAUDE.md that doesn't already have it", () => {
    writeFileSync(join(dir, "CLAUDE.md"), "# My personal Claude instructions\n");
    const result = runInit(dir);
    expect(result.claudeMd?.action).toBe("updated");
    const content = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(content).toContain("# My personal Claude instructions");
    expect(content).toContain("@AGENTS.md");
  });

  it("leaves an existing CLAUDE.md alone if it already imports @AGENTS.md", () => {
    writeFileSync(join(dir, "CLAUDE.md"), "@AGENTS.md\n");
    const result = runInit(dir);
    expect(result.claudeMd?.action).toBe("unchanged");
  });

  it("refuses to write through a symlinked AGENTS.md, even with --force, and doesn't touch the link target", () => {
    // Reproduced directly by an adversarial review: without this check,
    // `init --force` in a directory whose AGENTS.md is a symlink wrote
    // straight through it into whatever the link pointed at, including a
    // file entirely outside the target directory.
    const outsideDir = mkdtempSync(join(tmpdir(), "agent-commit-outside-"));
    const target = join(outsideDir, "sensitive.txt");
    writeFileSync(target, "sensitive content\n");
    symlinkSync(target, join(dir, "AGENTS.md"));

    const result = runInit(dir, { force: true, noClaudeCode: true });
    expect(result.agentsMd.action).toBe("symlink");
    expect(needsAction(result)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("sensitive content\n");
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("refuses to write through a symlinked CLAUDE.md and doesn't touch the link target", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "agent-commit-outside-"));
    const target = join(outsideDir, "sensitive.txt");
    writeFileSync(target, "sensitive content\n");
    symlinkSync(target, join(dir, "CLAUDE.md"));

    const result = runInit(dir);
    expect(result.claudeMd?.action).toBe("symlink");
    expect(needsAction(result)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("sensitive content\n");
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("never leaves a stray .tmp- file behind after a normal write", () => {
    runInit(dir);
    const leftovers = readdirSync(dir).filter((name) => name.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
});

describe("formatInitResult", () => {
  it("renders a readable summary for a created AGENTS.md and CLAUDE.md", () => {
    const text = formatInitResult({
      agentsMd: { path: "/x/AGENTS.md", action: "created" },
      claudeMd: { path: "/x/CLAUDE.md", action: "created" },
    });
    expect(text).toContain("created /x/AGENTS.md");
    expect(text).toContain("created /x/CLAUDE.md");
  });

  it("renders the skip reason when an existing convention was detected", () => {
    const text = formatInitResult({
      agentsMd: { path: "/x/AGENTS.md", action: "skipped-existing-convention", detail: "commitlint.config.js" },
    });
    expect(text).toContain("commitlint.config.js");
    expect(text).toContain("--force");
  });

  it("renders a non-empty message for the ambiguous action, not a silent blank line", () => {
    // Regression: this case was first added to the AgentsMdAction union and
    // to needsAction() without a matching switch case here, so the CLI
    // exited 1 with no explanation at all. The switch now has an
    // exhaustiveness check so a future missing case is a compile error.
    const text = formatInitResult({
      agentsMd: { path: "/x/AGENTS.md", action: "ambiguous", detail: "found a marker but not its end marker" },
    });
    expect(text.trim()).not.toBe("");
    expect(text).toContain("found a marker but not its end marker");
  });
});
