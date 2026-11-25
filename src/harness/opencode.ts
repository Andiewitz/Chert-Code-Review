// The opencode adapter. All opencode spawning happens here: detection, session
// discovery, the one fork at review start, and every later request that resumes
// it. The call runs `--agent plan`, which denies edits, and never the auto-approve
// flag.
//
// By default every call goes through opencode's own background service, which
// the CLI starts and authenticates on demand: nothing to launch, nothing to
// configure. Setting CHERT_OPENCODE_SERVER switches to an explicit server
// (`opencode serve`) via `run --server <url>`; that server needs
// OPENCODE_PASSWORD in the environment, because a standalone serve requires it.
//
// `run --format json` prints one JSON object per line; text lives in
// `part.text` and every event carries the session id. A fresh run invents a new
// session, so chert always stores the id the CLI reports rather than assuming a
// forked one.

import { tryOr } from "../best-effort"
import { MAX_HARNESS_SESSIONS } from "../limits"
import { isRecord } from "./json"
import {
  MODEL_PROBE_PROMPT,
  listOpencodeModels,
  modelErrorHint,
  recommendOpencodeModel,
} from "./opencode-models"
import { probeServer, resolveServerUrl } from "./opencode-server"
import type { ServerHealth } from "./opencode-server"
import { describeExit, probeVersion, runProcess } from "./process"
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
  let errorSession: string | null = null
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
      if (typeof event.sessionID === "string" && event.sessionID !== "") errorSession = event.sessionID
    }
  }
  return { sessionId: errorSession ?? sessionId, text: texts.join("\n"), error }
}

/**
 * An error event still carries the session opencode created, so the caller can
 * close that session instead of leaving it to be listed later.
 */
function closeEventSession(session: ReviewSession): void {
  session.close()
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
  /** Model to pin on every call, as `provider/model`. */
  model?: string
  /** Explicit server to use. Defaults to CHERT_OPENCODE_SERVER; unset uses the background service. */
  serverUrl?: string
  /** Health probe, injectable so tests need no real server. */
  probe?: (url: string) => Promise<ServerHealth>
  /** A pinned model's one-shot check. Override in tests with a fake answer. */
  probeModel?: (model: string, projectRoot: string) => Promise<string>
}

/**
 * Run one opencode call and return its parsed events. A run that exits nonzero
 * after printing a usable answer is still an answer: the CLI reports warnings
 * that way, and dropping the text turns a working review into a failure.
 */
async function runOnce(
  argv: string[],
  options: ProcessOptions,
): Promise<OpencodeEvents & { stdout: string }> {
  const result = await runProcess(argv, options)
  const events = { ...parseEvents(result.stdout), stdout: result.stdout }
  const usable = events.sessionId !== null || events.text.trim() !== "" || events.error !== null
  if (result.exitCode !== 0 && !usable) {
    throw new Error(`${argv[0]} ${describeExit(result.exitCode, result.stderr)}`)
  }
  return events
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
  base: () => string[],
  cwd: string,
  timeoutMs: number,
  model?: string,
  recommend?: () => string | undefined,
): ReviewSession {
  const controller = new AbortController()
  let closed = false
  const session: ReviewSession = {
    id,
    mode,
    async ask(request: string): Promise<string> {
      const events = await runOnce([...base(), "--session", id, request], {
        cwd,
        timeoutMs,
        signal: controller.signal,
      })
      if (events.error !== null) {
        closeEventSession(session)
        throw new Error(
          model === undefined ? events.error : modelErrorHint(model, events.error, recommend?.()),
        )
      }
      return events.text
    },
    close(): void {
      if (closed) return
      closed = true
      controller.abort()
    },
  }
  return session
}

function listOpencodeSessions(command: string, projectRoot: string): SessionInfo[] {
  const argv = [command, "session", "list", "--format", "json", "--max-count", String(MAX_HARNESS_SESSIONS)]
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
  base: () => string[],
  startOptions: StartOptions,
  timeoutMs: number,
  model?: string,
  recommend?: () => string | undefined,
): Promise<ReviewSession> {
  const argv = [...base(), "--title", startOptions.title ?? DEFAULT_TITLE]
  const forkOf = startOptions.baseSessionId
  if (forkOf !== undefined) argv.push("--session", forkOf, "--fork")
  argv.push(OPENING_PROMPT)
  const events = await runOnce(argv, { cwd: startOptions.projectRoot, timeoutMs })
  if (events.error !== null) {
    // The opening call created a session before it failed; close the one it named.
    if (events.sessionId !== null) {
      closeEventSession(
        makeSession(events.sessionId, "fresh", base, startOptions.projectRoot, timeoutMs, model, recommend),
      )
    }
    throw new Error(model === undefined ? events.error : modelErrorHint(model, events.error, recommend?.()))
  }
  requireAnswer(events)
  const id = requireSessionId(events, argv)
  if (forkOf !== undefined && id === forkOf) {
    throw new Error("opencode did not fork; refusing to write into your original conversation")
  }
  const mode = forkOf === undefined ? "fresh" : "author-context"
  return makeSession(id, mode, base, startOptions.projectRoot, timeoutMs, model, recommend)
}

/** `run`, the read-only agent, the pinned model and the configured server. */
function makeBaseArgv(command: string, serverUrl: () => string | null, model?: string): () => string[] {
  return () => {
    const argv = [command, "run", "--format", "json", "--agent", READ_ONLY_AGENT]
    if (model !== undefined && model !== "") argv.push("--model", model)
    const server = serverUrl()
    if (server !== null) argv.push("--server", server)
    return argv
  }
}

/** The CLI version is cached; whether an explicit server is up is asked every time. */
function makeDetect(
  command: string,
  serverUrl: () => string | null,
  probe: (url: string) => Promise<ServerHealth>,
): () => Promise<HarnessDetection> {
  return async () => {
    const version = probeVersion(command)
    if (version === null) return { available: false, version: null, reason: `${command} is not installed` }
    const url = serverUrl()
    // No CHERT_OPENCODE_SERVER: opencode starts its background service on demand.
    if (url === null) return { available: true, version }
    const health = await probe(url)
    if (!health.ok) {
      return {
        available: false,
        version,
        reason:
          `No opencode server at ${url}. Start one with OPENCODE_PASSWORD=… opencode serve ` +
          `--port 4096, or unset CHERT_OPENCODE_SERVER to use opencode's background service`,
      }
    }
    return { available: true, version }
  }
}

/** The default probe: one real `run --model` call, whose session is closed. */
function makeProbeModel(
  command: string,
  serverUrl: () => string | null,
  base: () => string[],
  timeoutMs: number,
  recommend: (failed?: string) => string | undefined,
  requireAvailable: () => Promise<void>,
): (model: string, projectRoot: string) => Promise<string> {
  return async (wanted, root) => {
    await requireAvailable()
    const argv = [command, "run", "--format", "json", "--agent", READ_ONLY_AGENT, "--model", wanted]
    const server = serverUrl()
    if (server !== null) argv.push("--server", server)
    argv.push(MODEL_PROBE_PROMPT)
    const events = await runOnce(argv, { cwd: root, timeoutMs })
    if (events.error !== null) {
      // A rejected probe still created a session; close it before reporting.
      if (events.sessionId !== null) {
        closeEventSession(makeSession(events.sessionId, "fresh", base, root, timeoutMs, wanted))
      }
      throw new Error(modelErrorHint(wanted, events.error, recommend(wanted)))
    }
    if (events.sessionId !== null) {
      // The probe's session is never resumed, so it must not linger.
      closeEventSession(
        makeSession(events.sessionId, "fresh", base, root, timeoutMs, wanted, () => recommend(wanted)),
      )
    }
    return events.text
  }
}

/** One archived `run` for plain prompts; an error names a usable model. */
function makeAskOnce(
  base: () => string[],
  timeoutMs: number,
  model: string | undefined,
  recommend: (failed?: string) => string | undefined,
  requireAvailable: () => Promise<void>,
): (projectRoot: string, request: string) => Promise<string> {
  return async (projectRoot, request) => {
    await requireAvailable()
    // `--archived` keeps a plain prompt out of the user's visible session list.
    const events = await runOnce([...base(), "--archived", request], { cwd: projectRoot, timeoutMs })
    if (events.error !== null) {
      throw new Error(modelErrorHint(model ?? "", events.error, recommend(model)))
    }
    return events.text
  }
}

export function createOpencodeHarness(options: OpencodeHarnessOptions = {}): HarnessAdapter {
  const command = options.command ?? DEFAULT_COMMAND
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const model = options.model
  // Resolved per call: the adapter outlives the environment it was made in, and
  // CHERT_OPENCODE_SERVER is how a user points chert at their server.
  const serverUrl = (): string | null => resolveServerUrl(options.serverUrl)
  const probe = options.probe ?? probeServer
  const baseArgv = makeBaseArgv(command, serverUrl, model)
  const detect = makeDetect(command, serverUrl, probe)
  const listModels = (): string[] => listOpencodeModels(command, serverUrl)
  // Listing on an error is a little work, but it turns "try another model" into
  // a command the user can run, and the failed model is never suggested.
  const recommend = (failed?: string): string | undefined =>
    recommendOpencodeModel(listModels(), failed ?? model)
  const probeModel =
    options.probeModel ?? makeProbeModel(command, serverUrl, baseArgv, timeoutMs, recommend, requireAvailable)
  const askOnce = makeAskOnce(baseArgv, timeoutMs, model, recommend, requireAvailable)

  async function requireAvailable(): Promise<void> {
    const found = await detect()
    if (!found.available) throw new Error(found.reason ?? `${command} is not available`)
  }

  function listSessions(projectRoot: string): SessionInfo[] {
    // The list comes from the shared database, so it works before a probe.
    return probeVersion(command) === null ? [] : listOpencodeSessions(command, projectRoot)
  }

  async function start(startOptions: StartOptions): Promise<ReviewSession> {
    await requireAvailable()
    return startOpencode(baseArgv, startOptions, timeoutMs, model, () => recommend())
  }

  return {
    id: "opencode",
    label: "opencode",
    detect,
    listSessions,
    listModels,
    start,
    askOnce,
    probeModel,
  }
}
