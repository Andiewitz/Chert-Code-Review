import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OPENING_PROMPT, createOpencodeHarness, parseEvents, parseSessionList } from "./opencode"

const skip = process.platform === "win32"

// A stand-in for the real CLI: it prints the same JSONL shapes opencode does,
// records its argv, and can fail, error or hang on request.
const FAKE_CLI = `#!/usr/bin/env bun
const fs = require("node:fs")
const args = process.argv.slice(2)
if (args[0] === "--version") {
  console.log("2.3.0")
  process.exit(0)
}
if (args[0] === "session") {
  console.log(JSON.stringify([
    { id: "ses_old", title: "old", updated: 1000, created: 1, projectId: "p", directory: "/repo" },
    { id: "ses_new", title: "new", updated: 2000, created: 1, projectId: "p", directory: "/repo" },
    { id: "ses_mid", title: "mid", updated: 1500, created: 1, projectId: "p", directory: "/repo" },
  ]))
  process.exit(0)
}
const log = process.env.FAKE_LOG
if (log) fs.appendFileSync(log, JSON.stringify(args) + "\\n")
const prompt = args[args.length - 1]
const sessionArg = args.includes("--session") ? args[args.indexOf("--session") + 1] : null
const emit = (sessionID, text) =>
  console.log(JSON.stringify({ type: "text", timestamp: 1, sessionID, part: { type: "text", text } }))
if (prompt === "slow") await Bun.sleep(10000)
if (prompt === "fail") {
  console.error("boom")
  process.exit(1)
}
if (prompt === "error-event") {
  console.log(JSON.stringify({ type: "error", sessionID: "ses_x", error: { data: { message: "model overloaded" } } }))
  process.exit(0)
}
if (args.includes("--fork")) {
  emit(process.env.FAKE_FORK_ID || "ses_forked", "ready")
  process.exit(0)
}
if (sessionArg === null) {
  emit("ses_fresh", "answer:" + prompt)
  process.exit(0)
}
emit(sessionArg, "answer:" + prompt)
`

interface FakeCli {
  command: string
  logPath: string
  calls: () => string[][]
}

function installFakeCli(): FakeCli {
  const dir = mkdtempSync(join(tmpdir(), "chert-opencode-"))
  const command = join(dir, "opencode")
  const logPath = join(dir, "calls.log")
  writeFileSync(command, FAKE_CLI)
  chmodSync(command, 0o755)
  writeFileSync(logPath, "")
  process.env.FAKE_LOG = logPath
  return {
    command,
    logPath,
    calls: () =>
      readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as string[]),
  }
}

let fake: FakeCli

beforeEach(() => {
  fake = installFakeCli()
})

afterEach(() => {
  delete process.env.FAKE_LOG
  delete process.env.FAKE_FORK_ID
})

describe("parseEvents", () => {
  test("joins text parts and keeps the first session id", () => {
    const stdout = [
      '{"type":"step_start","sessionID":"ses_1","part":{}}',
      '{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"answer line 1"}}',
      "not json",
      '{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"```chert-highlights"}}',
      '{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"```"}}',
      "",
    ].join("\n")
    expect(parseEvents(stdout)).toEqual({
      sessionId: "ses_1",
      text: "answer line 1\n```chert-highlights\n```",
      error: null,
    })
  })

  test("surfaces an error event's message", () => {
    const stdout = '{"type":"error","sessionID":"ses_1","error":{"name":"ProviderError","data":{"message":"model overloaded"}}}'
    expect(parseEvents(stdout)).toMatchObject({ sessionId: "ses_1", error: "model overloaded", text: "" })
  })

  test("reports no session when no event carried one", () => {
    expect(parseEvents('{"type":"text","part":{"type":"text","text":"hi"}}')).toEqual({
      sessionId: null,
      text: "hi",
      error: null,
    })
  })
})

describe("parseSessionList", () => {
  test("sorts newest first and accepts a wrapped list", () => {
    const stdout = JSON.stringify({
      sessions: [
        { id: "a", title: "A", updated: 1 },
        { id: "b", title: "B", updated: 3 },
        { id: "c", title: "C", updated: 2 },
      ],
    })
    expect(parseSessionList(stdout).map((session) => session.id)).toEqual(["b", "c", "a"])
  })

  test("caps the list and drops entries without an id", () => {
    const sessions = Array.from({ length: 25 }, (_unused, index) => ({
      id: `ses_${index}`,
      title: "",
      updated: index,
    }))
    sessions.push({ id: "", title: "nameless", updated: 99 })
    const parsed = parseSessionList(JSON.stringify(sessions))
    expect(parsed).toHaveLength(20)
    expect(parsed[0].id).toBe("ses_24")
  })

  test("returns nothing for output that is not a list", () => {
    expect(parseSessionList("")).toEqual([])
    expect(parseSessionList("[]")).toEqual([])
  })
})

describe("opencode harness", () => {
  test("detects the version and reports a missing CLI as unavailable", () => {
    expect(createOpencodeHarness({ command: fake.command }).detect()).toEqual({
      available: true,
      version: "2.3.0",
    })
    expect(createOpencodeHarness({ command: "/nonexistent/chert-opencode" }).detect()).toEqual({
      available: false,
      version: null,
    })
  })

  test.skipIf(skip)("lists this project's sessions newest first", () => {
    const harness = createOpencodeHarness({ command: fake.command })
    expect(harness.listSessions(process.cwd()).map((session) => session.id)).toEqual([
      "ses_new",
      "ses_mid",
      "ses_old",
    ])
  })

  test.skipIf(skip)("forks once and resumes only the fork", async () => {
    const harness = createOpencodeHarness({ command: fake.command, timeoutMs: 10_000 })
    const session = await harness.start({ projectRoot: process.cwd(), baseSessionId: "ses_author" })

    expect(session.mode).toBe("author-context")
    expect(session.id).toBe("ses_forked")
    expect(session.id).not.toBe("ses_author")

    await session.ask("first")
    await session.ask("second")
    session.close()
    session.close()

    const calls = fake.calls()
    // Start: read-only agent, the fork, and the opening prompt.
    expect(calls[0]).toContain("--fork")
    expect(calls[0].slice(calls[0].indexOf("--session") + 1, calls[0].indexOf("--session") + 2)).toEqual([
      "ses_author",
    ])
    expect(calls[0].slice(calls[0].indexOf("--agent") + 1, calls[0].indexOf("--agent") + 2)).toEqual(["plan"])
    expect(calls[0][calls[0].length - 1]).toBe(OPENING_PROMPT)
    expect(calls[0]).not.toContain("--auto")
    // Every later call resumes the fork and never the developer's session.
    const resumptions = calls.slice(1).map((argv) => argv[argv.indexOf("--session") + 1])
    expect(resumptions).toEqual(["ses_forked", "ses_forked"])
  })

  test.skipIf(skip)("starts a fresh session when there is no base", async () => {
    const harness = createOpencodeHarness({ command: fake.command, timeoutMs: 10_000 })
    const session = await harness.start({ projectRoot: process.cwd(), title: "review" })
    expect(session.mode).toBe("fresh")
    expect(session.id).toBe("ses_fresh")
    expect(fake.calls()[0]).not.toContain("--fork")
  })

  test.skipIf(skip)("refuses a fork that came back as the original session", async () => {
    process.env.FAKE_FORK_ID = "ses_author"
    const harness = createOpencodeHarness({ command: fake.command, timeoutMs: 10_000 })
    await expect(harness.start({ projectRoot: process.cwd(), baseSessionId: "ses_author" })).rejects.toThrow(
      "refusing to write into your original conversation",
    )
  })

  test.skipIf(skip)("askOnce keeps a plain prompt out of the session list", async () => {
    const harness = createOpencodeHarness({ command: fake.command, timeoutMs: 10_000 })
    expect(await harness.askOnce(process.cwd(), "hello")).toBe("answer:hello")
    expect(fake.calls()[0]).toContain("--archived")
    expect(fake.calls()[0]).toContain("plan")
  })

  test.skipIf(skip)("reports a failing run and an error event", async () => {
    const harness = createOpencodeHarness({ command: fake.command, timeoutMs: 10_000 })
    await expect(harness.askOnce(process.cwd(), "fail")).rejects.toThrow("boom")
    await expect(harness.askOnce(process.cwd(), "error-event")).rejects.toThrow("model overloaded")
  })

  test.skipIf(skip)("close cancels a call that is still running", async () => {
    const harness = createOpencodeHarness({ command: fake.command, timeoutMs: 30_000 })
    const session = await harness.start({ projectRoot: process.cwd(), baseSessionId: "ses_author" })
    const pending = session.ask("slow")
    setTimeout(() => session.close(), 150)
    await expect(pending).rejects.toThrow("cancelled")
  })
})
