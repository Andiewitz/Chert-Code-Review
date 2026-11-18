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
