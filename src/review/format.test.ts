import { describe, expect, test } from "bun:test"
import { analysisText } from "./format"
import type { WalkFileResult } from "./walk"

function result(overrides: Partial<WalkFileResult["analysis"]> = {}, dropped = 0): WalkFileResult {
  return {
    analysis: {
      path: "a.ts",
      intent: "rename b",
      summary: "one value changed",
      walkthrough: [],
      concerns: [],
      assumptions: [],
      questions: [],
      ...overrides,
    },
    highlights: [],
    dropped,
  }
}

describe("analysisText", () => {
  test("leads with intent and summary", () => {
    expect(analysisText(result())).toBe("rename b\none value changed")
  })

  test("labels every section and its lines", () => {
    const text = analysisText(
      result(
        {
          walkthrough: [
            { anchor: { side: "new", start: 2, end: 2, quote: "const b = 20" }, explanation: "the new value" },
          ],
          concerns: [
            { anchor: { side: "old", start: 2, end: 4, quote: "old" }, level: "high", note: "check the default" },
          ],
          assumptions: ["b is unused"],
          questions: ["why 20?"],
        },
        2,
      ),
    )
    expect(text).toContain("Walkthrough:\n- L2: the new value")
    expect(text).toContain("Concerns:\n- high L2-4 old: check the default")
    expect(text).toContain("Assumptions:\n- b is unused")
    expect(text).toContain("Questions for you:\n- why 20?")
    expect(text).toContain("(2 notes dropped: the line did not match the diff)")
  })

  test("says nothing about dropped notes when none were", () => {
    expect(analysisText(result())).not.toContain("dropped")
  })
})
