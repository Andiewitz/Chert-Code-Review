import { describe, expect, test } from "bun:test"
import { listWindow } from "./drop-up"

const rows = Array.from({ length: 10 }, (_, i) => ({ label: `Row ${i}` }))
const labels = (window: { rows: { label: string }[] }) => window.rows.map((row) => row.label)

describe("listWindow", () => {
  test("returns the whole list when it fits", () => {
    const window = listWindow(rows.slice(0, 4), 2, 6)
    expect(labels(window)).toEqual(["Row 0", "Row 1", "Row 2", "Row 3"])
    expect(window.index).toBe(2)
  })

  test("keeps the selection inside a short window near the end", () => {
    const window = listWindow(rows, 9, 4)
    expect(labels(window)).toEqual(["Row 6", "Row 7", "Row 8", "Row 9"])
    expect(window.index).toBe(3)
  })

  test("scrolls one row at a time past the bottom edge", () => {
    expect(listWindow(rows, 0, 4).index).toBe(0)
    expect(labels(listWindow(rows, 3, 4))).toEqual(["Row 0", "Row 1", "Row 2", "Row 3"])
    expect(labels(listWindow(rows, 4, 4))).toEqual(["Row 1", "Row 2", "Row 3", "Row 4"])
    expect(listWindow(rows, 4, 4).index).toBe(3)
  })

  test("clamps an out-of-range selection", () => {
    expect(listWindow(rows, 99, 4).index).toBe(3)
    expect(labels(listWindow(rows, 99, 4))).toEqual(["Row 6", "Row 7", "Row 8", "Row 9"])
    expect(listWindow(rows, -3, 4).index).toBe(0)
  })

  test("always shows at least one row", () => {
    expect(labels(listWindow(rows, 5, 0))).toEqual(["Row 5"])
  })
})
