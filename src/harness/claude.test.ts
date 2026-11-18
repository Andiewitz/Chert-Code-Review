import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClaudeHarness, parseResult } from "./claude"
import { OPENING_PROMPT } from "./types"

const skip = process.platform === "win32"

// A stand-in for the Claude Code CLI: same `-p ... --output-format json` shape,
// same single result object, and a log of every argv it was called with.
const FAKE_CLI = `#!/usr/bin/env bun
const fs = require("node:fs")
const args = process.argv.slice(2)
if (args.includes("--version")) {
  console.log("2.1.0 (Claude Code)")
  process.exit(0)
}
const log = process.env.FAKE_LOG
if (log) fs.appendFileSync(log, JSON.stringify(args) + "\\n")
const prompt = args[args.indexOf("-p") + 1]
const resumeAt = args.indexOf("--resume")
const resumed = resumeAt === -1 ? null : args[resumeAt + 1]
const emit = (sessionId, text, isError) =>
  console.log(JSON.stringify({ type: "result", session_id: sessionId, result: text, is_error: isError === true }))
if (prompt === "slow") await Bun.sleep(10000)
if (prompt === "fail") {
  console.error("boom")
  process.exit(2)
}
if (prompt === "error-json") {
  emit("sess_x", "bad request", true)
  process.exit(0)
}
if (prompt === ${JSON.stringify(OPENING_PROMPT)}) {
  emit(process.env.FAKE_SESSION_ID || "sess_forked", "ready", false)
  process.exit(0)
}
emit(resumed || "sess_once", "answer:" + prompt, false)
`

interface FakeCli {
  command: string
  calls: () => string[][]
}

function installFakeCli(): FakeCli {
  const dir = mkdtempSync(join(tmpdir(), "chert-claude-"))
  const command = join(dir, "claude")
  const logPath = join(dir, "calls.log")
  writeFileSync(command, FAKE_CLI)
  chmodSync(command, 0o755)
  writeFileSync(logPath, "")
  process.env.FAKE_LOG = logPath
  return {
    command,
    calls: () =>
      readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as string[]),
  }
}

function valueAfter(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag)
  return at === -1 ? undefined : argv[at + 1]
}

let fake: FakeCli

beforeEach(() => {
  fake = installFakeCli()
})

afterEach(() => {
  delete process.env.FAKE_LOG
  delete process.env.FAKE_SESSION_ID
})

describe("parseResult", () => {
  test("reads the result, the session id and an error flag", () => {
    expect(parseResult('{"type":"result","session_id":"sess_1","result":"done","is_error":false}')).toEqual({
      sessionId: "sess_1",
      text: "done",
      error: null,
    })
    expect(parseResult('{"is_error":true,"result":"bad request","session_id":"sess_2"}')).toEqual({
      sessionId: "sess_2",
      text: "bad request",
      error: "bad request",
    })
  })

  test("treats a non-JSON answer as plain text", () => {
    expect(parseResult("  just words  ")).toEqual({ sessionId: null, text: "just words", error: null })
    expect(parseResult("   ")).toMatchObject({ text: "", error: "claude printed nothing" })
  })
})

describe("claude harness", () => {
  test("detects the version and reports a missing CLI as unavailable", () => {
    expect(createClaudeHarness({ command: fake.command }).detect()).toEqual({
      available: true,
      version: "2.1.0 (Claude Code)",
    })
    expect(createClaudeHarness({ command: "/nonexistent/chert-claude" }).detect().available).toBe(false)
  })

  test("offers no session list, because the CLI has no such command", () => {
    expect(createClaudeHarness({ command: fake.command }).listSessions(process.cwd())).toEqual([])
  })

  test.skipIf(skip)("forks once with read-only tools and resumes only the fork", async () => {
    const harness = createClaudeHarness({ command: fake.command, timeoutMs: 10_000 })
    const session = await harness.start({ projectRoot: process.cwd(), baseSessionId: "sess_author" })

    expect(session.mode).toBe("author-context")
    expect(session.id).toBe("sess_forked")
    expect(session.id).not.toBe("sess_author")

    await session.ask("first")
    await session.ask("second")
    session.close()
    session.close()

    const calls = fake.calls()
    expect(valueAfter(calls[0], "--resume")).toBe("sess_author")
    expect(calls[0]).toContain("--fork-session")
    expect(valueAfter(calls[0], "--tools")).toBe("Read,Grep,Glob")
    expect(valueAfter(calls[0], "--disallowedTools")).toBe("Bash,Edit,Write,NotebookEdit")
    expect(calls[0].join(" ")).not.toContain("dangerously-skip-permissions")
    expect(valueAfter(calls[0], "-p")).toBe(OPENING_PROMPT)
    expect(calls.slice(1).map((argv) => valueAfter(argv, "--resume"))).toEqual(["sess_forked", "sess_forked"])
  })

  test.skipIf(skip)("starts a fresh session when there is no base", async () => {
    const harness = createClaudeHarness({ command: fake.command, timeoutMs: 10_000 })
    const session = await harness.start({ projectRoot: process.cwd() })
    expect(session.mode).toBe("fresh")
    expect(session.id).toBe("sess_forked")
    expect(fake.calls()[0]).not.toContain("--resume")
  })

  test.skipIf(skip)("refuses a fork that came back as the original session", async () => {
    process.env.FAKE_SESSION_ID = "sess_author"
    const harness = createClaudeHarness({ command: fake.command, timeoutMs: 10_000 })
    await expect(harness.start({ projectRoot: process.cwd(), baseSessionId: "sess_author" })).rejects.toThrow(
      "refusing to write into your original conversation",
    )
  })

  test.skipIf(skip)("askOnce keeps no session and reports failures", async () => {
    const harness = createClaudeHarness({ command: fake.command, timeoutMs: 10_000 })
    expect(await harness.askOnce(process.cwd(), "hello")).toBe("answer:hello")
    expect(fake.calls()[0]).not.toContain("--resume")
    await expect(harness.askOnce(process.cwd(), "fail")).rejects.toThrow("boom")
    await expect(harness.askOnce(process.cwd(), "error-json")).rejects.toThrow("bad request")
  })

  test.skipIf(skip)("close cancels a call that is still running", async () => {
    const harness = createClaudeHarness({ command: fake.command, timeoutMs: 30_000 })
    const session = await harness.start({ projectRoot: process.cwd(), baseSessionId: "sess_author" })
    const pending = session.ask("slow")
    setTimeout(() => session.close(), 150)
    await expect(pending).rejects.toThrow("cancelled")
  })
})
