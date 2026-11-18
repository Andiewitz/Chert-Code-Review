// Process lifecycle for harness calls: one place that spawns, times out, kills
// and reaps a child. Every live child is tracked so quitting chert cannot leave
// a harness process behind.

import { tryOr } from "../best-effort"

export interface ProcessOptions {
  cwd: string
  /** Kill the child after this long. Defaults to 2 minutes. */
  timeoutMs?: number
  /** Data for stdin, when the CLI reads its prompt there. */
  input?: string
  /** Extra environment for this child. */
  env?: Record<string, string>
  /** Aborting kills the child (Esc, cancel, quit). */
  signal?: AbortSignal
}

export interface ProcessResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}

const DEFAULT_TIMEOUT_MS = 120_000
const children = new Set<ReturnType<typeof Bun.spawn>>()

/** Children still running. The smoke test asserts this returns to zero. */
export function activeProcessCount(): number {
  return children.size
}

/** Kill every harness child chert started. Called on quit. */
export function killAllProcesses(): void {
  for (const child of children) {
    tryOr(() => child.kill(), undefined)
  }
  children.clear()
}

/** A duration a human can read: "150ms", never a rounded "0s". */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`
}

function describeExit(exitCode: number, stderr: string): string {
  const detail = stderr.trim()
  if (detail !== "") return detail
  return `exited with code ${exitCode}`
}

/**
 * Run one CLI call to completion. A timeout or abort kills the child and is
 * reported rather than thrown, so callers can show stderr and move on.
 */
export async function runProcess(argv: string[], options: ProcessOptions): Promise<ProcessResult> {
  const proc = Bun.spawn(argv, {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: options.input === undefined ? "ignore" : "pipe",
    env: { ...process.env, ...options.env },
  })
  children.add(proc)
  let timedOut = false
  let aborted = false

  const kill = () => {
    // A child that already exited rejects this; that is the expected case.
    tryOr(() => proc.kill(), undefined)
  }
  const timer = setTimeout(() => {
    timedOut = true
    kill()
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const onAbort = () => {
    aborted = true
    kill()
  }
  options.signal?.addEventListener("abort", onAbort, { once: true })
  if (options.signal?.aborted === true) onAbort()

  try {
    if (options.input !== undefined && proc.stdin !== undefined) {
      proc.stdin.write(options.input)
      await proc.stdin.end()
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (timedOut) {
      throw new Error(`${argv[0]} did not finish within ${formatDuration(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)}`)
    }
    if (aborted) throw new Error(`${argv[0]} was cancelled`)
    return { stdout, stderr, exitCode, timedOut: false }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", onAbort)
    children.delete(proc)
  }
}

/** Run one call and demand a zero exit status. */
export async function runProcessOrThrow(argv: string[], options: ProcessOptions): Promise<string> {
  const result = await runProcess(argv, options)
  if (result.exitCode !== 0) throw new Error(`${argv[0]} ${describeExit(result.exitCode, result.stderr)}`)
  return result.stdout
}

/** `command --version`, or null when it is not installed. Cached per command. */
const versions = new Map<string, string | null>()

export function probeVersion(command: string): string | null {
  const cached = versions.get(command)
  if (cached !== undefined) return cached
  const version = tryOr(() => {
    const proc = Bun.spawnSync([command, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env },
    })
    if (proc.exitCode !== 0) return null
    const text = proc.stdout.toString().trim() || proc.stderr.toString().trim()
    return text === "" ? null : text.split("\n")[0].trim()
  }, null)
  versions.set(command, version)
  return version
}

/** Forget a probe result (tests put a fake CLI on PATH mid-process). */
export function resetProbeCache(): void {
  versions.clear()
}
