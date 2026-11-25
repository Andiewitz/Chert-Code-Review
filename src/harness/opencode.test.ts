import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createOpencodeHarness, parseEvents, parseSessionList } from "./opencode"
import { MODEL_PROBE_PROMPT } from "./opencode-models"
import { probeServer, resolveServerUrl } from "./opencode-server"
import { OPENING_PROMPT } from "./types"

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
if (args[0] === "models") {
  console.log("openrouter/broken-model")
  console.log("opencode/big-pickle")
  console.log("opencode/beam-free")
  process.exit(0)
}
const prompt = args[args.length - 1]
const modelArg = args.includes("--model") ? args[args.indexOf("--model") + 1] : null
if (modelArg === "openrouter/broken-model") {
  console.log(JSON.stringify({ type: "error", sessionID: "ses_broken", error: { data: { message: "provider not authenticated" } } }))
  process.exit(0)
}
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

beforeEach(() => {
  delete process.env.CHERT_OPENCODE_SERVER
})

afterEach(() => {
  delete process.env.FAKE_LOG
  delete process.env.FAKE_FORK_ID
})

describe("resolveServerUrl", () => {
  test("accepts a URL or a bare host:port, and drops a trailing slash", () => {
    expect(resolveServerUrl("http://10.0.0.2:5000/")).toBe("http://10.0.0.2:5000")
    expect(resolveServerUrl("localhost:4096")).toBe("http://localhost:4096")
  })

  test("returns null when no server was configured", () => {
    expect(resolveServerUrl("")).toBeNull()
    expect(resolveServerUrl()).toBeNull()
  })
})

describe("probeServer", () => {
  test("treats a 2xx as up even when the body is not JSON", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("<!doctype html><title>OpenCode</title>", { status: 200 }),
    })
    try {
      expect(await probeServer(`http://127.0.0.1:${server.port}`)).toEqual({
        ok: true,
        version: null,
      })
    } finally {
      server.stop(true)
    }
  })
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
    const stdout =
      '{"type":"error","sessionID":"ses_1","error":{"name":"ProviderError","data":{"message":"model overloaded"}}}'
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

const liveServer = async () => ({ ok: true, version: "2.3.0" })
const noServer = async () => ({ ok: false, version: null })

/** A harness pointed at the fake CLI, with a stubbed server probe. */
function harness(options: Parameters<typeof createOpencodeHarness>[0] = {}) {
  return createOpencodeHarness({ command: fake.command, timeoutMs: 10_000, probe: liveServer, ...options })
}

describe("opencode harness", () => {
  test("detects the version and reports a missing CLI as unavailable", async () => {
    expect(await harness().detect()).toEqual({ available: true, version: "2.3.0" })
    expect(await harness({ command: "/nonexistent/chert-opencode" }).detect()).toMatchObject({
      available: false,
      version: null,
    })
  })

  test("needs a running server only when one is configured", async () => {
    const closed = harness({ probe: noServer, serverUrl: "127.0.0.1:4999" })
    const found = await closed.detect()
    expect(found.available).toBe(false)
    expect(found.reason).toContain("No opencode server at http://127.0.0.1:4999")
    expect(found.reason).toContain("opencode serve")
    await expect(closed.start({ projectRoot: process.cwd() })).rejects.toThrow("opencode serve")
  })

  test.skipIf(skip)("uses opencode's background service when no server is configured", async () => {
    await harness().askOnce(process.cwd(), "hello")
    expect(fake.calls()[0]).not.toContain("--server")
  })

  test.skipIf(skip)("attaches every call to the configured server", async () => {
    await harness({ serverUrl: "localhost:4096" }).askOnce(process.cwd(), "hello")
    const argv = fake.calls()[0]
    expect(argv[argv.indexOf("--server") + 1]).toBe("http://localhost:4096")
  })

  test.skipIf(skip)("lists this project's sessions newest first", () => {
    expect(
      harness()
        .listSessions(process.cwd())
        .map((session) => session.id),
    ).toEqual(["ses_new", "ses_mid", "ses_old"])
  })

  test.skipIf(skip)("forks once and resumes only the fork", async () => {
    const session = await harness({ serverUrl: "127.0.0.1:4096" }).start({
      projectRoot: process.cwd(),
      baseSessionId: "ses_author",
    })

    expect(session.mode).toBe("author-context")
    expect(session.id).toBe("ses_forked")
    expect(session.id).not.toBe("ses_author")

    await session.ask("first")
    await session.ask("second")
    session.close()
    session.close()

    const calls = fake.calls()
    // Start: read-only agent, the configured server, the fork, the opening prompt.
    expect(calls[0][calls[0].indexOf("--server") + 1]).toBe("http://127.0.0.1:4096")
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
    const session = await harness().start({ projectRoot: process.cwd(), title: "review" })
    expect(session.mode).toBe("fresh")
    expect(session.id).toBe("ses_fresh")
    expect(fake.calls()[0]).not.toContain("--fork")
  })

  test.skipIf(skip)("refuses a fork that came back as the original session", async () => {
    process.env.FAKE_FORK_ID = "ses_author"
    await expect(
      harness().start({ projectRoot: process.cwd(), baseSessionId: "ses_author" }),
    ).rejects.toThrow("refusing to write into your original conversation")
  })

  test.skipIf(skip)("askOnce keeps a plain prompt out of the session list", async () => {
    expect(await harness().askOnce(process.cwd(), "hello")).toBe("answer:hello")
    expect(fake.calls()[0]).toContain("--archived")
    expect(fake.calls()[0]).toContain("plan")
  })

  test.skipIf(skip)("passes the pinned model to start, asks and plain prompts", async () => {
    const adapter = harness({ model: "opencode/big-pickle" })
    const session = await adapter.start({ projectRoot: process.cwd() })
    await session.ask("first")
    await adapter.askOnce(process.cwd(), "hello")

    const calls = fake.calls()
    expect(calls).toHaveLength(3)
    for (const argv of calls) {
      expect(argv[argv.indexOf("--model") + 1]).toBe("opencode/big-pickle")
    }
    expect(calls[0]).toContain(OPENING_PROMPT)
    expect(calls[1]).toContain("first")
    expect(calls[2]).toContain("--archived")
  })

  test.skipIf(skip)("lists models with the built-in ones first", () => {
    expect(harness().listModels?.()).toEqual([
      "opencode/big-pickle",
      "opencode/beam-free",
      "openrouter/broken-model",
    ])
  })

  test.skipIf(skip)("probes a model with one real call", async () => {
    const adapter = harness()
    expect(await adapter.probeModel?.("opencode/big-pickle", process.cwd())).toBe(
      `answer:${MODEL_PROBE_PROMPT}`,
    )
    const argv = fake.calls()[0]
    expect(argv[argv.indexOf("--model") + 1]).toBe("opencode/big-pickle")
    expect(argv[argv.length - 1]).toBe(MODEL_PROBE_PROMPT)
    expect(argv).not.toContain("--archived")
  })

  test.skipIf(skip)("a rejected model names a concrete alternative", async () => {
    const adapter = harness({ model: "openrouter/broken-model" })
    await expect(adapter.askOnce(process.cwd(), "hello")).rejects.toThrow(
      "try /connect opencode opencode/beam-free",
    )
    await expect(adapter.probeModel?.("openrouter/broken-model", process.cwd())).rejects.toThrow(
      "try /connect opencode opencode/beam-free",
    )
  })

  test.skipIf(skip)("a rejected model at start names a concrete alternative", async () => {
    await expect(
      harness({ model: "openrouter/broken-model" }).start({ projectRoot: process.cwd() }),
    ).rejects.toThrow("try /connect opencode opencode/beam-free")
  })

  test.skipIf(skip)("reports a failing run and an error event", async () => {
    const adapter = harness()
    await expect(adapter.askOnce(process.cwd(), "fail")).rejects.toThrow("boom")
    await expect(adapter.askOnce(process.cwd(), "error-event")).rejects.toThrow("model overloaded")
  })

  test.skipIf(skip)("close cancels a call that is still running", async () => {
    const session = await harness({ timeoutMs: 30_000 }).start({
      projectRoot: process.cwd(),
      baseSessionId: "ses_author",
    })
    const pending = session.ask("slow")
    setTimeout(() => session.close(), 150)
    await expect(pending).rejects.toThrow("cancelled")
  })
})
