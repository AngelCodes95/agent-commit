import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Spins up a real temporary git repository for integration testing. Not mocked git. */
export class TempRepo {
  readonly dir: string;
  private fileCounter = 0;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "agent-commit-test-"));
    this.git(["init", "-q"]);
    this.git(["config", "user.email", "test@example.com"]);
    this.git(["config", "user.name", "test"]);
  }

  private git(args: string[]): string {
    return execFileSync("git", args, { cwd: this.dir, encoding: "utf8" });
  }

  /** Creates a commit with the given full message (subject, body, trailer, whatever the test needs), via stdin, avoiding shell quoting entirely. */
  commit(message: string): void {
    this.fileCounter += 1;
    const filename = `file-${this.fileCounter}.txt`;
    writeFileSync(join(this.dir, filename), `${this.fileCounter}\n`);
    this.git(["add", filename]);
    execFileSync("git", ["commit", "-q", "-F", "-"], {
      cwd: this.dir,
      input: message,
      encoding: "utf8",
    });
  }

  /** Writes `content` to `path` (relative to the repo) and commits it with `message`, for tests that need a file's lines to change across commits. */
  commitFile(path: string, content: string, message: string): void {
    writeFileSync(join(this.dir, path), content);
    this.git(["add", "--", path]);
    execFileSync("git", ["commit", "-q", "-F", "-"], { cwd: this.dir, input: message, encoding: "utf8" });
  }

  /** Writes `content` to `path` without committing, to leave a working-tree change. */
  writeFile(path: string, content: string): void {
    writeFileSync(join(this.dir, path), content);
  }

  log(extraArgs: string[], format: string): string {
    return this.git(["log", `--format=${format}`, ...extraArgs]);
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
