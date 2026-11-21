import { describe, expect, test } from "bun:test"
import { truncateMiddle } from "./format"

describe("truncateMiddle", () => {
  test("leaves text that fits alone", () => {
    expect(truncateMiddle("short message", 40)).toBe("short message")
  })

  test("keeps the subject and the advice at the end", () => {
    const text = `No project or folder called "x". ${"detail ".repeat(30)}Type /cd alone to see your saved projects.`
    const out = truncateMiddle(text, 60)
    expect(out.length).toBeLessThanOrEqual(61)
    expect(out.startsWith("No project or folder called")).toBe(true)
    expect(out.endsWith("your saved projects.")).toBe(true)
    expect(out.includes("\u2026")).toBe(true)
  })
})
