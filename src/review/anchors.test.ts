import { describe, expect, test } from "bun:test"
import { parsePatch } from "../diffrows"
import { highlightFromAnchor, sideRows, verifyAnchor } from "./anchors"
import type { Anchor } from "./protocol"

const patch = [
  "diff --git a/a.ts b/a.ts",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,4 +1,5 @@",
  " one",
  "-two",
  "+two changed",
  "+three",
  " four",
  " five",
].join("\n")

const rows = parsePatch(patch)

function anchor(overrides: Partial<Anchor>): Anchor {
  return { side: "new", start: 1, end: 1, quote: "one", ...overrides }
}

describe("sideRows", () => {
  test("new side sees context and additions only", () => {
    const kinds = sideRows(rows, "new").map(({ row }) => row.kind)
    expect(kinds).toEqual(["context", "add", "add", "context", "context"])
  })

  test("old side sees context and deletions only", () => {
    const kinds = sideRows(rows, "old").map(({ row }) => row.kind)
    expect(kinds).toEqual(["context", "del", "context", "context"])
  })
})

describe("verifyAnchor", () => {
  test("uses the named line when the quote matches", () => {
    const verified = verifyAnchor(rows, anchor({ start: 2, end: 3, quote: "two changed" }))
    expect(verified).not.toBeNull()
    expect(verified!.relocated).toBe(false)
    expect(rows[verified!.startRow].text).toBe("two changed")
    expect(rows[verified!.endRow].text).toBe("three")
  })

  test("relocates when the quote matches exactly once", () => {
    const verified = verifyAnchor(rows, anchor({ start: 99, end: 99, quote: "four" }))
    expect(verified).not.toBeNull()
    expect(verified!.relocated).toBe(true)
    expect(rows[verified!.startRow].text).toBe("four")
    expect(rows[verified!.startRow].newNo).toBe(4)
  })

  test("drops an ambiguous quote", () => {
    const twice = parsePatch(
      ["@@ -1,2 +1,2 @@", " same", " same"].join("\n"),
    )
    expect(verifyAnchor(twice, anchor({ start: 9, end: 9, quote: "same" }))).toBeNull()
  })

  test("drops a quote that is not in the diff", () => {
    expect(verifyAnchor(rows, anchor({ start: 2, end: 2, quote: "not here" }))).toBeNull()
  })

  test("drops a range that runs past the end of the hunk", () => {
    const verified = verifyAnchor(rows, anchor({ start: 5, end: 8, quote: "five" }))
    // The quote is unique, so the anchor survives, but it shrinks to that line.
    expect(verified).not.toBeNull()
    expect(verified!.startRow).toBe(verified!.endRow)
  })

  test("matches the old side only against deletions and context", () => {
    expect(verifyAnchor(rows, anchor({ side: "old", start: 2, end: 2, quote: "two" }))).not.toBeNull()
    expect(verifyAnchor(rows, anchor({ side: "old", start: 2, end: 2, quote: "two changed" }))).toBeNull()
  })
})

describe("highlightFromAnchor", () => {
  test("stores resolved line numbers and context", () => {
    const verified = verifyAnchor(rows, anchor({ start: 99, end: 99, quote: "four" }))!
    const highlight = highlightFromAnchor(rows, "a.ts", anchor({ quote: "four" }), verified, "high", "check this")
    expect(highlight.path).toBe("a.ts")
    expect(highlight.start).toBe(4)
    expect(highlight.end).toBe(4)
    expect(highlight.text).toEqual(["four"])
    expect(highlight.before).toEqual(["two changed", "three"])
    expect(highlight.by).toBe("ai")
    expect(highlight.level).toBe("high")
    expect(highlight.id.startsWith("ai-")).toBe(true)
  })
})
