// Refs and commits: branch names, shas, parents and merge bases. Every query is
// read-only and every failure is a named fallback rather than a throw.

import { tryOr } from "../best-effort"
import { MAX_RECENT_COMMITS } from "../limits"
import { run } from "./run"

export function gitDir(root: string): string {
  return run(root, ["rev-parse", "--absolute-git-dir"]).trim()
}

export function isGitRepository(root: string): boolean {
  return tryOr(() => {
    run(root, ["rev-parse", "--is-inside-work-tree"])
    return true
  }, false)
}

export function validateRef(root: string, value: string): boolean {
  if (typeof value !== "string") return false
  if (value.length === 0 || value.length > 200) return false
  if (value.startsWith("-")) return false
  if (value.includes("\n") || value.includes("\0")) return false
  return tryOr(() => {
    run(root, ["rev-parse", "--verify", "--quiet", `${value}^{commit}`])
    return true
  }, false)
}

/** The empty tree object, used as the parent of a repository's first commit. */
export function emptyTreeId(root: string): string {
  return run(root, ["hash-object", "-t", "tree", "--stdin"], { input: "" }).trim()
}

export function hasHead(root: string): boolean {
  return tryOr(() => {
    run(root, ["rev-parse", "--verify", "HEAD"])
    return true
  }, false)
}

export function currentBranch(root: string): string {
  return tryOr(() => {
    const out = run(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()
    return out === "" ? "no commits" : out
  }, "no commits")
}

/** Resolve the base branch for /review branch. */
export function resolveReviewBase(root: string): string | null {
  // 1. origin/HEAD
  const remoteHead = tryOr(() => {
    const out = run(root, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]).trim()
    const name = out.replace(/^origin\//, "")
    return name === "" ? null : name
  }, null)
  if (remoteHead !== null) return remoteHead
  // 2. first existing of main, master, develop
  for (const candidate of ["main", "master", "develop"]) {
    if (
      tryOr(() => run(root, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]), null) !== null
    ) {
      return candidate
    }
  }
  return null
}

/** List recent commits as { sha, subject }. */
export function listRecentCommits(
  root: string,
  limit = MAX_RECENT_COMMITS,
): { sha: string; subject: string }[] {
  // No history (or no git): an empty list is the right answer.
  return tryOr(() => {
    const out = run(root, ["log", `--max-count=${limit}`, "--format=%H%x09%s"])
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
  }, [])
}

/** Get commit subject (truncated). */
export function commitSubject(root: string, sha: string): string {
  return tryOr(() => run(root, ["log", "-1", "--format=%s", sha]).trim(), "")
}

/** Resolve a ref to a full sha. Returns null on failure. */
export function resolveSha(root: string, ref: string): string | null {
  if (!validateRef(root, ref)) return null
  return tryOr(() => run(root, ["rev-parse", `${ref}^{commit}`]).trim(), null)
}

/** Parent sha of a commit, or "empty" if none. Uses first parent for merges. */
export function commitParent(root: string, sha: string): string | "empty" {
  const out = tryOr(() => run(root, ["rev-parse", `${sha}^1`]).trim(), "")
  return out === "" ? "empty" : out
}

/** Merge base of two refs. */
export function mergeBase(root: string, a: string, b: string): string {
  return run(root, ["merge-base", a, b]).trim()
}
