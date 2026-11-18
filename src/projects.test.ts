import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  expandPath,
  forgetProject,
  loadRecent,
  openProject,
  parseCdArgument,
  rememberProject,
  resolveProject,
} from "./projects"

const created: string[] = []
let configHome: string
let previousConfigDir: string | undefined
const originalCwd = process.cwd()

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

/** A git repo at <parent>/<name>, so resolveProjectRoot accepts it. */
function makeRepo(parent: string, name: string): string {
  const path = join(parent, name)
  mkdirSync(path, { recursive: true })
  const proc = Bun.spawnSync(["git", "init", "-q"], { cwd: path })
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString())
  return path
}

beforeEach(() => {
  configHome = tempDir("chert-projects-config-")
  previousConfigDir = process.env.CHERT_CONFIG_DIR
  process.env.CHERT_CONFIG_DIR = configHome
})

afterEach(() => {
  process.chdir(originalCwd)
  if (previousConfigDir === undefined) delete process.env.CHERT_CONFIG_DIR
  else process.env.CHERT_CONFIG_DIR = previousConfigDir
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("expandPath", () => {
  test("expands ~, ~/ and relative paths", () => {
    const home = process.env.HOME ?? ""
    expect(expandPath("~/code", "/tmp")).toBe(join(home, "code"))
    expect(expandPath("sub/dir", "/base")).toBe("/base/sub/dir")
    expect(expandPath("/abs/path/.", "/tmp")).toBe("/abs/path")
  })

  test("strips matching quotes", () => {
    expect(expandPath('"~/quoted"', "/tmp")).toBe(join(process.env.HOME ?? "", "quoted"))
    expect(expandPath("'/tmp/plain'", "/tmp")).toBe("/tmp/plain")
  })
})

describe("parseCdArgument", () => {
  test("unescapes spaces outside quotes", () => {
    if (process.platform === "win32") return
    expect(parseCdArgument("/tmp/my\\ project")).toBe("/tmp/my project")
  })

  test("strips quotes and trailing separators", () => {
    expect(parseCdArgument('"/tmp/some dir/"')).toBe("/tmp/some dir")
  })
})

describe("resolveProject", () => {
  test("opens an explicit directory inside a repo and returns the repo root", () => {
    const repo = makeRepo(tempDir("chert-projects-base-"), "alpha")
    const result = resolveProject(repo)
    expect(result).toEqual({ kind: "open", root: repo, name: "alpha" })
  })

  test("is pure: it does not chdir or remember the project", () => {
    const repo = makeRepo(tempDir("chert-projects-base-"), "beta")
    const before = process.cwd()
    resolveProject(repo)
    expect(process.cwd()).toBe(before)
    expect(loadRecent()).toEqual([])
  })

  test("matches saved projects by exact name, then prefix, then substring", () => {
    const base = tempDir("chert-projects-base-")
    const alpha = makeRepo(base, "alpha")
    const alphabet = makeRepo(base, "alphabet")
    const myalpha = makeRepo(base, "myalpha")
    rememberProject(alpha)
    rememberProject(alphabet)
    rememberProject(myalpha)

    expect(resolveProject("alpha")).toMatchObject({ kind: "open", root: alpha })
    expect(resolveProject("alphab")).toMatchObject({ kind: "open", root: alphabet })
    expect(resolveProject("yalpha")).toMatchObject({ kind: "open", root: myalpha })
  })

  test("reports ambiguity instead of guessing", () => {
    const base = tempDir("chert-projects-base-")
    rememberProject(makeRepo(base, "same-one"))
    rememberProject(makeRepo(base, "same-two"))
    const result = resolveProject("same-")
    expect(result.kind).toBe("ambiguous")
  })

  test("reports a folder that only contains repositories", () => {
    const base = tempDir("chert-projects-base-")
    makeRepo(base, "inside")
    const result = resolveProject(base)
    expect(result).toEqual({ kind: "contains", repoNames: ["inside"] })
  })

  test("reports nothing for an unknown name", () => {
    expect(resolveProject("definitely-not-a-project")).toEqual({
      kind: "none",
      query: "definitely-not-a-project",
    })
  })
})

describe("openProject", () => {
  test("chdirs to the repo root and remembers it", () => {
    const repo = makeRepo(tempDir("chert-projects-base-"), "gamma")
    const nested = join(repo, "src")
    mkdirSync(nested)
    expect(openProject(nested)).toBe(repo)
    expect(process.cwd()).toBe(repo)
    expect(loadRecent().map((recent) => recent.path)).toContain(repo)
  })

  test("returns undefined outside a repository and does not move", () => {
    const before = process.cwd()
    const plain = tempDir("chert-projects-plain-")
    expect(openProject(plain)).toBeUndefined()
    expect(process.cwd()).toBe(before)
  })
})

describe("forgetProject", () => {
  test("drops the entry without touching the directory", () => {
    const repo = makeRepo(tempDir("chert-projects-base-"), "delta")
    rememberProject(repo)
    forgetProject(repo)
    expect(loadRecent()).toEqual([])
  })
})
