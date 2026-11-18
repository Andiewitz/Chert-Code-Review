import { describe, expect, test } from "bun:test"
import { PROTOCOL, jsonSchemaFor, parseModelJson, validateAsk, validateFile, validatePlan } from "./protocol"

const base = { protocol: PROTOCOL }

const file = {
  ...base,
  path: "src/a.ts",
  intent: "Serve the new retry setting from config",
  summary: "Adds a retry limit and passes it to the client.",
  walkthrough: [
    { anchor: { side: "new", start: 3, end: 3, quote: "export const retries = 3" }, explanation: "The limit." },
  ],
  concerns: [
    {
      anchor: { side: "new", start: 3, end: 3, quote: "export const retries = 3" },
      level: "medium",
      note: "No upper bound; a caller can ask for a million retries.",
    },
  ],
  assumptions: ["Retries are counted per request."],
  questions: ["Should this come from the environment?"],
}

describe("validatePlan", () => {
  test("accepts a valid plan", () => {
    const result = validatePlan({ ...base, overview: "One setting changed.", order: [{ path: "a.ts", reason: "first" }] })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.order[0].path).toBe("a.ts")
  })

  test("ignores unknown fields", () => {
    const result = validatePlan({ ...base, overview: "ok", order: [{ path: "a.ts", reason: "r", confidence: 0.4 }], mood: "happy" })
    expect(result.ok).toBe(true)
  })

  test("reports a missing overview and an empty order", () => {
    const result = validatePlan({ ...base, order: [] })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toContain("overview is required")
      expect(result.errors).toContain("order is empty")
    }
  })

  test("rejects a different protocol version", () => {
    const result = validatePlan({ protocol: "chert-review/2", overview: "x", order: [{ path: "a", reason: "" }] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toContain("chert-review/1")
  })

  test("accepts a missing protocol as version 1", () => {
    const result = validatePlan({ overview: "x", order: [{ path: "a", reason: "" }] })
    expect(result.ok).toBe(true)
  })
})

describe("validateFile", () => {
  test("accepts a valid file analysis", () => {
    const result = validateFile(file)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.concerns).toHaveLength(1)
      expect(result.value.walkthrough[0].anchor.quote).toBe("export const retries = 3")
    }
  })

  test("keeps only the first line of a multi-line quote", () => {
    const result = validateFile({
      ...file,
      concerns: [{ ...file.concerns[0], anchor: { ...file.concerns[0].anchor, quote: "line one\nline two" } }],
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.concerns[0].anchor.quote).toBe("line one")
  })

  test("clips a note instead of rejecting it", () => {
    const result = validateFile({ ...file, concerns: [{ ...file.concerns[0], note: "x".repeat(400) }] })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.concerns[0].note).toHaveLength(200)
  })

  test("rejects more than 8 concerns", () => {
    const concerns = Array.from({ length: 9 }, () => file.concerns[0])
    const result = validateFile({ ...file, concerns })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join(" ")).toContain("max 8")
  })

  test("rejects a range longer than 30 lines", () => {
    const result = validateFile({
      ...file,
      concerns: [{ ...file.concerns[0], anchor: { side: "new", start: 1, end: 31, quote: "x" } }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join(" ")).toContain("max 30")
  })

  test("rejects an invalid level and a bad line range", () => {
    const result = validateFile({
      ...file,
      concerns: [{ anchor: { side: "new", start: 4, end: 2, quote: "x" }, level: "urgent", note: "n" }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("end >= start")
      expect(result.errors.join(" ")).toContain("high, medium or low")
    }
  })

  test("requires intent and path", () => {
    const result = validateFile({ ...base, summary: "s" })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toContain("path is required")
      expect(result.errors).toContain("intent is required")
    }
  })
})

describe("validateAsk", () => {
  test("accepts prose without anchors", () => {
    const result = validateAsk({ ...base, text: "This is fine." })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.anchors).toEqual([])
  })

  test("keeps valid anchors and rejects broken ones", () => {
    const result = validateAsk({
      ...base,
      text: "Two things.",
      anchors: [{ side: "old", start: 2, end: 2, quote: "gone" }, { side: "new", start: 0, end: 0, quote: "x" }],
    })
    expect(result.ok).toBe(false)
  })

  test("requires text", () => {
    expect(validateAsk({ ...base }).ok).toBe(false)
  })
})

describe("parseModelJson", () => {
  test("reads a fenced block surrounded by prose", () => {
    const result = parseModelJson('Here you go.\n```json\n{"a": 1}\n```\nDone.')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ a: 1 })
  })

  test("reads a bare object with leading prose", () => {
    const result = parseModelJson('answer: {"a": [1, 2]} thanks')
    expect(result.ok).toBe(true)
  })

  test("reports invalid JSON", () => {
    const result = parseModelJson("not json at all")
    expect(result.ok).toBe(false)
  })
})

describe("jsonSchemaFor", () => {
  test("describes the protocol and required fields", () => {
    const schema = jsonSchemaFor("file") as Record<string, any>
    expect(schema.required).toContain("protocol")
    expect(schema.properties.concerns.items.required).toEqual(["anchor", "level", "note"])
  })

  test("has a distinct shape per request type", () => {
    expect((jsonSchemaFor("plan") as Record<string, any>).required).toContain("order")
    expect((jsonSchemaFor("ask") as Record<string, any>).required).toContain("text")
  })
})
