import { describe, expect, test } from "bun:test"
import { parseModelList, recommendOpencodeModel } from "./opencode-models"

describe("parseModelList", () => {
  test("keeps the built-in opencode models first and drops duplicates", () => {
    const stdout = [
      "openrouter/x",
      "opencode/big-pickle",
      "opencode/beam-free",
      "opencode/big-pickle",
      "",
    ].join("\n")
    expect(parseModelList(stdout)).toEqual(["opencode/big-pickle", "opencode/beam-free", "openrouter/x"])
  })

  test("accepts a JSON array of ids or objects", () => {
    expect(parseModelList(JSON.stringify(["openrouter/x", "opencode/a"]))).toEqual([
      "opencode/a",
      "openrouter/x",
    ])
    expect(
      parseModelList(JSON.stringify({ models: [{ id: "openrouter/x" }, { id: "opencode/a" }] })),
    ).toEqual(["opencode/a", "openrouter/x"])
  })

  test("returns nothing for empty output", () => {
    expect(parseModelList("")).toEqual([])
    expect(parseModelList("  \n ")).toEqual([])
  })
})

describe("recommendOpencodeModel", () => {
  test("prefers a built-in free model, then any built-in, then the first id", () => {
    expect(recommendOpencodeModel(["openrouter/x", "opencode/big-pickle", "opencode/beam-free"])).toBe(
      "opencode/beam-free",
    )
    expect(recommendOpencodeModel(["openrouter/x", "opencode/big-pickle"])).toBe("opencode/big-pickle")
    expect(recommendOpencodeModel(["openrouter/x", "openrouter/y"])).toBe("openrouter/x")
  })

  test("never suggests the model that just failed", () => {
    expect(recommendOpencodeModel(["opencode/beam-free", "opencode/big-pickle"], "opencode/beam-free")).toBe(
      "opencode/big-pickle",
    )
    expect(recommendOpencodeModel(["opencode/beam-free"], "opencode/beam-free")).toBeUndefined()
    expect(recommendOpencodeModel([], "anything")).toBeUndefined()
  })
})
