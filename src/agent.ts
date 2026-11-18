// Agent bridge: chert delegates plain-text prompts to the local OpenCode CLI,
// which already knows how to work in a project directory. Zero API keys and
// zero extra dependencies — opencode must simply be installed.
//
// The agent call is asynchronous on purpose: shell round-trips can take a
// while, and the real renderer's event loop handles concurrent async work fine
// (the synchronous git layer is only deterministic-loading fast local data).

import { tailLines } from "./text"

let available: boolean | null = null

export function opencodeAvailable(): boolean {
  if (available === null) {
    try {
      const proc = Bun.spawnSync(["opencode", "--version"], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        env: { ...process.env },
      })
      available = proc.exitCode === 0
    } catch {
      available = false
    }
  }
  return available
}

/** How long a single opencode run may take before it is killed. */
const AGENT_TIMEOUT_MS = 120_000

export async function runAgent(prompt: string, cwd: string): Promise<string> {
  const proc = Bun.spawn(["opencode", "run", prompt], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env },
  })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, AGENT_TIMEOUT_MS)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (timedOut) {
      throw new Error(`opencode did not finish within ${AGENT_TIMEOUT_MS / 1000}s`)
    }
    if (exitCode !== 0) {
      throw new Error(stderr.trim() || `opencode run exited with code ${exitCode}`)
    }
    return tailLines(stdout.trim(), 40)
  } finally {
    clearTimeout(timeout)
  }
}
