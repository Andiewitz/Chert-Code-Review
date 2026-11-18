// The opencode adapter. All opencode spawning happens here: detection, session
// discovery, the one fork at review start, and every later request that resumes
// it. The call runs `--agent plan`, which denies edits, and never the auto-approve
// flag.
//
// `run --format json` prints one JSON object per line; text lives in
// `part.text` and every event carries the session id. A fresh run invents a new
// session, so chert always stores the id the CLI reports rather than assuming a
// forked one.

import { tryOr } from "../best-effort"
import { MAX_HARNESS_SESSIONS } from "../limits"
import { probeVersion, runProcessOrThrow } from "./process"
import type { ProcessOptions } from "./process"
import { OPENING_PROMPT } from "./types"
import type { HarnessAdapter, HarnessDetection, ReviewSession, SessionInfo, StartOptions } from "./types"

const DEFAULT_COMMAND = "opencode"
const DEFAULT_TIMEOUT_MS = 120_000
/** The read-only agent: it denies `edit` (and `browser`) by opencode's config. */
const READ_ONLY_AGENT = "plan"
const DEFAULT_TITLE = "chert review"

export interface OpencodeEvents {
  /** The session the CLI used, from the first event that carries one. */
  sessionId: string | null
  /** Every `text` event's `part.text`, joined with newlines. */
  text: string
  /** The first `error` event's message, if the run reported one. */
  error: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The message inside an opencode `error` event, whatever shape it used. */
function errorMessage(raw: unknown): string {
  if (!isRecord(raw)) return "opencode reported an error"
  const error = isRecord(raw.error) ? raw.error : raw
  const data = isRecord(error.data) ? error.data : undefined
  const message = error.message ?? data?.message
  if (typeof message === "string" && message.trim() !== "") return message.trim()
  return tryOr(() => JSON.stringify(raw), "opencode reported an error")
}

/** Parse one `run --format json` output stream into session, text and error. */
export function parseEvents(stdout: string): OpencodeEvents {
  const texts: string[] = []
  let sessionId: string | null = null
  let error: string | null = null
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue
    const event = tryOr(() => JSON.parse(line) as unknown, null)
    if (!isRecord(event)) continue
    if (typeof event.sessionID === "string" && event.sessionID !== "") {
      sessionId = sessionId ?? event.sessionID
    }
    if (event.type === "text" && isRecord(event.part) && typeof event.part.text === "string") {
      texts.push(event.part.text)
    }
    if (event.type === "error" && error === null) {
      error = errorMessage(event)
    }
  }
  return { sessionId, text: texts.join("\n"), error }
}

/** opencode reports `updated` in seconds, milliseconds, or an ISO string. */
function toMillis(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value
  }
  if (typeof value === "string") return tryOr(() => Date.parse(value), 0)
  return 0
}

function sessionFrom(raw: unknown): SessionInfo | null {
  if (!isRecord(raw)) return null
  const id = typeof raw.id === "string" ? raw.id.trim() : ""
  if (id === "") return null
  return {
    id,
    title: typeof raw.title === "string" ? raw.title : "",
    updatedAt: toMillis(raw.updated),
  }
}

/** `session list --format json` may print a bare array or wrap it in an object. */
export function parseSessionList(stdout: string): SessionInfo[] {
  const parsed = tryOr(() => JSON.parse(stdout) as unknown, null)
  const raw = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.sessions)
      ? parsed.sessions
      : []
  const sessions: SessionInfo[] = []
  for (const entry of raw) {
    const session = sessionFrom(entry)
    if (session !== null) sessions.push(session)
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_HARNESS_SESSIONS)
}

export interface OpencodeHarnessOptions {
  /** The executable to call. Tests point this at a fake script. */
  command?: string
  timeoutMs?: number
}

/** Run one opencode call and return its parsed events. */
async function runOnce(
  argv: string[],
  options: ProcessOptions,
): Promise<OpencodeEvents & { stdout: string }> {
  const stdout = await runProcessOrThrow(argv, options)
  return { ...parseEvents(stdout), stdout }
}

function requireSessionId(events: OpencodeEvents, argv: string[]): string {
  if (events.sessionId === null) {
    throw new Error(`${argv[0]} run printed no session id`)
  }
  return events.sessionId
}

function requireAnswer(events: OpencodeEvents): string {
  if (events.error !== null) throw new Error(events.error)
  return events.text
}

/**
 * The review session for one fork. `close` aborts the in-flight call, which is
 * how quitting chert stops a harness that is still thinking.
 */
function makeSession(
  id: string,
  mode: ReviewSession["mode"],
  base: string[],
  cwd: string,
  timeoutMs: number,
): ReviewSession {
  const controller = new AbortController()
  let closed = false
  return {
    id,
    mode,
    async ask(request: string): Promise<string> {
      const events = await runOnce([...base, "--session", id, request], {
        cwd,
        timeoutMs,
        signal: controller.signal,
      })
      return requireAnswer(events)
    },
    close(): void {
      if (closed) return
      closed = true
      controller.abort()
    },
  }
}

function listOpencodeSessions(command: string, projectRoot: string): SessionInfo[] {
  const argv = [
    command,
    "session",
    "list",
    "--format",
    "json",
    "--max-count",
    String(MAX_HARNESS_SESSIONS),
  ]
  const stdout = tryOr(() => {
    const proc = Bun.spawnSync(argv, {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env },
    })
    return proc.exitCode === 0 ? proc.stdout.toString() : ""
  }, "")
  return parseSessionList(stdout)
}

/** Fork the developer's session (or start one) and open it with a tiny prompt. */
async function startOpencode(
  base: string[],
  startOptions: StartOptions,
  timeoutMs: number,
): Promise<ReviewSession> {
  const argv = [...base, "--title", startOptions.title ?? DEFAULT_TITLE]
  const forkOf = startOptions.baseSessionId
  if (forkOf !== undefined) argv.push("--session", forkOf, "--fork")
  argv.push(OPENING_PROMPT)
  const events = await runOnce(argv, { cwd: startOptions.projectRoot, timeoutMs })
  requireAnswer(events)
  const id = requireSessionId(events, argv)
  if (forkOf !== undefined && id === forkOf) {
    throw new Error("opencode did not fork; refusing to write into your original conversation")
  }
  const mode = forkOf === undefined ? "fresh" : "author-context"
  return makeSession(id, mode, base, startOptions.projectRoot, timeoutMs)
}

export function createOpencodeHarness(options: OpencodeHarnessOptions = {}): HarnessAdapter {
  const command = options.command ?? DEFAULT_COMMAND
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // `run` and the read-only agent are shared by every call shape.
  const base = [command, "run", "--format", "json", "--agent", READ_ONLY_AGENT]
  let detection: HarnessDetection | null = null

  function detect(): HarnessDetection {
    if (detection === null) {
      const version = probeVersion(command)
      detection = { available: version !== null, version }
    }
    return detection
  }

  function listSessions(projectRoot: string): SessionInfo[] {
    return detect().available ? listOpencodeSessions(command, projectRoot) : []
  }

  async function start(startOptions: StartOptions): Promise<ReviewSession> {
    if (!detect().available) throw new Error(`${command} is not installed`)
    return startOpencode(base, startOptions, timeoutMs)
  }

  async function askOnce(projectRoot: string, request: string): Promise<string> {
    if (!detect().available) throw new Error(`${command} is not installed`)
    // `--archived` keeps a plain prompt out of the user's visible session list.
    const events = await runOnce([...base, "--archived", request], {
      cwd: projectRoot,
      timeoutMs,
    })
    return requireAnswer(events)
  }

  return {
    id: "opencode",
    label: "opencode",
    detect,
    listSessions,
    start,
    askOnce,
  }
}
