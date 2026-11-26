import { describe, expect, test } from "bun:test"
import { parseWalkArg } from "./walk"

describe("parseWalkArg", () => {
  test("no argument asks for the newest session", () => {
    expect(parseWalkArg("")).toEqual({})
    expect(parseWalkArg("   ")).toEqual({})
  })

  test("fresh starts without author context", () => {
    expect(parseWalkArg("fresh")).toEqual({ fresh: true })
  })

  test("anything else is a session id", () => {
    expect(parseWalkArg("ses_abc123")).toEqual({ sessionId: "ses_abc123" })
  })

  test("opencode names the harness with or without a model", () => {
    expect(parseWalkArg("opencode")).toEqual({ harness: "opencode" })
    expect(parseWalkArg("opencode opencode/big-pickle")).toEqual({
      harness: "opencode",
      model: "opencode/big-pickle",
    })
  })
})
