// The tree guard: hash the working tree before and after every harness call.
// chert asks the harness not to edit anything, but a prompt is not a
// guarantee; this is the check that notices when one did.
//
// The snapshot covers the whole state a reviewer would care about: every path
// git reports as changed, the diff of the tracked ones, and the bytes of the
// untracked ones (git status alone would not notice an edited new file).

import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { tryOr } from "../best-effort"
import { run } from "../git"

/** Untracked files this large are hashed by size instead of content. */
const MAX_HASHED_BYTES = 4 * 1024 * 1024

export interface TreeSnapshot {
  hash: string
  /** Paths git reports as changed, sorted. */
  paths: string[]
}

export interface GuardReport {
  changed: boolean
  /** Paths that appeared, vanished or whose status changed. */
  paths: string[]
}

/** `XY path` entries, one per NUL-separated record, renames disabled. */
function statusPaths(stdout: string): string[] {
  return stdout
    .split("\0")
    .filter((entry) => entry.length > 3)
    .map((entry) => entry.slice(3))
    .sort()
}

function trackedDiff(root: string): string {
  const againstHead = tryOr(() => run(root, ["diff", "HEAD", "--binary", "--no-color"]), null)
  if (againstHead !== null) return againstHead
  // No commit yet: the index and the worktree are the whole story.
  return tryOr(() => run(root, ["diff", "--binary", "--no-color"]), "") +
    tryOr(() => run(root, ["diff", "--cached", "--binary", "--no-color"]), "")
}

function untrackedContent(root: string): string {
  const paths = run(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean)
  const hasher = new Bun.CryptoHasher("sha256")
  for (const path of paths.sort()) {
    hasher.update(path)
    const full = join(root, path)
    const size = tryOr(() => statSync(full).size, 0)
    hasher.update(String(size))
    if (size <= MAX_HASHED_BYTES) hasher.update(tryOr(() => readFileSync(full), Buffer.alloc(0)))
  }
  return hasher.digest("hex")
}

/** One hash over everything a review would notice, plus the changed paths. */
export function snapshotTree(root: string): TreeSnapshot {
  const status = run(root, ["status", "--porcelain=v1", "--no-renames", "-z", "--untracked-files=all"])
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(status)
  hasher.update(trackedDiff(root))
  hasher.update(untrackedContent(root))
  return { hash: hasher.digest("hex"), paths: statusPaths(status) }
}

/** What changed between two snapshots. A content-only change has no path. */
export function compareTrees(before: TreeSnapshot, after: TreeSnapshot): GuardReport {
  if (before.hash === after.hash) return { changed: false, paths: [] }
  const beforeSet = new Set(before.paths)
  const afterSet = new Set(after.paths)
  const paths = [...new Set([...before.paths, ...after.paths])].filter(
    (path) => !(beforeSet.has(path) && afterSet.has(path)),
  )
  return { changed: true, paths }
}
