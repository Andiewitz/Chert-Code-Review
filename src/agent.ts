// Agent bridge: chert delegates plain-text prompts to the local OpenCode CLI,
// which already knows how to work in a project directory. Zero API keys and
// zero extra dependencies — opencode must simply be installed.
//
// The agent call is asynchronous on purpose: shell round-trips can take a
// while, and the real renderer's event loop handles concurrent async work fine
// (the synchronous git layer is only deterministic-loading fast local data).

let available: boolean | null = null;

export function opencodeAvailable(): boolean {
  if (available === null) {
    try {
      const proc = Bun.spawnSync(["opencode", "--version"], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      available = proc.exitCode === 0;
    } catch {
      available = false;
    }
  }
  return available;
}

export async function runAgent(prompt: string, cwd: string): Promise<string> {
  const proc = Bun.spawn(["opencode", "run", prompt], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `opencode run exited with code ${exitCode}`);
  }
  return tailLines(stdout.trim(), 40);
}

export function tailLines(text: string, max: number): string {
  const lines = text.split("\n");
  if (lines.length <= max) return text;
  return `… ${lines.length - max} earlier lines hidden\n${lines.slice(-max).join("\n")}`;
}
