import { describe, expect, test } from "bun:test"
import { capHighlights } from "./highlights"
import type { Highlight } from "./highlights"

/** A highlight with only the fields the cap looks at. */
function highlight(id: string, by: Highlight["by"], createdAt: number): Highlight {
  return {
    id,
    path: "a.ts",
    side: "new",
    start: createdAt + 1,
    end: createdAt + 1,
    text: [],
    before: [],
    after: [],
    by,
    level: "note",
    note: "",
    createdAt,
  }
}

describe("capHighlights", () => {
  test("drops the oldest AI highlights to fit the cap and keeps every user highlight", () => {
    const user = Array.from({ length: 10 }, (_, i) => highlight(`you-${i}`, "you", i))
    const ai = Array.from({ length: 495 }, (_, i) => highlight(`ai-${i}`, "ai", 100 + i))
    const result = capHighlights([...user, ...ai], 500)

    expect(result.list).toHaveLength(500)
    expect(result.droppedAi).toBe(5)
    expect(result.overCap).toBe(false)
    expect(result.list.filter((h) => h.by === "you")).toHaveLength(10)
    // The five oldest AI entries are the ones that go.
    expect(result.list.some((h) => h.id === "ai-0")).toBe(false)
    expect(result.list.some((h) => h.id === "ai-5")).toBe(true)
  })

  test("drops nothing when user highlights alone exceed the cap", () => {
    const user = Array.from({ length: 510 }, (_, i) => highlight(`you-${i}`, "you", i))
    const ai = Array.from({ length: 5 }, (_, i) => highlight(`ai-${i}`, "ai", 1000 + i))
    const result = capHighlights([...user, ...ai], 500)

    expect(result.list).toHaveLength(515)
    expect(result.droppedAi).toBe(0)
    expect(result.overCap).toBe(true)
  })
})
