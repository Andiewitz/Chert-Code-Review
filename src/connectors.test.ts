import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  clearConnectorModel,
  clearProviderKey,
  getActive,
  saveProviderKey,
  setActive,
  storedModel,
} from "./connectors"

let dir: string
let previous: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chert-connectors-"))
  previous = process.env.CHERT_CONFIG_DIR
  process.env.CHERT_CONFIG_DIR = dir
})

afterEach(() => {
  if (previous === undefined) delete process.env.CHERT_CONFIG_DIR
  else process.env.CHERT_CONFIG_DIR = previous
  rmSync(dir, { recursive: true, force: true })
})

describe("active connector models", () => {
  test("defaults to opencode with no model", () => {
    expect(getActive()).toEqual({ connector: "opencode" })
  })

  test("remembers a model per connector across switches", () => {
    setActive("opencode", "opencode/big-pickle")
    expect(getActive()).toEqual({ connector: "opencode", model: "opencode/big-pickle" })

    saveProviderKey("groq", "gsk-test")
    setActive("groq", "llama-3.3-70b-versatile")
    expect(getActive()).toEqual({ connector: "groq", model: "llama-3.3-70b-versatile" })
    // opencode's pin is still there, even while another connector is active.
    expect(storedModel("opencode")).toBe("opencode/big-pickle")

    expect(setActive("opencode")).toEqual({ connector: "opencode", model: "opencode/big-pickle" })
  })

  test("trims a model and ignores an empty one", () => {
    expect(setActive("opencode", "  opencode/beam-free  ")).toEqual({
      connector: "opencode",
      model: "opencode/beam-free",
    })
    expect(setActive("opencode", "   ")).toEqual({ connector: "opencode", model: "opencode/beam-free" })
  })

  test("honors and migrates a legacy active.model from before per-connector storage", () => {
    writeFileSync(
      join(dir, "connectors.json"),
      JSON.stringify({ active: { connector: "opencode", model: "opencode/legacy" } }),
    )
    expect(getActive()).toEqual({ connector: "opencode", model: "opencode/legacy" })
    expect(storedModel("opencode")).toBe("opencode/legacy")

    // Switching away must keep it; switching back must find it again.
    setActive("groq", "llama-3.3-70b-versatile")
    expect(storedModel("opencode")).toBe("opencode/legacy")
    expect(setActive("opencode")).toEqual({ connector: "opencode", model: "opencode/legacy" })
  })

  test("clears only the named connector's model", () => {
    setActive("opencode", "opencode/big-pickle")
    saveProviderKey("groq", "gsk-test")
    setActive("groq", "llama-3.3-70b-versatile")

    expect(clearConnectorModel("opencode")).toBe(true)
    expect(storedModel("opencode")).toBeUndefined()
    // Clearing an inactive connector must not disturb the active model.
    expect(getActive()).toEqual({ connector: "groq", model: "llama-3.3-70b-versatile" })

    expect(clearConnectorModel("opencode")).toBe(false)
    expect(clearConnectorModel("groq")).toBe(true)
    expect(getActive()).toEqual({ connector: "groq" })
  })

  test("clearing the active connector's model leaves it active and unpinned", () => {
    setActive("opencode", "opencode/big-pickle")
    expect(clearConnectorModel("opencode")).toBe(true)
    expect(getActive()).toEqual({ connector: "opencode" })
  })
})

describe("provider keys", () => {
  test("saving and clearing a key leaves model memory alone", () => {
    setActive("groq", "llama-3.3-70b-versatile")
    saveProviderKey("groq", "gsk-test")
    clearProviderKey("groq")
    expect(getActive()).toEqual({ connector: "groq", model: "llama-3.3-70b-versatile" })
  })
})
