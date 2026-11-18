import { describe, expect, test } from "bun:test"
import { parsePatch } from "./diffrows"

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " const one = 1",
  "-const two = 2",
  "+const two = 22",
  "+const three = 3",
  " const four = 4",
  "",
].join("\n")

describe("parsePatch", () => {
  test("returns no rows for an empty patch", () => {
    expect(parsePatch("")).toEqual([])
  })

  test("classifies header lines as meta rows", () => {
    const rows = parsePatch(PATCH)
    expect(rows.slice(0, 4).map((row) => row.kind)).toEqual(["meta", "meta", "meta", "meta"])
  })

  test("numbers context, deleted and added lines on both sides", () => {
    const rows = parsePatch(PATCH).filter((row) => row.kind !== "meta")
    expect(rows.map((row) => [row.kind, row.oldNo, row.newNo, row.text])).toEqual([
      ["hunk", 1, 1, "@@ -1,3 +1,4 @@"],
      ["context", 1, 1, "const one = 1"],
      ["del", 2, undefined, "const two = 2"],
      ["add", undefined, 2, "const two = 22"],
      ["add", undefined, 3, "const three = 3"],
      ["context", 3, 4, "const four = 4"],
    ])
  })

  test("advances past the first line for zero-length hunk sides", () => {
    const rows = parsePatch("@@ -0,0 +1,2 @@\n+a\n+b\n")
    expect(rows[0]).toEqual({ kind: "hunk", text: "@@ -0,0 +1,2 @@", oldNo: 1, newNo: 1 })
    expect(rows.filter((row) => row.kind === "add").map((row) => row.newNo)).toEqual([1, 2])
  })

  test("keeps the no-newline marker as a meta row", () => {
    const rows = parsePatch("@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n")
    expect(rows.at(-1)).toEqual({ kind: "meta", text: "\\ No newline at end of file" })
  })

  test("treats a binary patch as meta only", () => {
    const rows = parsePatch("diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n")
    expect(rows.every((row) => row.kind === "meta")).toBe(true)
    expect(rows).toHaveLength(2)
  })

  test("treats an empty added file as a hunk with no body", () => {
    const rows = parsePatch(
      "diff --git a/empty b/empty\nnew file mode 100644\n--- /dev/null\n+++ b/empty\n@@ -0,0 +0,0 @@\n",
    )
    expect(rows.at(-1)?.kind).toBe("hunk")
    expect(rows.some((row) => row.kind === "add")).toBe(false)
  })

  test("marks unparseable lines inside a hunk as meta", () => {
    const rows = parsePatch("@@ -1 +1 @@\n?weird\n")
    expect(rows[1]).toEqual({ kind: "meta", text: "?weird" })
  })
})
