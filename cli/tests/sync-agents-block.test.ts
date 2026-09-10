import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Regression coverage for a real bug: sync-agents-block.mjs used to build
// its README.md replacement via `readme.replace(fenceRe, \`$1${canonical}$3\`)`.
// AGENTS.md's real content contains a literal "`$`" (in the prose about
// shell expansion), and String.replace() interprets "$`" in a *string*
// replacement argument as a special pattern ("insert everything before the
// match"), regardless of whether that text came from static source or
// interpolation. That silently spliced the entire preceding document back
// into the middle of the generated block. This test builds a minimal fixture
// containing the same "$`" shape and asserts the script's actual output,
// not a refactored unit, stays correct.

const cliDir = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = join(cliDir, "scripts", "sync-agents-block.mjs");

describe("sync-agents-block.mjs", () => {
  let repoRoot: string;
  afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

  function setupFixture(agentsMdContent: string) {
    repoRoot = mkdtempSync(join(tmpdir(), "agent-commit-sync-fixture-"));
    const fixtureCliDir = join(repoRoot, "cli");
    mkdirSync(join(fixtureCliDir, "scripts"), { recursive: true });
    mkdirSync(join(fixtureCliDir, "src"), { recursive: true });
    // The script locates repoRoot/README.md and repoRoot/AGENTS.md relative
    // to its own location (scriptDir/../..), so it has to actually live at
    // <repoRoot>/cli/scripts/sync-agents-block.mjs in the fixture, not just
    // be invoked from there.
    writeFileSync(join(fixtureCliDir, "scripts", "sync-agents-block.mjs"), readFileSync(scriptPath, "utf8"));
    writeFileSync(join(repoRoot, "AGENTS.md"), agentsMdContent);
    writeFileSync(
      join(repoRoot, "README.md"),
      "# Title\n\nSome intro prose before the block.\n\n" +
        "### The block to add to `AGENTS.md`\n\n" +
        "````markdown\nPLACEHOLDER\n````\n\n" +
        "Trailing content after the block.\n",
    );
    return { repoRoot, fixtureCliDir };
  }

  it("does not corrupt README.md when AGENTS.md contains a literal backtick-dollar-backtick", () => {
    const agentsMdContent =
      '<!-- agent-commit-format-version: 9.9 -->\n\n' +
      "## Commit messages\n\n" +
      "an unquoted one lets the shell expand `$` and backticks inside `why`, watch out.\n";
    const { fixtureCliDir } = setupFixture(agentsMdContent);

    execFileSync("node", [join(fixtureCliDir, "scripts", "sync-agents-block.mjs")], { encoding: "utf8" });

    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    // The specific failure mode: the intro prose duplicated a second time,
    // spliced into the middle of the fenced block.
    expect(readme.match(/Some intro prose before the block\./g)?.length ?? 0).toBe(1);
    expect(readme.match(/# Title/g)?.length ?? 0).toBe(1);
    expect(readme).toContain("an unquoted one lets the shell expand `$` and backticks inside `why`, watch out.");
    expect(readme).toContain("Trailing content after the block.");
    // The surrounding fence markers and non-block content must survive untouched.
    expect(readme.startsWith("# Title\n\nSome intro prose before the block.\n\n### The block to add")).toBe(true);
  });

  it("also handles other regex-special replacement sequences ($&, $$, $', $9) without corruption", () => {
    const agentsMdContent =
      '<!-- agent-commit-format-version: 1.0 -->\n\n' +
      "## Commit messages\n\n" +
      "Edge cases: $&, $$, $', $9, $`, and a lone $ at the end: $\n";
    const { fixtureCliDir } = setupFixture(agentsMdContent);

    execFileSync("node", [join(fixtureCliDir, "scripts", "sync-agents-block.mjs")], { encoding: "utf8" });

    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    expect(readme).toContain("Edge cases: $&, $$, $', $9, $`, and a lone $ at the end: $");
    expect(readme).toContain("Trailing content after the block.");
    expect(readme.match(/# Title/g)?.length ?? 0).toBe(1);
  });

  it("--check exits 0 and reports clean right after a real sync, and exits 1 if the block is then hand-edited", () => {
    const agentsMdContent = "<!-- agent-commit-format-version: 1.0 -->\n\n## Commit messages\nhello\n";
    const { fixtureCliDir } = setupFixture(agentsMdContent);
    const scriptFixturePath = join(fixtureCliDir, "scripts", "sync-agents-block.mjs");

    execFileSync("node", [scriptFixturePath], { encoding: "utf8" });
    const clean = execFileSync("node", [scriptFixturePath, "--check"], { encoding: "utf8" });
    expect(clean).toContain("both match AGENTS.md");

    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    writeFileSync(join(repoRoot, "README.md"), readme.replace("hello", "hand-edited, now drifted"));

    expect(() => execFileSync("node", [scriptFixturePath, "--check"], { encoding: "utf8", stdio: "pipe" })).toThrow();
  });
});
