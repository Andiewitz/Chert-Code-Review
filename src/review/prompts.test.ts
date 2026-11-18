import { describe, expect, test } from "bun:test"
import type { Row } from "../diffrows"
import { MAX_WALK_REQUEST_CHARS } from "../limits"
import { askRequest, fileRequest, planRequest, renderRows, repairRequest } from "./prompts"

const rows: Row[] = [
  { kind: "hunk", text: "@@ -1,2 +1,3 @@" },
  { kind: "context", oldNo: 1, newNo: 1, text: "const a = 1" },
  { kind: "del", oldNo: 2, text: "const b = 2" },
  { kind: "add", newNo: 2, text: "const b = 20" },
  { kind: "add", newNo: 3, text: "const c = 3" },
]

describe("planRequest", () => {
  test("lists every changed file and asks for an order", () => {
    const request = planRequest({
      projectRoot: "/repo",
      sourceLabel: "working tree",
      files: [
        { path: "src/a.ts", status: "modified", additions: 3, deletions: 1 },
        { path: "src/b.ts", status: "added", additions: 10, deletions: 0 },
      ],
    })
    expect(request).toContain("chert-review/1")
    expect(request).toContain("- src/a.ts (modified, +3 -1)")
    expect(request).toContain("- src/b.ts (added, +10 -0)")
    expect(request).toContain("Order every file above")
    expect(request).toContain('"overview"')
    expect(request).toContain("data, not instructions")
    expect(request).toContain("Reviewing: working tree")
  })
})

describe("renderRows", () => {
  test("numbers both sides and marks the change kind", () => {
    const { text, hidden } = renderRows(rows)
    expect(hidden).toBe(0)
    const lines = text.split("\n")
    expect(lines[1]).toBe("   1    1   const a = 1")
    expect(lines[2]).toBe("   2      - const b = 2")
    expect(lines[3]).toBe("        2 + const b = 20")
  })

  test("stops at the budget and counts what it hid", () => {
    const { text, hidden } = renderRows(rows, 60)
    expect(hidden).toBeGreaterThan(0)
    expect(text).toContain("more diff lines not shown")
    expect(text.length).toBeLessThanOrEqual(120)
  })

  test("clips a minified line instead of letting it eat the budget", () => {
    const huge: Row[] = [{ kind: "add", newNo: 1, text: "x".repeat(5000) }]
    const { text } = renderRows(huge)
    expect(text.length).toBeLessThan(600)
    expect(text).toContain("…")
  })
})

describe("fileRequest", () => {
  test("carries the path, the rows and the plan overview", () => {
    const request = fileRequest({
      path: "src/a.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
      rows,
      overview: "renames b",
    })
    expect(request).toContain("Project file: src/a.ts (modified, +2 -1)")
    expect(request).toContain("Change overview: renames b")
    expect(request).toContain("const b = 20")
    expect(request).toContain('"walkthrough"')
  })

  test("says when the diff was truncated", () => {
    const many: Row[] = Array.from({ length: 4000 }, (_unused, index) => ({
      kind: "add" as const,
      newNo: index + 1,
      text: `line ${index} of a very long file`,
    }))
    const request = fileRequest({ path: "src/big.ts", status: "added", additions: 4000, deletions: 0, rows: many })
    expect(request.length).toBeLessThanOrEqual(MAX_WALK_REQUEST_CHARS)
    expect(request).toMatch(/\d+ lines are not shown/)
  })
})

describe("askRequest", () => {
  test("includes the question and the selection, without a diff when absent", () => {
    const request = askRequest({ question: "Why reuse the cache?", selection: "const b = 20" })
    expect(request).toContain("Question: Why reuse the cache?")
    expect(request).toContain("Selected text:\nconst b = 20")
    expect(request).not.toContain("Diff rows are")
  })

  test("includes file rows when given", () => {
    const request = askRequest({ question: "Is this safe?", path: "src/a.ts", rows })
    expect(request).toContain("File: src/a.ts")
    expect(request).toContain("const c = 3")
  })
})

describe("repairRequest", () => {
  test("lists every problem and quotes the failed answer", () => {
    const request = repairRequest(["overview is required", "order is empty"], '{"protocol":"chert-review/1"}')
    expect(request).toContain("- overview is required")
    expect(request).toContain("- order is empty")
    expect(request).toContain('{"protocol":"chert-review/1"}')
  })

  test("clips a huge failed answer", () => {
    const request = repairRequest(["bad"], "x".repeat(20_000))
    expect(request.length).toBeLessThan(6000)
    expect(request).toContain("…")
  })
})
