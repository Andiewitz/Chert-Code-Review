import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { emptyTreeId, listChangedFiles, loadPatch, run } from "./git"

// git's well-known empty tree object id.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

describe("run", () => {
  test("refuses commands outside the read-only allowlist", () => {
    expect(() => run(process.cwd(), ["commit", "-m", "nope"])).toThrow("git: command not allowed: commit")
    expect(() => run(process.cwd(), ["push"])).toThrow("git: command not allowed: push")
  })

  test("refuses an empty argument list", () => {
    expect(() => run(process.cwd(), [])).toThrow("git: no command given")
  })
})

describe("emptyTreeId", () => {
  test("returns git's empty tree id through the allowlisted helper", () => {
    expect(emptyTreeId(process.cwd())).toBe(EMPTY_TREE)
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
    const file = listChangedFiles(process.cwd()).find((candidate) => candidate.path === "blob.bin")
    expect(file?.status).toBe("untracked")
    const patch = loadPatch(process.cwd(), file!)
    expect(patch).not.toContain("\u0000")
    expect(patch).toContain("Binary files /dev/null and b/blob.bin differ")
  })

  test("an oversized file becomes a placeholder instead of thousands of rows", () => {
    const repo = tempRepo()
    writeFileSync(join(repo, "huge.txt"), "line\n".repeat(80_000))
    const file = listChangedFiles(process.cwd()).find((candidate) => candidate.path === "huge.txt")
    expect(file?.additions).toBe(0)
    const patch = loadPatch(process.cwd(), file!)
    expect(patch).toContain("too large to show")
    expect(patch.split("\n").length).toBeLessThan(10)
  })

  test("a small text file is still fully synthesized", () => {
    const repo = tempRepo()
    writeFileSync(join(repo, "small.txt"), "one\ntwo\n")
    const file = listChangedFiles(process.cwd()).find((candidate) => candidate.path === "small.txt")
    expect(file?.additions).toBe(2)
    expect(loadPatch(process.cwd(), file!)).toContain("+one\n+two")
  })
})

function git(repo: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd: repo })
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString())
  return proc.stdout.toString()
}

function commitAll(repo: string, message: string): void {
  git(repo, ["add", "."])
  git(repo, ["commit", "-q", "-m", message])
}

describe("listChangedFiles / loadPatch", () => {
  test("lists modified, deleted and untracked files together", () => {
    const repo = tempRepo()
    writeFileSync(join(repo, "keep.ts"), "one\ntwo\n")
    writeFileSync(join(repo, "gone.ts"), "bye\n")
    commitAll(repo, "files")

    writeFileSync(join(repo, "keep.ts"), "one\ntwo\nthree\n")
    rmSync(join(repo, "gone.ts"))
    writeFileSync(join(repo, "new.ts"), "fresh\n")

    const files = listChangedFiles(process.cwd())
    expect(files.map((file) => [file.path, file.status])).toEqual([
      ["gone.ts", "deleted"],
      ["keep.ts", "modified"],
      ["new.ts", "untracked"],
    ])
    expect(files.find((file) => file.path === "keep.ts")).toMatchObject({ additions: 1, deletions: 0 })
    expect(files.find((file) => file.path === "gone.ts")).toMatchObject({ additions: 0, deletions: 1 })

    expect(loadPatch(process.cwd(), files.find((file) => file.path === "keep.ts")!)).toContain("+three")
    expect(loadPatch(process.cwd(), files.find((file) => file.path === "new.ts")!)).toContain("+fresh")
  })

  test("staged review only contains staged changes", () => {
    const repo = tempRepo()
    writeFileSync(join(repo, "a.ts"), "a\n")
    writeFileSync(join(repo, "b.ts"), "b\n")
    commitAll(repo, "files")
    writeFileSync(join(repo, "a.ts"), "a\nstaged\n")
    writeFileSync(join(repo, "b.ts"), "b\nunstaged\n")
    git(repo, ["add", "a.ts"])

    expect(listChangedFiles(process.cwd(), { kind: "staged" }).map((file) => file.path)).toEqual(["a.ts"])
    expect(listChangedFiles(process.cwd()).map((file) => file.path)).toEqual(["a.ts", "b.ts"])
  })

  test("a repository without HEAD reviews untracked files only", () => {
    const repo = mkdtempSync(join(tmpdir(), "chert-git-empty-"))
    repos.push(repo)
    git(repo, ["init", "-q"])
    process.chdir(repo)
    writeFileSync(join(repo, "first.ts"), "line one\n")

    const files = listChangedFiles(process.cwd())
    expect(files.map((file) => file.status)).toEqual(["untracked"])
    expect(loadPatch(process.cwd(), files[0])).toContain("+line one")
  })

  test("commit review compares against the parent", () => {
    const repo = tempRepo()
    writeFileSync(join(repo, "a.ts"), "a\n")
    commitAll(repo, "add a")
    const sha = git(repo, ["rev-parse", "HEAD"]).trim()
    const parent = git(repo, ["rev-parse", "HEAD^"]).trim()

    const files = listChangedFiles(process.cwd(), { kind: "commit", sha, parent, subject: "add a" })
    expect(files.map((file) => [file.path, file.status])).toEqual([["a.ts", "added"]])
    expect(loadPatch(process.cwd(), files[0], { kind: "commit", sha, parent, subject: "add a" })).toContain(
      "+a",
    )
  })
})
