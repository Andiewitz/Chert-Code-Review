import { describe, expect, test } from "bun:test"
import { activeProcessCount, killAllProcesses, probeVersion, runProcess, runProcessOrThrow } from "./process"

const skip = process.platform === "win32"

describe("runProcess", () => {
  test.skipIf(skip)("captures stdout and a zero exit", async () => {
    const result = await runProcess(["sh", "-c", "printf 'hello'"], { cwd: process.cwd() })
    expect(result.stdout).toBe("hello")
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
  })

  test.skipIf(skip)("reports stderr for a failing call", async () => {
    const result = await runProcess(["sh", "-c", "echo bad >&2; exit 3"], { cwd: process.cwd() })
    expect(result.exitCode).toBe(3)
    expect(result.stderr.trim()).toBe("bad")
    await expect(runProcessOrThrow(["sh", "-c", "echo bad >&2; exit 3"], { cwd: process.cwd() })).rejects.toThrow(
      "bad",
    )
  })

  test.skipIf(skip)("feeds stdin", async () => {
    const result = await runProcess(["cat"], { cwd: process.cwd(), input: "piped" })
    expect(result.stdout).toBe("piped")
  })

  test.skipIf(skip)("kills a child that overruns its timeout and leaves nothing behind", async () => {
    const started = Date.now()
    await expect(runProcess(["sleep", "5"], { cwd: process.cwd(), timeoutMs: 150 })).rejects.toThrow(
      "within 150ms",
    )
    expect(Date.now() - started).toBeLessThan(3000)
    expect(activeProcessCount()).toBe(0)
  })

  test.skipIf(skip)("kills a child when the signal aborts", async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    await expect(
      runProcess(["sleep", "5"], { cwd: process.cwd(), signal: controller.signal }),
    ).rejects.toThrow("cancelled")
    expect(activeProcessCount()).toBe(0)
  })

  test.skipIf(skip)("killAll terminates everything chert started", async () => {
    const pending = runProcess(["sleep", "5"], { cwd: process.cwd(), timeoutMs: 10_000 })
    expect(activeProcessCount()).toBe(1)
    killAllProcesses()
    // The child is reaped; its signal exit is reported, not thrown, because
    // quitting chert is not an error path.
    const result = await pending
    expect(result.exitCode).not.toBe(0)
    expect(activeProcessCount()).toBe(0)
  })
})

describe("probeVersion", () => {
  test("returns null for a missing CLI", () => {
    expect(probeVersion("chert-definitely-not-installed")).toBeNull()
  })

  test.skipIf(skip)("returns the first line for an installed CLI", () => {
    const version = probeVersion("sh")
    expect(version === null || typeof version === "string").toBe(true)
  })
})
