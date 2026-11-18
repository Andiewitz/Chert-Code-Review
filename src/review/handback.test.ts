import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Highlight } from "../highlights"
import { handbackMarkdown, handbackPath, writeHandback } from "./handback"

const repos: string[] = []

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "chert-handback-"))
  repos.push(dir)
  Bun.spawnSync(["git", "init", "-b", "main"], { cwd: dir })
  return dir
}

afterAll(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true })
})

function highlight(overrides: Partial<Highlight> = {}): Highlight {
  return {
    id: "h1",
    path: "src/a.ts",
    side: "new",
    start: 4,
    end: 6,
    text: [],
    before: [],
    after: [],
    by: "you",
    level: "note",
    note: "this leaks the socket",
    createdAt: 0,
    ...overrides,
  }
}

describe("handback", () => {
  test("groups by file and names the range and side", () => {
    const markdown = handbackMarkdown(
      [highlight(), highlight({ id: "h2", path: "src/a.ts", start: 9, end: 9, note: "minor" })],
      "ses_fork",
    )
    expect(markdown).toContain("From review session `ses_fork`.")
    expect(markdown).toContain("## src/a.ts")
    expect(markdown).toContain("- lines 4-6: this leaks the socket")
    expect(markdown).toContain("- line 9: minor")
  })

  test("writes nothing when every note is empty", () => {
    const repo = tempRepo()
    expect(writeHandback(repo, [highlight({ note: "   " })])).toBeNull()
  })

  test("writes the file under the git directory", () => {
    const repo = tempRepo()
    const path = writeHandback(repo, [highlight()], "ses_fork")
    expect(path).toBe(handbackPath(repo))
    expect(readFileSync(path as string, "utf8")).toContain("this leaks the socket")
  })
})
