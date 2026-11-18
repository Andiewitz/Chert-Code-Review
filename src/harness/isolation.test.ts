// A guard the docs promise: no adapter may hand a harness the power to change
// the repo without asking. The check is a source scan because the strings are
// flag names, and one accidental `--auto` would silently undo the tree guard.

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/** Flags that let a harness edit or run without approval. */
const FORBIDDEN = [
  "dangerously-skip-permissions",
  "--auto",
  "bypassPermissions",
  "acceptEdits",
  "dangerously-bypass-approvals-and-sandbox",
]

const ADAPTERS = ["opencode.ts", "claude.ts"].map((name) => join(import.meta.dir, name))

describe("harness isolation", () => {
  test("the adapter directory holds only the files this check knows about", () => {
    const sources = readdirSync(import.meta.dir).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    )
    expect(sources.sort()).toEqual(["claude.ts", "fake.ts", "opencode.ts", "process.ts", "types.ts"])
  })

  test.each(ADAPTERS)("%s never passes an auto-approve flag", (path) => {
    const source = readFileSync(path, "utf8")
    for (const flag of FORBIDDEN) {
      expect(source.includes(flag)).toBe(false)
    }
  })
})
