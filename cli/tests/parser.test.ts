import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkGitVersion,
  FIELD_SEP,
  GitCommandError,
  LOG_FORMAT,
  NotAGitRepositoryError,
  parseLog,
  runGitLog,
  SENTINEL,
} from "../src/parser.js";
import { isAgentContextObject } from "../src/types.js";
import { TempRepo } from "./fixtures/temp-repo.js";

/** Builds a synthetic raw log record matching LOG_FORMAT's two NUL-delimited fields, for one commit. Subject is always the raw body's first line, matching how parseLog derives it, so tests don't pass it separately. */
function chunk(trailerSection: string, rawBody: string): string {
  return trailerSection + FIELD_SEP + rawBody + SENTINEL;
}

describe("parseLog", () => {
  it("returns context: null for a commit with no trailer", () => {
    const raw = chunk("", "chore: no trailer");
    const { records, warnings } = parseLog(raw);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      subject: "chore: no trailer",
      context: null,
      malformed: false,
      ambiguous: false,
      misplaced: false,
    });
    expect(warnings).toHaveLength(0);
  });

  it("parses a single valid trailer", () => {
    const raw = chunk(
      '{"why":"backoff was missing"}',
      'fix: retry logic\n\nAgent-Context: {"why":"backoff was missing"}',
    );
    const { records, warnings } = parseLog(raw);
    expect(records).toHaveLength(1);
    expect(records[0].subject).toBe("fix: retry logic");
    expect(records[0].context).toEqual({ why: "backoff was missing" });
    expect(records[0].malformed).toBe(false);
    expect(records[0].misplaced).toBe(false);
    expect(warnings).toHaveLength(0);
  });

  it("flags malformed JSON as malformed, not a crash, and warns", () => {
    const raw = chunk(
      "{\"why\": not valid json}",
      'fix: broken trailer\n\nAgent-Context: {"why": not valid json}',
    );
    const { records, warnings } = parseLog(raw);
    expect(records).toHaveLength(1);
    expect(records[0].context).toBeNull();
    expect(records[0].malformed).toBe(true);
    expect(records[0].misplaced).toBe(false);
    expect(warnings).toEqual([{ subject: "fix: broken trailer", reason: "malformed-json" }]);
  });

  it("flags duplicate Agent-Context trailers as ambiguous rather than picking one", () => {
    const raw = chunk(
      '{"why":"first"}\n{"why":"second"}',
      'fix: two trailers\n\nAgent-Context: {"why":"first"}\nAgent-Context: {"why":"second"}',
    );
    const { records, warnings } = parseLog(raw);
    expect(records).toHaveLength(1);
    expect(records[0].context).toBeNull();
    expect(records[0].ambiguous).toBe(true);
    expect(records[0].misplaced).toBe(false);
    expect(warnings).toEqual([{ subject: "fix: two trailers", reason: "ambiguous-trailer" }]);
  });

  it("flags a trailer that's present in the body but not recognized as a trailer as misplaced", () => {
    // Mirrors what GitHub's squash-merge prefill actually produces: the trailer
    // extraction is empty (git didn't recognize it, a blank line separates it
    // from the message's real trailer block), but the raw body still contains
    // the Agent-Context line, verbatim.
    const raw = chunk(
      "",
      'fix: github prefill shape\n\nAgent-Context: {"why":"this looks right but isn\'t"}\n\nCo-authored-by: someone <someone@example.com>',
    );
    const { records, warnings } = parseLog(raw);
    expect(records).toHaveLength(1);
    expect(records[0].context).toBeNull();
    expect(records[0].malformed).toBe(false);
    expect(records[0].ambiguous).toBe(false);
    expect(records[0].misplaced).toBe(true);
    expect(warnings).toEqual([{ subject: "fix: github prefill shape", reason: "misplaced-trailer" }]);
  });

  it("does not flag misplaced when there's genuinely no Agent-Context text anywhere in the body", () => {
    const raw = chunk("", "chore: bump a dependency");
    const { records, warnings } = parseLog(raw);
    expect(records[0].misplaced).toBe(false);
    expect(warnings).toHaveLength(0);
  });

  it("does not flag a prose mention of the token as misplaced when nothing JSON-shaped follows the colon", () => {
    // A commit whose body just talks about the convention ("write the
    // Agent-Context: trailer at the very end") must not be mistaken for an
    // actual attempt at one. This is the exact improvement the
    // colon-then-JSON-shape requirement was added for.
    const raw = chunk(
      "",
      "docs: onboarding note\n\nWrite the Agent-Context: trailer at the very end, once you know the format.",
    );
    const { records, warnings } = parseLog(raw);
    expect(records[0].misplaced).toBe(false);
    expect(warnings).toHaveLength(0);
  });

  it("detects a misplaced trailer with optional whitespace before the colon, matching git's own tolerance", () => {
    // Verified against real git: `Agent-Context : {...}` (space before the
    // colon) is extracted as a trailer just as readily as no space. If this
    // shape is ever misplaced, the detector must still catch it.
    const raw = chunk(
      "",
      'fix: spaced colon\n\nAgent-Context : {"why":"lost"}\n\nCo-authored-by: a <a@example.com>',
    );
    const { records, warnings } = parseLog(raw);
    expect(records[0].misplaced).toBe(true);
    expect(warnings[0].reason).toBe("misplaced-trailer");
  });

  it("does not split one commit into two records when its body happens to contain the literal separator text used before this fix", () => {
    // Regression test for a real bug: SENTINEL and FIELD_SEP used to be
    // printable strings ("---AGENT-COMMIT---" / "~~~AGENT-COMMIT-FIELD~~~"),
    // so a commit body that happened to quote either string, for example
    // this project's own docs describing the format, silently split into
    // phantom records. NUL bytes can't appear in a commit body at all, so
    // this synthetic test can't reproduce the old failure mode directly
    // (that requires the real git round-trip test below); this one instead
    // pins that ordinary body text resembling old delimiter strings is
    // inert now.
    const raw = chunk(
      "",
      "docs: explain the format\n\nThe old sentinel was literally the text ---AGENT-COMMIT--- and the\nold field separator was ~~~AGENT-COMMIT-FIELD~~~, both plain strings.",
    );
    const { records } = parseLog(raw);
    expect(records).toHaveLength(1);
    expect(records[0].subject).toBe("docs: explain the format");
  });

  it("parses multiple commits in one log output, mixed absent/present/malformed/ambiguous/misplaced", () => {
    const raw =
      chunk('{"why":"real reason"}', 'fix: has trailer\n\nAgent-Context: {"why":"real reason"}') +
      chunk("", "chore: no trailer at all") +
      chunk(
        '{"why":"a"}\n{"why":"b"}',
        'fix: ambiguous one\n\nAgent-Context: {"why":"a"}\nAgent-Context: {"why":"b"}',
      ) +
      chunk(
        "",
        'fix: misplaced one\n\nAgent-Context: {"why":"lost"}\n\nCo-authored-by: x <x@example.com>',
      );

    const { records, warnings } = parseLog(raw);
    expect(records).toHaveLength(4);
    expect(records[0]).toMatchObject({ subject: "fix: has trailer", context: { why: "real reason" } });
    expect(records[1]).toMatchObject({
      subject: "chore: no trailer at all",
      context: null,
      malformed: false,
      ambiguous: false,
      misplaced: false,
    });
    expect(records[2]).toMatchObject({ subject: "fix: ambiguous one", ambiguous: true });
    expect(records[3]).toMatchObject({ subject: "fix: misplaced one", misplaced: true });
    expect(warnings).toHaveLength(2);
  });

  it("handles an empty log (no commits) without error", () => {
    const { records, warnings } = parseLog("");
    expect(records).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it("parses non-object JSON (string, number, null, array) as valid, per SPEC.md's 'valid JSON' rule, not object-shaped", () => {
    const cases: Array<[string, unknown]> = [
      ['"just a string"', "just a string"],
      ["42", 42],
      ["null", null],
      ["[1,2,3]", [1, 2, 3]],
    ];

    for (const [json, expected] of cases) {
      const raw = chunk(json, `fix: odd trailer\n\nAgent-Context: ${json}`);
      const { records, warnings } = parseLog(raw);
      expect(records).toHaveLength(1);
      expect(records[0].malformed).toBe(false);
      expect(records[0].context).toEqual(expected);
      expect(warnings).toHaveLength(0);
      // The whole point: these must NOT be mistaken for a usable object.
      expect(isAgentContextObject(records[0].context)).toBe(false);
    }
  });
});

describe("runGitLog + parseLog, against a real temp git repo", () => {
  let repo: TempRepo;

  afterEach(() => {
    repo?.cleanup();
  });

  it("round-trips real commits end to end, including one with no trailer", () => {
    repo = new TempRepo();
    repo.commit(
      'refactor: drop LRU eviction\n\nAgent-Context: {"why":"redis client lacked per-key timestamps"}',
    );
    repo.commit("chore: bump a dependency");

    const raw = runGitLog([], repo.dir);
    const { records, warnings } = parseLog(raw);

    expect(records).toHaveLength(2);
    // git log lists newest first
    expect(records[0].subject).toBe("chore: bump a dependency");
    expect(records[0].context).toBeNull();
    expect(records[1].subject).toBe("refactor: drop LRU eviction");
    expect(records[1].context).toEqual({ why: "redis client lacked per-key timestamps" });
    expect(warnings).toHaveLength(0);
  });

  it("correctly isolates a duplicate-trailer commit from real git output, not just synthetic input", () => {
    repo = new TempRepo();
    repo.commit(
      'fix: real duplicate\n\nAgent-Context: {"why":"first"}\nAgent-Context: {"why":"second"}',
    );
    const raw = runGitLog([], repo.dir);
    const { records, warnings } = parseLog(raw);
    expect(records).toHaveLength(1);
    expect(records[0].ambiguous).toBe(true);
    expect(warnings[0].reason).toBe("ambiguous-trailer");
  });

  it("detects a real misplaced trailer, shaped exactly like GitHub's squash-merge prefill", () => {
    repo = new TempRepo();
    // A blank line before Co-authored-by pushes Agent-Context out of the
    // final trailer block, exactly the shape verified against real GitHub
    // squash commits.
    repo.commit(
      'fix: prefill shape\n\nAgent-Context: {"why":"looks right, isn\'t"}\n\nCo-authored-by: a <a@example.com>',
    );
    const raw = runGitLog([], repo.dir);
    const { records, warnings } = parseLog(raw);
    expect(records).toHaveLength(1);
    expect(records[0].context).toBeNull();
    expect(records[0].misplaced).toBe(true);
    expect(warnings[0].reason).toBe("misplaced-trailer");
  });

  it("does not misclassify a correctly-placed trailer that happens to sit next to Co-authored-by, contiguous, no blank line", () => {
    repo = new TempRepo();
    repo.commit(
      'fix: contiguous trailers\n\nAgent-Context: {"why":"fine"}\nCo-authored-by: a <a@example.com>',
    );
    const raw = runGitLog([], repo.dir);
    const { records, warnings } = parseLog(raw);
    expect(records[0].context).toEqual({ why: "fine" });
    expect(records[0].misplaced).toBe(false);
    expect(warnings).toHaveLength(0);
  });

  it("detects a misplaced trailer regardless of casing, matching git's own case-insensitive trailer key matching", () => {
    repo = new TempRepo();
    // A correctly-placed lowercase trailer must still parse (git itself
    // doesn't care about casing), proving this isn't a MISS/MISPLACED
    // question at all when placement is right.
    repo.commit('fix: lowercase, correctly placed\n\nagent-context: {"why":"fine"}');
    const okRaw = runGitLog([], repo.dir);
    const [okRecord] = parseLog(okRaw).records;
    expect(okRecord.context).toEqual({ why: "fine" });
    expect(okRecord.misplaced).toBe(false);
    repo.cleanup();

    // The actual regression this guards: the same lowercase trailer,
    // misplaced the same way the GitHub-prefill case is, must still be
    // reported as MISPLACED, not silently downgraded to MISS just because
    // the detector's own regex happened to be case-sensitive.
    repo = new TempRepo();
    repo.commit(
      'fix: lowercase, misplaced\n\nagent-context: {"why":"lost"}\n\nCo-authored-by: a <a@example.com>',
    );
    const misplacedRaw = runGitLog([], repo.dir);
    const { records, warnings } = parseLog(misplacedRaw);
    expect(records[0].context).toBeNull();
    expect(records[0].misplaced).toBe(true);
    expect(warnings[0].reason).toBe("misplaced-trailer");
  });

  it("detects a misplaced trailer with a space before the colon, against real git output", () => {
    repo = new TempRepo();
    repo.commit(
      'fix: spaced colon, misplaced\n\nAgent-Context : {"why":"lost"}\n\nCo-authored-by: a <a@example.com>',
    );
    const raw = runGitLog([], repo.dir);
    const { records, warnings } = parseLog(raw);
    expect(records[0].misplaced).toBe(true);
    expect(warnings[0].reason).toBe("misplaced-trailer");
  });

  it("does not split a single commit into phantom records when its body literally quotes the old, now-retired string delimiters", () => {
    // The actual bug, reproduced against real git: with the old
    // printable-string SENTINEL/FIELD_SEP, this exact commit (a real,
    // single, valid commit) parsed as two records. The fix replaces both
    // with NUL bytes, which git guarantees can never appear in a commit
    // message, so no body content can ever collide with the delimiter again.
    repo = new TempRepo();
    repo.commit(
      'docs: explain trailer placement\n\nWrong shape:\n\nAgent-Context: {"why":"x"}\n\nCo-authored-by: a <a@example.com>',
    );
    const raw = runGitLog([], repo.dir);
    const { records } = parseLog(raw);
    expect(records).toHaveLength(1);
    expect(records[0].subject).toBe("docs: explain trailer placement");
    // This commit's body genuinely does quote a line-initial, valid-JSON-
    // shaped "Agent-Context: {...}" not in the final block, textually
    // identical to a real misplaced trailer. misplaced: true here is the
    // correct, known, unavoidable classification, not a bug: no regex can
    // distinguish "documenting the wrong shape as an example" from "an
    // actual attempt at a trailer that landed wrong." See SPEC.md and the
    // comment on AGENT_CONTEXT_LINE in parser.ts for why this is accepted
    // rather than silently left unverified.
    expect(records[0].misplaced).toBe(true);
  });
});

describe("runGitLog error handling", () => {
  it("throws NotAGitRepositoryError outside a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-commit-not-a-repo-"));
    try {
      expect(() => runGitLog([], dir)).toThrow(NotAGitRepositoryError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws GitCommandError with git's own message for a bad ref, not a raw crash", () => {
    const repo = new TempRepo();
    try {
      repo.commit("chore: seed commit");
      let caught: unknown;
      try {
        runGitLog(["-1", "definitely-not-a-real-ref"], repo.dir);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(GitCommandError);
      expect((caught as GitCommandError).message).toMatch(/unknown revision|bad revision/i);
    } finally {
      repo.cleanup();
    }
  });
});

describe("checkGitVersion", () => {
  it("does not throw against whatever git is actually installed in this environment", () => {
    // This repo's own CI/dev environment is assumed to run a modern git;
    // this test would fail loudly (correctly) on a genuinely ancient one.
    expect(() => checkGitVersion()).not.toThrow();
  });
});

// LOG_FORMAT is deliberately richer than SPEC.md's plain-git "Reading it
// back" example (see the comment on LOG_FORMAT itself for why); this just
// pins the constant's own shape so a future edit can't silently drop a
// field without a test noticing.
describe("LOG_FORMAT", () => {
  it("has exactly two NUL-delimited fields ending in the double-NUL sentinel", () => {
    expect(FIELD_SEP).toBe("\0");
    expect(SENTINEL).toBe("\0\0");
    // The format string itself uses git's %x00 escape syntax, not a literal
    // NUL, since it's passed as a process argument (see LOG_FORMAT's own
    // comment for why an embedded NUL there is invalid).
    expect(LOG_FORMAT).toBe("%(trailers:key=Agent-Context,valueonly)%x00%B%x00%x00");
    expect(LOG_FORMAT).not.toContain("\0");
  });
});
