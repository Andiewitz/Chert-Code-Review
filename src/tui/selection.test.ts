import { describe, expect, test } from "bun:test"
import type { Row } from "../diffrows"
import { highlightFromRows, rowsUnderDrag } from "./selection"

const box = { x: 30, y: 5, width: 60, height: 10 }

const row = (kind: Row["kind"], text: string, newNo?: number, oldNo?: number): Row => ({
  kind,
  text,
  newNo,
  oldNo,
})

describe("rowsUnderDrag", () => {
  test("maps the vertical span of a drag onto rows", () => {
    const range = rowsUnderDrag({
      box,
      scrollTop: 0,
      rowCount: 40,
      anchor: { x: 40, y: 7 },
      focus: { x: 55, y: 9 },
    })
    expect(range).toEqual({ start: 2, end: 4 })
  })

  test("counts rows hidden above the viewport", () => {
    const range = rowsUnderDrag({
      box,
      scrollTop: 12,
      rowCount: 40,
      anchor: { x: 40, y: 12 },
      focus: { x: 40, y: 5 },
    })
    expect(range).toEqual({ start: 12, end: 19 })
  })

  test("ignores a drag that starts in the file list", () => {
    const range = rowsUnderDrag({
      box,
      scrollTop: 0,
      rowCount: 40,
      anchor: { x: 10, y: 7 },
      focus: { x: 50, y: 9 },
    })
    expect(range).toBeNull()
  })

  test("ignores a drag outside the box and an empty diff", () => {
    expect(
      rowsUnderDrag({
        box,
        scrollTop: 0,
        rowCount: 40,
        anchor: { x: 40, y: 40 },
        focus: { x: 40, y: 42 },
      }),
    ).toBeNull()
    expect(
      rowsUnderDrag({
        box,
        scrollTop: 0,
        rowCount: 0,
        anchor: { x: 40, y: 6 },
        focus: { x: 40, y: 8 },
      }),
    ).toBeNull()
  })

  test("stops at the last visible row when the drag leaves the box", () => {
    const range = rowsUnderDrag({
      box,
      scrollTop: 0,
      rowCount: 40,
      anchor: { x: 40, y: 8 },
      focus: { x: 40, y: 25 },
    })
    expect(range).toEqual({ start: 3, end: 9 })
  })

  test("stops at the last row of a short diff", () => {
    const range = rowsUnderDrag({
      box,
      scrollTop: 0,
      rowCount: 6,
      anchor: { x: 40, y: 8 },
      focus: { x: 40, y: 14 },
    })
    expect(range).toEqual({ start: 3, end: 5 })
  })
})

describe("highlightFromRows", () => {
  const rows: Row[] = [
    row("meta", "diff --git a/src/a.ts b/src/a.ts"),
    row("hunk", "@@ -1 +1,3 @@"),
    row("context", "export const a = 1", 1, 1),
    row("add", "export const b = 2", 2),
    row("add", "export const c = 3", 3),
    row("hunk", "@@ -9 +9 @@"),
    row("del", "export const gone = 4", undefined, 9),
    row("add", "export const next = 5", 9),
  ]

  test("builds a new-side highlight with its context", () => {
    const result = highlightFromRows(rows, 2, 3, "src/a.ts")
    if (!result.ok) throw new Error(result.reason)
    expect(result.highlight.side).toBe("new")
    expect(result.highlight.start).toBe(1)
    expect(result.highlight.end).toBe(2)
    expect(result.highlight.text).toEqual(["export const a = 1", "export const b = 2"])
    expect(result.highlight.before).toEqual(["diff --git a/src/a.ts b/src/a.ts", "@@ -1 +1,3 @@"])
    expect(result.highlight.after).toEqual(["export const c = 3", "@@ -9 +9 @@"])
    expect(result.highlight.by).toBe("you")
    expect(result.highlight.note).toBe("")
  })

  test("builds an old-side highlight for deleted lines", () => {
    const result = highlightFromRows(rows, 6, 6, "src/a.ts")
    if (!result.ok) throw new Error(result.reason)
    expect(result.highlight.side).toBe("old")
    expect(result.highlight.start).toBe(9)
  })

  test("refuses a range that starts on a header", () => {
    expect(highlightFromRows(rows, 0, 0, "src/a.ts")).toEqual({
      ok: false,
      reason: "Move to a code line to highlight.",
    })
  })

  test("refuses a range that crosses a hunk header", () => {
    expect(highlightFromRows(rows, 3, 6, "src/a.ts")).toEqual({
      ok: false,
      reason: "Highlight range cannot cross a hunk header.",
    })
  })

  test("refuses a range that mixes both sides", () => {
    expect(highlightFromRows(rows, 6, 7, "src/a.ts")).toEqual({
      ok: false,
      reason: "Highlight range cannot mix old and new sides.",
    })
  })
})
