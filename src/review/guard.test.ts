import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { compareTrees, snapshotTree } from "./guard"

const repos: string[] = []

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "chert-guard-"))
  repos.push(dir)
  const git = (args: string[]) => {
    const proc = Bun.spawnSync(["git", ...args], { cwd: dir })
    if (proc.exitCode !== 0) throw new Error(proc.stderr.toString())
  }
  git(["init", "-b", "main"])
  git(["config", "user.email", "guard@example.com"])
  git(["config", "user.name", "guard"])
  writeFileSync(join(dir, "tracked.txt"), "one\n")
  git(["add", "."])
  git(["commit", "-m", "base"])
  return dir
}

afterAll(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true })
})

describe("tree guard", () => {
  test("an untouched tree compares equal", () => {
    const repo = tempRepo()
    expect(compareTrees(snapshotTree(repo), snapshotTree(repo))).toEqual({ changed: false, paths: [] })
  })

  test("an edited tracked file is reported by path", () => {
    const repo = tempRepo()
    const before = snapshotTree(repo)
    writeFileSync(join(repo, "tracked.txt"), "two\n")
    const report = compareTrees(before, snapshotTree(repo))
    expect(report.changed).toBe(true)
    expect(report.paths).toEqual(["tracked.txt"])
  })

  test("a staged change counts too", () => {
    const repo = tempRepo()
    const before = snapshotTree(repo)
    writeFileSync(join(repo, "tracked.txt"), "staged\n")
    Bun.spawnSync(["git", "add", "tracked.txt"], { cwd: repo })
    expect(compareTrees(before, snapshotTree(repo)).paths).toEqual(["tracked.txt"])
  })

  test("a new untracked file is reported by path", () => {
    const repo = tempRepo()
    const before = snapshotTree(repo)
    writeFileSync(join(repo, "new.txt"), "hello\n")
    const report = compareTrees(before, snapshotTree(repo))
    expect(report.changed).toBe(true)
    expect(report.paths).toEqual(["new.txt"])
  })

  test("rewriting an untracked file changes the hash without changing the path", () => {
    const repo = tempRepo()
    writeFileSync(join(repo, "new.txt"), "first\n")
    const before = snapshotTree(repo)
    writeFileSync(join(repo, "new.txt"), "second\n")
    const report = compareTrees(before, snapshotTree(repo))
    // git status shows the same single path; the bytes are what moved.
    expect(report.changed).toBe(true)
    expect(report.paths).toEqual([])
  })

  test("deleting a file is reported", () => {
    const repo = tempRepo()
    const before = snapshotTree(repo)
    Bun.spawnSync(["rm", join(repo, "tracked.txt")])
    expect(compareTrees(before, snapshotTree(repo)).paths).toEqual(["tracked.txt"])
  })
})
