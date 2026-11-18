// Invariant: process.cwd() must be the repo root whenever git.ts runs.
// Git data layer: local review of working-tree changes vs HEAD (staged +
// unstaged combined), plus untracked files synthesized as all-added diffs.
// Renames are disabled (`--no-renames`) so every record has a single path.
//
// Read-only: chert never writes to the user's repo. All git access goes
// through run(), which allowlists the first argument and sets
// GIT_OPTIONAL_LOCKS=0 so a concurrent `git commit` is not blocked.
//
// Synchronous on purpose: git calls are fast, and synchronous state updates
// render deterministically regardless of the host renderer's event loop.

import { readFileSync, statSync } from "node:fs"
import { MAX_RECENT_COMMITS } from "./limits"

export type FileStatus = "added" | "modified" | "deleted" | "untracked"

export interface ReviewFile {
  path: string
  status: FileStatus
  additions: number
  deletions: number
}

export type ReviewSource =
  | { kind: "working" }
  | { kind: "staged" }
  | { kind: "branch"; base: string; mergeBase: string }
  | { kind: "commit"; sha: string; parent: string | "empty"; subject: string }

// Allowlist of git first-arguments. Anything else throws.
const ALLOWED = new Set([
  "rev-parse",
  "diff",
  "ls-files",
  "show",
  "merge-base",
  "symbolic-ref",
  "rev-list",
  "log",
  "cat-file",
  "hash-object",
])

interface RunOptions {
  /** Directory to run in; defaults to the process cwd (normally the repo root). */
  cwd?: string
  /** Data for commands that read stdin, such as hash-object. */
  input?: string
}

export function run(args: string[], options: RunOptions = {}): string {
  if (args.length === 0) throw new Error("git: no command given")
  if (!ALLOWED.has(args[0])) {
    throw new Error(`git: command not allowed: ${args[0]}`)
  }
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: options.cwd,
    stdin: options.input === undefined ? undefined : Buffer.from(options.input),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  })
  if (proc.exitCode !== 0) {
    throw new Error(
      proc.stderr.toString().trim() || `git ${args.join(" ")} exited with code ${proc.exitCode}`,
    )
  }
  return proc.stdout.toString()
}

export function gitDir(): string {
  return run(["rev-parse", "--absolute-git-dir"]).trim()
}

export function isGitRepository(): boolean {
  try {
    run(["rev-parse", "--is-inside-work-tree"])
    return true
  } catch {
    return false
  }
}

function parseCounts(value: string): number {
  if (value === "-" || value === "") return 0
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? 0 : parsed
}

function statusFromCode(code: string): FileStatus {
  switch (code[0]) {
    case "A":
      return "added"
    case "D":
      return "deleted"
    default:
      return "modified"
  }
}

/** Untracked files above this size get a placeholder patch instead of a diff. */
const MAX_UNTRACKED_PATCH_BYTES = 256 * 1024

function countLines(path: string): number {
  try {
    // Counting a huge untracked file is not worth reading it into memory.
    if (statSync(path).size > MAX_UNTRACKED_PATCH_BYTES) return 0
    const buf = readFileSync(path)
    if (buf.length === 0) return 0
    let lines = 0
    let index = buf.indexOf(10) // \n
    while (index !== -1) {
      lines += 1
      index = buf.indexOf(10, index + 1)
    }
    if (buf[buf.length - 1] !== 10) lines += 1
    return lines
  } catch {
    return 0
  }
}

export function validateRef(value: string): boolean {
  if (typeof value !== "string") return false
  if (value.length === 0 || value.length > 200) return false
  if (value.startsWith("-")) return false
  if (value.includes("\n") || value.includes("\0")) return false
  try {
    run(["rev-parse", "--verify", "--quiet", `${value}^{commit}`])
    return true
  } catch {
    return false
  }
}

/** The empty tree object, used as the parent of a repository's first commit. */
export function emptyTreeId(): string {
  return run(["hash-object", "-t", "tree", "--stdin"], { input: "" }).trim()
}

function hasHead(): boolean {
  try {
    run(["rev-parse", "--verify", "HEAD"])
    return true
  } catch {
    return false
  }
}

export function currentBranch(): string {
  try {
    const out = run(["rev-parse", "--abbrev-ref", "HEAD"]).trim()
    return out === "" ? "no commits" : out
  } catch {
    return "no commits"
  }
}

/** What one review source contributes to a `git diff` invocation. */
interface DiffBase {
  /** Arguments after "diff" that select the base, or null when nothing is diffable yet. */
  base: string[] | null
  /** Whether untracked files belong to this review. */
  includesUntracked: boolean
}

/** The single place that knows how a ReviewSource maps onto a diff. */
function diffBaseArgs(source: ReviewSource, headExists: boolean): DiffBase {
  switch (source.kind) {
    case "working":
      return { base: headExists ? ["HEAD"] : null, includesUntracked: true }
    case "staged":
      return { base: ["--cached"], includesUntracked: false }
    case "branch":
      return { base: [source.mergeBase], includesUntracked: true }
    case "commit":
      return {
        base: [source.parent === "empty" ? emptyTreeId() : source.parent, source.sha],
        includesUntracked: false,
      }
  }
}

/** `git diff` with a machine-readable format, for the given base. */
function diffArgs(base: string[], format: "--name-status" | "--numstat"): string[] {
  return ["diff", ...base, "--no-renames", format, "-z", "--"]
}

export function listChangedFiles(source: ReviewSource = { kind: "working" }): ReviewFile[] {
  if (!isGitRepository()) {
    throw new Error("not a git repository (or any of the parent directories)")
  }

  // One HEAD probe per call: hasHead() spawns git, and diffArgs used to ask
  // once and skipTracked asked again.
  const headExists = source.kind === "working" ? hasHead() : true
  const { base, includesUntracked } = diffBaseArgs(source, headExists)

  const tracked: ReviewFile[] = []
  if (base !== null) {
    const statuses = run(diffArgs(base, "--name-status"))
    const numstat = run(diffArgs(base, "--numstat"))

    const statusByPath = new Map<string, FileStatus>()
    const statusTokens = statuses.split("\0")
    for (let i = 0; i + 1 < statusTokens.length; i += 2) {
      if (statusTokens[i] === "") break
      statusByPath.set(statusTokens[i + 1], statusFromCode(statusTokens[i]))
    }

    const countsByPath = new Map<string, { additions: number; deletions: number }>()
    for (const record of numstat.split("\0")) {
      if (record === "") continue
      const [add, del, ...pathParts] = record.split("\t")
      const path = pathParts.join("\t")
      countsByPath.set(path, { additions: parseCounts(add), deletions: parseCounts(del) })
    }

    for (const [path, status] of statusByPath) {
      const counts = countsByPath.get(path) ?? { additions: 0, deletions: 0 }
      tracked.push({ path, status, ...counts })
    }
  }

  let untrackedFiles: ReviewFile[] = []
  if (includesUntracked) {
    const untrackedPaths = run(["ls-files", "--others", "--exclude-standard", "-z"])
      .split("\0")
      .filter(Boolean)
    untrackedFiles = untrackedPaths.map((path) => ({
      path,
      status: "untracked" as const,
      additions: countLines(path),
      deletions: 0,
    }))
  }

  return [...tracked, ...untrackedFiles].sort((a, b) => a.path.localeCompare(b.path))
}

export function loadPatch(file: ReviewFile, source: ReviewSource = { kind: "working" }): string {
  if (file.status === "untracked") {
    return synthesizedAddedPatch(file.path)
  }
  const headExists = source.kind === "working" ? hasHead() : true
  const { base } = diffBaseArgs(source, headExists)
  if (base === null) {
    return synthesizedAddedPatch(file.path)
  }
  return run(["diff", ...base, "--no-renames", "--no-color", "--", file.path])
}

/** Every file git knows about in the working tree: tracked plus untracked. */
export function listProjectFiles(): string[] {
  const tracked = run(["ls-files", "-z"]).split("\0").filter(Boolean)
  const untracked = run(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean)
  return Array.from(new Set([...tracked, ...untracked])).sort((a, b) => a.localeCompare(b))
}

/** Resolve the base branch for /review branch. */
export function resolveReviewBase(): string | null {
  // 1. origin/HEAD
  try {
    const out = run(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]).trim()
    if (out !== "") {
      // strip "origin/" prefix
      const name = out.replace(/^origin\//, "")
      if (name !== "") return name
    }
  } catch {
    // fall through
  }
  // 2. first existing of main, master, develop
  for (const cand of ["main", "master", "develop"]) {
    try {
      run(["rev-parse", "--verify", "--quiet", `${cand}^{commit}`])
      return cand
    } catch {
      // try next
    }
  }
  return null
}

/** List recent commits as { sha, subject }. */
export function listRecentCommits(limit = MAX_RECENT_COMMITS): { sha: string; subject: string }[] {
  try {
    const out = run(["log", `--max-count=${limit}`, "--format=%H%x09%s"])
    return out
      .trim()
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((line) => {
        const idx = line.indexOf("\t")
        const sha = idx === -1 ? line.trim() : line.slice(0, idx).trim()
        const subject = idx === -1 ? "" : line.slice(idx + 1).trim()
        return { sha, subject }
      })
  } catch {
    return []
  }
}

/** Get commit subject (truncated). */
export function commitSubject(sha: string): string {
  try {
    return run(["log", "-1", "--format=%s", sha]).trim()
  } catch {
    return ""
  }
}

/** Resolve a ref to a full sha. Returns null on failure. */
export function resolveSha(ref: string): string | null {
  if (!validateRef(ref)) return null
  try {
    return run(["rev-parse", `${ref}^{commit}`]).trim()
  } catch {
    return null
  }
}

/** Parent sha of a commit, or "empty" if none. Uses first parent for merges. */
export function commitParent(sha: string): string | "empty" {
  try {
    const out = run(["rev-parse", `${sha}^1`]).trim()
    if (out === "") return "empty"
    return out
  } catch {
    return "empty"
  }
}

/** Merge base of two refs. */
export function mergeBase(a: string, b: string): string {
  return run(["merge-base", a, b]).trim()
}

function synthesizedAddedPatch(path: string): string {
  let content = Buffer.alloc(0)
  try {
    content = readFileSync(path)
  } catch {
    // unreadable: fall through to an empty patch
  }

  const header = [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..e69de29",
    "--- /dev/null",
    `+++ b/${path}`,
  ].join("\n")

  // Untracked files are read whole, so a huge one would build a patch with
  // tens of thousands of rows and stall the viewer.
  if (content.length > MAX_UNTRACKED_PATCH_BYTES) {
    return `${header}\n… file is ${Math.round(content.length / 1024)} KiB, too large to show\n`
  }
  // A NUL byte means binary; say what git says for a tracked binary so the
  // viewer can style and skip it the same way.
  if (content.includes(0)) {
    return `${header}\nBinary files /dev/null and b/${path} differ\n`
  }

  const lines = content.toString().split("\n")
  if (lines[lines.length - 1] === "") lines.pop()

  if (lines.length === 0) {
    return `${header}\n@@ -0,0 +0,0 @@\n`
  }
  const body = lines.map((line) => `+${line}`).join("\n")
  return `${header}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`
}
