import { describe, expect, test } from "bun:test"
import {
  COMMAND_DEFS,
  HELP_TEXT,
  closestCommand,
  commandToSuggestion,
  isCloseAutocorrect,
  resolveCommand,
  scoreCommand,
} from "./registry"

describe("resolveCommand", () => {
  test("finds commands by name and by alias", () => {
    expect(resolveCommand("help")?.name).toBe("help")
    expect(resolveCommand("HELP")?.name).toBe("help")
    expect(resolveCommand("q")?.name).toBe("quit")
    expect(resolveCommand("exit")?.name).toBe("quit")
  })

  test("returns undefined for unknown tokens", () => {
    expect(resolveCommand("nonsense")).toBeUndefined()
  })
})

describe("scoreCommand", () => {
  const help = COMMAND_DEFS.find((def) => def.name === "help")!
  const review = COMMAND_DEFS.find((def) => def.name === "review")!

  test("ranks exact above prefix above substring", () => {
    expect(scoreCommand(help, "help")).toBe(100)
    expect(scoreCommand(review, "rev")).toBe(80)
    expect(scoreCommand(review, "view")).toBe(50)
  })

  test("scores everything equally for an empty query", () => {
    expect(scoreCommand(review, "")).toBe(1)
  })

  test("scores unrelated text as zero", () => {
    expect(scoreCommand(help, "zzz")).toBe(0)
  })
})

describe("closestCommand / isCloseAutocorrect", () => {
  test("suggests the nearest command for a typo", () => {
    expect(closestCommand("hep")?.name).toBe("help")
  })

  test("autocorrects a one-letter typo and a close longer one", () => {
    expect(isCloseAutocorrect("hep", resolveCommand("help")!)).toBe(true)
    expect(isCloseAutocorrect("hlp", resolveCommand("help")!)).toBe(true)
  })

  test("does not autocorrect an unrelated token", () => {
    expect(isCloseAutocorrect("deploy", resolveCommand("help")!)).toBe(false)
    expect(isCloseAutocorrect("zzzzzz", resolveCommand("help")!)).toBe(false)
  })
})

describe("commandToSuggestion", () => {
  test("marks commands that take an argument with a trailing space", () => {
    expect(commandToSuggestion(resolveCommand("open")!).insert).toBe("/open ")
    expect(commandToSuggestion(resolveCommand("help")!).insert).toBe("/help")
  })

  test("shows aliases in the label", () => {
    expect(commandToSuggestion(resolveCommand("quit")!).label).toBe("/quit (exit, q)")
  })
})

describe("HELP_TEXT", () => {
  test("lists every command's usage", () => {
    for (const def of COMMAND_DEFS) {
      expect(HELP_TEXT).toContain(def.usage)
    }
  })
})
