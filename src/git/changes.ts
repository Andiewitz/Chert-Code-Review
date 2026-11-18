// What changed: the file list for a review source, with statuses and line
// counts. Untracked files are synthesized into the list (and counted) here; the
// patch text itself lives in patch.ts.

import { readFileSync, statSync } from "node:fs"
import { tryOr } from "../best-effort"
import { emptyTreeId, hasHead, isGitRepository } from "./refs"
import { run } from "./run"

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

function countLines(path: string): number {
  // An unreadable file contributes no lines to the "additions" count.
  return tryOr(() => {
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
  }, 0)
}

/** Untracked files above this size get a placeholder patch instead of a diff. */
export const MAX_UNTRACKED_PATCH_BYTES = 256 * 1024

/** What one review source contributes to a `git diff` invocation. */
interface DiffBase {
  /** Arguments after "diff" that select the base, or null when nothing is diffable yet. */
  base: string[] | null
  /** Whether untracked files belong to this review. */
  includesUntracked: boolean
}

/** The single place that knows how a ReviewSource maps onto a diff. */
export function diffBaseArgs(root: string, source: ReviewSource, headExists: boolean): DiffBase {
  switch (source.kind) {
    case "working":
      return { base: headExists ? ["HEAD"] : null, includesUntracked: true }
    case "staged":
      return { base: ["--cached"], includesUntracked: false }
    case "branch":
      return { base: [source.mergeBase], includesUntracked: true }
    case "commit":
      return {
        base: [source.parent === "empty" ? emptyTreeId(root) : source.parent, source.sha],
        includesUntracked: false,
      }
  }
}

/** `git diff` with a machine-readable format, for the given base. */
function diffArgs(base: string[], format: "--name-status" | "--numstat"): string[] {
  return ["diff", ...base, "--no-renames", format, "-z", "--"]
}

export function listChangedFiles(root: string, source: ReviewSource = { kind: "working" }): ReviewFile[] {
  if (!isGitRepository(root)) {
    throw new Error("not a git repository (or any of the parent directories)")
  }

  // One HEAD probe per call: hasHead() spawns git, and diffArgs used to ask
  // once and skipTracked asked again.
  const headExists = source.kind === "working" ? hasHead(root) : true
  const { base, includesUntracked } = diffBaseArgs(root, source, headExists)

  const tracked: ReviewFile[] = []
  if (base !== null) {
    const statuses = run(root, diffArgs(base, "--name-status"))
    const numstat = run(root, diffArgs(base, "--numstat"))

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
    const untrackedPaths = run(root, ["ls-files", "--others", "--exclude-standard", "-z"])
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

/** Every file git knows about in the working tree: tracked plus untracked. */
export function listProjectFiles(root: string): string[] {
  const tracked = run(root, ["ls-files", "-z"]).split("\0").filter(Boolean)
  const untracked = run(root, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)
  return Array.from(new Set([...tracked, ...untracked])).sort((a, b) => a.localeCompare(b))
}
