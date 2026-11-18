import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { configDir, readJson, writeJsonAtomic } from "./config"

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chert-config-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.CHERT_CONFIG_DIR
})

describe("configDir", () => {
  test("honours CHERT_CONFIG_DIR", () => {
    process.env.CHERT_CONFIG_DIR = "/tmp/chert-test-config"
    expect(configDir()).toBe("/tmp/chert-test-config")
  })
})

describe("writeJsonAtomic", () => {
  test("creates parent directories and writes pretty JSON with a trailing newline", () => {
    const path = join(tempDir(), "nested", "deep", "file.json")
    writeJsonAtomic(path, { a: 1 })
    expect(readFileSync(path, "utf8")).toBe('{\n  "a": 1\n}\n')
  })

  test("replaces an existing document without leaving temp files", () => {
    const dir = tempDir()
    const path = join(dir, "file.json")
    writeFileSync(path, "old")
    writeJsonAtomic(path, { replaced: true })
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ replaced: true })
    expect(readdirSync(dir)).toEqual(["file.json"])
  })

  test("applies the requested mode to secrets from the moment they exist", () => {
    const path = join(tempDir(), "connectors.json")
    writeJsonAtomic(path, { key: "secret" }, { mode: 0o600 })
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})

describe("readJson", () => {
  test("returns undefined for missing or malformed files", () => {
    const dir = tempDir()
    expect(readJson(join(dir, "missing.json"))).toBeUndefined()
    writeFileSync(join(dir, "bad.json"), "{not json")
    expect(readJson(join(dir, "bad.json"))).toBeUndefined()
  })
})
