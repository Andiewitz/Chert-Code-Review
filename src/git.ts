// Invariant: process.cwd() must be the repo root whenever git.ts runs.
// Git data layer: local review of working-tree changes vs HEAD (staged +
// unstaged combined), plus untracked files synthesized as all-added diffs.
// Renames are disabled (`--no-renames`) so every record has a single path.
//
// Synchronous on purpose: git calls are fast, and synchronous state updates
// render deterministically regardless of the host renderer's event loop.

import { readFileSync } from "node:fs";

export type FileStatus = "added" | "modified" | "deleted" | "untracked";

export interface ReviewFile {
  path: string;
  status: FileStatus;
  additions: number;
  deletions: number;
}

function run(args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(proc.stderr.toString().trim() || `git ${args.join(" ")} exited with code ${proc.exitCode}`);
  }
  return proc.stdout.toString();
}

export function isGitRepository(): boolean {
  try {
    run(["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

function parseCounts(value: string): number {
  if (value === "-" || value === "") return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function statusFromCode(code: string): FileStatus {
  switch (code[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    default:
      // M, T (type change), and anything else we display as modified
      return "modified";
  }
}

function countLines(path: string): number {
  try {
    const buf = readFileSync(path);
    if (buf.length === 0) return 0;
    let lines = 0;
    let index = buf.indexOf(10); // \n
    while (index !== -1) {
      lines += 1;
      index = buf.indexOf(10, index + 1);
    }
    if (buf[buf.length - 1] !== 10) lines += 1;
    return lines;
  } catch {
    return 0;
  }
}

export function listChangedFiles(): ReviewFile[] {
  if (!isGitRepository()) {
    throw new Error("not a git repository (or any of the parent directories)");
  }

  // A repo without commits has no HEAD; all content is covered by untracked.
  const hasHead = ((): boolean => {
    try {
      run(["rev-parse", "--verify", "HEAD"]);
      return true;
    } catch {
      return false;
    }
  })();

  const tracked: ReviewFile[] = [];
  if (hasHead) {
    const statuses = run(["diff", "HEAD", "--no-renames", "--name-status", "-z"]);
    const numstat = run(["diff", "HEAD", "--no-renames", "--numstat", "-z"]);

    // name-status -z: strict [status, path] pairs
    const statusByPath = new Map<string, FileStatus>();
    const statusTokens = statuses.split("\0");
    for (let i = 0; i + 1 < statusTokens.length; i += 2) {
      if (statusTokens[i] === "") break;
      statusByPath.set(statusTokens[i + 1], statusFromCode(statusTokens[i]));
    }

    // numstat -z: NUL-terminated records of "add\tdelete\tpath"
    const countsByPath = new Map<string, { additions: number; deletions: number }>();
    for (const record of numstat.split("\0")) {
      if (record === "") continue;
      const [add, del, ...pathParts] = record.split("\t");
      const path = pathParts.join("\t");
      countsByPath.set(path, { additions: parseCounts(add), deletions: parseCounts(del) });
    }

    for (const [path, status] of statusByPath) {
      const counts = countsByPath.get(path) ?? { additions: 0, deletions: 0 };
      tracked.push({ path, status, ...counts });
    }
  }

  // Untracked files (respects .gitignore) become all-added diffs.
  const untrackedPaths = run(["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean);

  const untracked: ReviewFile[] = untrackedPaths.map((path) => ({
    path,
    status: "untracked",
    additions: countLines(path),
    deletions: 0,
  }));

  return [...tracked, ...untracked].sort((a, b) => a.path.localeCompare(b.path));
}

export function loadPatch(file: ReviewFile): string {
  if (file.status === "untracked") {
    return synthesizedAddedPatch(file.path);
  }
  return run(["diff", "HEAD", "--no-renames", "--no-color", "--", file.path]);
}

/** Every file git knows about in the working tree: tracked plus untracked
 * (respects .gitignore). Used by the project tree view. */
export function listProjectFiles(): string[] {
  const tracked = run(["ls-files", "-z"])
    .split("\0")
    .filter(Boolean);
  const untracked = run(["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean);
  return Array.from(new Set([...tracked, ...untracked])).sort((a, b) => a.localeCompare(b));
}

export function currentBranch(): string {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return "no commits";
    const out = proc.stdout.toString().trim();
    return out === "" ? "no commits" : out;
  } catch {
    return "no commits";
  }
}

function synthesizedAddedPatch(path: string): string {
  let content = "";
  try {
    content = readFileSync(path).toString();
  } catch {
    // unreadable: show an empty added file
  }
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  const header = [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..e69de29",
    "--- /dev/null",
    `+++ b/${path}`,
  ].join("\n");

  if (lines.length === 0) {
    return `${header}\n@@ -0,0 +0,0 @@\n`;
  }
  const body = lines.map((line) => `+${line}`).join("\n");
  return `${header}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`;
}
