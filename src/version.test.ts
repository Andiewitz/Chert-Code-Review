import { describe, expect, test } from "bun:test"
import packageJson from "../package.json" with { type: "json" }
import { VERSION } from "./version"

describe("VERSION", () => {
  test("matches package.json", () => {
    expect(VERSION).toBe(packageJson.version)
  })

  test("is a plain semver string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })
})
