import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { emptyTreeId, listChangedFiles, loadPatch, run } from "./git"

// git's well-known empty tree object id.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

describe("run", () => {
  test("refuses commands outside the read-only allowlist", () => {
    expect(() => run(["commit", "-m", "nope"])).toThrow("git: command not allowed: commit")
    expect(() => run(["push"])).toThrow("git: command not allowed: push")
  })

  test("refuses an empty argument list", () => {
    expect(() => run([])).toThrow("git: no command given")
  })
})

describe("emptyTreeId", () => {
  test("returns git's empty tree id through the allowlisted helper", () => {
    expect(emptyTreeId()).toBe(EMPTY_TREE)
  })
})

const repos: string[] = []

/** A temp repo with one empty commit, chdir'ed into (git.ts relies on cwd). */
function tempRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "chert-git-"))
  repos.push(repo)
  const git = (args: string[]) => {
    const proc = Bun.spawnSync(["git", ...args], { cwd: repo })
    if (proc.exitCode !== 0) throw new Error(proc.stderr.toString())
  }
  git(["init", "-q"])
  git(["config", "user.email", "test@example.com"])
  git(["config", "user.name", "test"])
  git(["commit", "-q", "--allow-empty", "-m", "root"])
  process.chdir(repo)
  return repo
}

const originalCwd = process.cwd()

afterEach(() => {
  process.chdir(originalCwd)
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true })
})

describe("untracked files", () => {
  test("a binary file becomes a placeholder, not NUL bytes in the diff", () => {
    const repo = tempRepo()
    writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 0, 255]))
    const file = listChangedFiles().find((candidate) => candidate.path === "blob.bin")
    expect(file?.status).toBe("untracked")
    const patch = loadPatch(file!)
    expect(patch).not.toContain("\u0000")
    expect(patch).toContain("Binary files /dev/null and b/blob.bin differ")
  })

  test("an oversized file becomes a placeholder instead of thousands of rows", () => {
    const repo = tempRepo()
    writeFileSync(join(repo, "huge.txt"), "line\n".repeat(80_000))
    const file = listChangedFiles().find((candidate) => candidate.path === "huge.txt")
    expect(file?.additions).toBe(0)
    const patch = loadPatch(file!)
    expect(patch).toContain("too large to show")
    expect(patch.split("\n").length).toBeLessThan(10)
  })

  test("a small text file is still fully synthesized", () => {
    const repo = tempRepo()
    writeFileSync(join(repo, "small.txt"), "one\ntwo\n")
    const file = listChangedFiles().find((candidate) => candidate.path === "small.txt")
    expect(file?.additions).toBe(2)
    expect(loadPatch(file!)).toContain("+one\n+two")
  })
})
