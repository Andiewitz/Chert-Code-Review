import { describe, expect, test } from "bun:test"
import { parsePatch } from "./diffrows"
import { parseAgentHighlights } from "./highlights"

/** Wrap the agent's highlight JSON in the fenced block chert looks for. */
function answerWith(entries: unknown[]): string {
  return `Here is what I think.\n\`\`\`chert-highlights\n${JSON.stringify(entries)}\n\`\`\`\n`
}

describe("parseAgentHighlights", () => {
  test("validates each file against its own diff, not the open one", () => {
    // a.ts has two lines, b.ts has four. A highlight on b.ts line 3 must be
    // accepted even though a.ts never reaches line 3.
    const rowsA = parsePatch("@@ -1,2 +1,2 @@\n+const a1 = 1\n+const a2 = 2\n")
    const rowsB = parsePatch(
      "@@ -1,4 +1,4 @@\n+const b1 = 1\n+const b2 = 2\n+const b3 = 3\n+const b4 = 4\n",
    )
    const rowsByFile: Record<string, ReturnType<typeof parsePatch>> = { "a.ts": rowsA, "b.ts": rowsB }

    const result = parseAgentHighlights(
      answerWith([{ file: "b.ts", side: "new", start: 3, end: 3, level: "high", note: "watch this" }]),
      ["a.ts", "b.ts"],
      (file) => rowsByFile[file],
      [],
    )

    expect(result.skipped).toEqual([])
    expect(result.highlights).toHaveLength(1)
    expect(result.highlights[0].path).toBe("b.ts")
    expect(result.highlights[0].text).toEqual(["const b3 = 3"])
  })

  test("skips a file the caller has no rows for", () => {
    const result = parseAgentHighlights(
      answerWith([{ file: "gone.ts", side: "new", start: 1, end: 1, level: "low", note: "x" }]),
      ["gone.ts"],
      () => undefined,
      [],
    )
    expect(result.highlights).toEqual([])
    expect(result.skipped).toEqual(["no rows for gone.ts"])
  })
})

/** A patch with `count` numbered lines so line N is always addressable. */
function numberedPatch(count: number): ReturnType<typeof parsePatch> {
  const body = Array.from({ length: count }, (_, i) => `+line ${i + 1}`).join("\n")
  return parsePatch(`@@ -1,${count} +1,${count} @@\n${body}\n`)
}

const fourLines = () => numberedPatch(4)

describe("parseAgentHighlights validation", () => {
  test("rejects an unknown level", () => {
    const result = parseAgentHighlights(
      answerWith([{ file: "a.ts", start: 1, end: 1, level: "critical", note: "x" }]),
      ["a.ts"],
      fourLines,
      [],
    )
    expect(result.highlights).toEqual([])
    expect(result.skipped).toEqual(["invalid level"])
  })

  test("rejects a range that is not consecutive in the diff", () => {
    const rows = parsePatch("@@ -1,3 +1,3 @@\n+one\n+two\n+three\n")
    const result = parseAgentHighlights(
      answerWith([{ file: "a.ts", start: 1, end: 3, level: "low", note: "x" }]),
      ["a.ts"],
      () => rows.slice(0, 2),
      [],
    )
    expect(result.highlights).toEqual([])
    expect(result.skipped).toEqual(["line out of range: a.ts:1-3"])
  })

  test("rejects a duplicate of an existing highlight", () => {
    const existing = [
      {
        id: "old",
        path: "a.ts",
        side: "new" as const,
        start: 2,
        end: 2,
        text: [],
        before: [],
        after: [],
        by: "you" as const,
        level: "note" as const,
        note: "",
        createdAt: 0,
      },
    ]
    const result = parseAgentHighlights(
      answerWith([{ file: "a.ts", start: 2, end: 2, level: "high", note: "x" }]),
      ["a.ts"],
      fourLines,
      existing,
    )
    expect(result.highlights).toEqual([])
    expect(result.skipped).toEqual(["duplicate: a.ts:2-2"])
  })

  test("keeps the highest levels and remembers the rest as over cap", () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      file: "a.ts",
      start: i + 1,
      end: i + 1,
      level: i === 9 ? "low" : "high",
      note: `note ${i + 1}`,
    }))
    const result = parseAgentHighlights(answerWith(entries), ["a.ts"], () => numberedPatch(10), [])
    expect(result.highlights).toHaveLength(8)
    expect(result.highlights.every((h) => h.level === "high")).toBe(true)
    expect(result.skipped).toEqual(["2 over cap"])
  })

  test("gives every highlight a unique id, even within one millisecond", () => {
    const entries = Array.from({ length: 4 }, (_, i) => ({
      file: "a.ts",
      start: i + 1,
      end: i + 1,
      level: "medium",
      note: `n${i}`,
    }))
    const first = parseAgentHighlights(answerWith(entries), ["a.ts"], fourLines, [])
    const second = parseAgentHighlights(answerWith(entries), ["a.ts"], fourLines, [])
    const ids = [...first.highlights, ...second.highlights].map((h) => h.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => id.startsWith("ai-"))).toBe(true)
  })
})
