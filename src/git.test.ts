import { describe, expect, test } from "bun:test"
import { emptyTreeId, run } from "./git"

// git's well-known empty tree object id.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

describe("run", () => {
  test("refuses commands outside the read-only allowlist", () => {
    expect(() => run(["commit", "-m", "nope"])).toThrow("git: command not allowed: commit")
    expect(() => run(["push"])).toThrow("git: command not allowed: push")
  })

  test("refuses an empty argument list", () => {
    expect(() => run([])).toThrow("git: no command given")
  })
})

describe("emptyTreeId", () => {
  test("returns git's empty tree id through the allowlisted helper", () => {
    expect(emptyTreeId()).toBe(EMPTY_TREE)
  })
})
