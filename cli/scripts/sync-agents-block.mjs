#!/usr/bin/env node
// AGENTS.md, at the repo root, is the single source of truth for the block
// agents copy into a consuming project. README.md's copy and the CLI's own
// embedded template (cli/src/agentsBlock.ts, used by `agent-commit init`)
// are both generated from it here, rather than hand-duplicated, since a
// hand-duplicated copy is exactly the kind of drift agent-commit init's
// version marker exists to catch elsewhere.
//
// Run after editing AGENTS.md: node cli/scripts/sync-agents-block.mjs
// CI (or a pre-publish check) can run it with --check to fail if anyone
// edited README.md's copy or agentsBlock.ts by hand and let them drift.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..");
const agentsMdPath = join(repoRoot, "AGENTS.md");
const readmePath = join(repoRoot, "README.md");
const agentsBlockTsPath = join(scriptDir, "..", "src", "agentsBlock.ts");

const checkOnly = process.argv.includes("--check");

const canonical = readFileSync(agentsMdPath, "utf8").replace(/\n+$/, "\n");

const versionMatch = canonical.match(/^<!-- agent-commit-format-version: (\S+) -->/);
if (!versionMatch) {
  console.error("sync-agents-block: AGENTS.md is missing its <!-- agent-commit-format-version: X --> marker as the first line.");
  process.exit(1);
}
const formatVersion = versionMatch[1];

// --- README.md: replace the fenced ```markdown ... ``` block under
// "### The block to add to `AGENTS.md`" with the canonical text.
const readme = readFileSync(readmePath, "utf8");
const fenceRe = /(### The block to add to `AGENTS\.md`\n\n````markdown\n)([\s\S]*?)(\n````)/;
const readmeMatch = readme.match(fenceRe);
if (!readmeMatch) {
  console.error("sync-agents-block: could not find the fenced AGENTS.md block in README.md, markers may have moved.");
  process.exit(1);
}
// A replacer FUNCTION, not a replacement string: AGENTS.md's real content
// contains a literal backtick-dollar-backtick ("`$`", in the prose about
// shell expansion), and String.replace() interprets $-sequences specially
// in a *string* replacement argument regardless of where they came from,
// e.g. "$`" means "insert everything before the match". A function's
// return value is inserted literally, with no such reinterpretation.
const newReadme = readme.replace(fenceRe, (_match, before, _oldContent, after) => before + canonical.replace(/\n$/, "") + after);

// --- cli/src/agentsBlock.ts: a generated TS module. JSON.stringify handles
// all escaping correctly (backticks, quotes, backslashes all appear in the
// real block content), so this is a plain string literal, not a template
// literal, avoiding any manual escaping.
const generatedTs = `// GENERATED FILE. Do not edit by hand.
// Source of truth: AGENTS.md at the repo root.
// Regenerate with: node scripts/sync-agents-block.mjs

export const FORMAT_VERSION = ${JSON.stringify(formatVersion)};

export const AGENTS_BLOCK = ${JSON.stringify(canonical)};
`;

if (checkOnly) {
  const currentReadme = readFileSync(readmePath, "utf8");
  const currentTs = (() => {
    try {
      return readFileSync(agentsBlockTsPath, "utf8");
    } catch {
      return null;
    }
  })();
  const readmeDrifted = currentReadme !== newReadme;
  const tsDrifted = currentTs !== generatedTs;
  if (readmeDrifted || tsDrifted) {
    if (readmeDrifted) console.error("sync-agents-block --check: README.md's block has drifted from AGENTS.md.");
    if (tsDrifted) console.error("sync-agents-block --check: cli/src/agentsBlock.ts has drifted from AGENTS.md.");
    console.error("Run: node scripts/sync-agents-block.mjs");
    process.exit(1);
  }
  console.log("sync-agents-block --check: README.md and agentsBlock.ts both match AGENTS.md.");
  process.exit(0);
}

writeFileSync(readmePath, newReadme);
writeFileSync(agentsBlockTsPath, generatedTs);
console.log(`sync-agents-block: synced README.md and cli/src/agentsBlock.ts from AGENTS.md (format version ${formatVersion}).`);
