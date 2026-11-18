// The Claude Code adapter. All `claude` spawning happens here: detection, the
// one fork at review start, and every later request that resumes it.
//
// Isolation is by tool list, not by a permission prompt: the session may read,
// grep and glob, and shell/edit/write tools are explicitly disallowed. The
// dangerous skip-permissions flag is never passed. `--output-format json` prints
// one object per call (`result`, `session_id`, `is_error`), which is where the
// forked id comes from.
//
// Claude Code has no session-list command, so `listSessions` is empty: the TUI
// offers a typed id, or the newest session via `--continue`.

import { tryOr } from "../best-effort"
import { probeVersion, runProcessOrThrow } from "./process"
import type { ProcessOptions } from "./process"
import { OPENING_PROMPT } from "./types"
import type { HarnessAdapter, HarnessDetection, ReviewSession, SessionInfo, StartOptions } from "./types"

const DEFAULT_COMMAND = "claude"
const DEFAULT_TIMEOUT_MS = 120_000
/** Read, Grep and Glob only: no shell, no edits. */
const ISOLATION_FLAGS = ["--tools", "Read,Grep,Glob", "--disallowedTools", "Bash,Edit,Write,NotebookEdit"]

export interface ClaudeResult {
  /** The session the CLI used. A resumed session reports its own id. */
  sessionId: string | null
  text: string
  error: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Parse one `--output-format json` answer. A CLI that printed no JSON at all is
 * treated as plain text rather than as an error, so an older build still works.
 */
export function parseResult(stdout: string): ClaudeResult {
  const trimmed = stdout.trim()
  const parsed = tryOr(() => JSON.parse(trimmed) as unknown, null)
  if (!isRecord(parsed)) {
    return { sessionId: null, text: trimmed, error: trimmed === "" ? "claude printed nothing" : null }
  }
  const sessionId = typeof parsed.session_id === "string" && parsed.session_id !== "" ? parsed.session_id : null
  const text = typeof parsed.result === "string" ? parsed.result : ""
  const error = parsed.is_error === true ? text || "claude reported an error" : null
  return { sessionId, text, error }
}

/** `claude -p <prompt>` with the JSON output and the read-only tools. */
function argvFor(command: string, prompt: string, extra: string[]): string[] {
  return [command, "-p", prompt, "--output-format", "json", ...extra, ...ISOLATION_FLAGS]
}

async function runOnce(argv: string[], options: ProcessOptions): Promise<ClaudeResult> {
  return parseResult(await runProcessOrThrow(argv, options))
}

function requireAnswer(result: ClaudeResult): string {
  if (result.error !== null) throw new Error(result.error)
  return result.text
}

function requireSessionId(result: ClaudeResult, command: string): string {
  if (result.sessionId === null) throw new Error(`${command} printed no session id`)
  return result.sessionId
}

/**
 * The review session for one fork. `close` aborts the in-flight call, which is
 * how quitting chert stops a harness that is still thinking.
 */
function makeSession(
  id: string,
  mode: ReviewSession["mode"],
  command: string,
  cwd: string,
  timeoutMs: number,
): ReviewSession {
  const controller = new AbortController()
  let closed = false
  return {
    id,
    mode,
    async ask(request: string): Promise<string> {
      const argv = argvFor(command, request, ["--resume", id])
      return requireAnswer(await runOnce(argv, { cwd, timeoutMs, signal: controller.signal }))
    },
    close(): void {
      if (closed) return
      closed = true
      controller.abort()
    },
  }
}

/** Fork the developer's session (or start fresh) and open it with a tiny prompt. */
async function startClaude(
  command: string,
  startOptions: StartOptions,
  timeoutMs: number,
): Promise<ReviewSession> {
  const forkOf = startOptions.baseSessionId
  const extra = forkOf === undefined ? [] : ["--resume", forkOf, "--fork-session"]
  const result = await runOnce(argvFor(command, OPENING_PROMPT, extra), {
    cwd: startOptions.projectRoot,
    timeoutMs,
  })
  requireAnswer(result)
  const id = requireSessionId(result, command)
  if (forkOf !== undefined && id === forkOf) {
    throw new Error("claude did not fork; refusing to write into your original conversation")
  }
  return makeSession(id, forkOf === undefined ? "fresh" : "author-context", command, startOptions.projectRoot, timeoutMs)
}

export interface ClaudeHarnessOptions {
  /** The executable to call. Tests point this at a fake script. */
  command?: string
  timeoutMs?: number
}

export function createClaudeHarness(options: ClaudeHarnessOptions = {}): HarnessAdapter {
  const command = options.command ?? DEFAULT_COMMAND
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let detection: HarnessDetection | null = null

  function detect(): HarnessDetection {
    if (detection === null) {
      const version = probeVersion(command)
      detection = { available: version !== null, version }
    }
    return detection
  }

  async function start(startOptions: StartOptions): Promise<ReviewSession> {
    if (!detect().available) throw new Error(`${command} is not installed`)
    return startClaude(command, startOptions, timeoutMs)
  }

  async function askOnce(projectRoot: string, request: string): Promise<string> {
    if (!detect().available) throw new Error(`${command} is not installed`)
    const argv = argvFor(command, request, [])
    return requireAnswer(await runOnce(argv, { cwd: projectRoot, timeoutMs }))
  }

  return {
    id: "claude-code",
    label: "Claude Code",
    detect,
    // No session-list command; the picker falls back to a typed id.
    listSessions(_projectRoot: string): SessionInfo[] {
      return []
    },
    start,
    askOnce,
  }
}
