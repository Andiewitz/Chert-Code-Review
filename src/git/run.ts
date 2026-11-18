// The only place that spawns git. Read-only by construction: the first
// argument must be in the allowlist, and GIT_OPTIONAL_LOCKS=0 stops a review
// from blocking a concurrent `git commit`. The repository root is passed in;
// nothing here reads the process working directory.

// Allowlist of git first-arguments. Anything else throws.
const ALLOWED = new Set([
  "rev-parse",
  "diff",
  "ls-files",
  "show",
  "merge-base",
  "symbolic-ref",
  "rev-list",
  "log",
  "cat-file",
  "hash-object",
  "status",
])

interface RunOptions {
  /** Directory to run in; defaults to the repository root. */
  cwd?: string
  /** Data for commands that read stdin, such as hash-object. */
  input?: string
}

/** Run one read-only git command inside `root` (the repository root). */
export function run(root: string, args: string[], options: RunOptions = {}): string {
  if (args.length === 0) throw new Error("git: no command given")
  if (!ALLOWED.has(args[0])) {
    throw new Error(`git: command not allowed: ${args[0]}`)
  }
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: options.cwd ?? root,
    stdin: options.input === undefined ? undefined : Buffer.from(options.input),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  })
  if (proc.exitCode !== 0) {
    throw new Error(
      proc.stderr.toString().trim() || `git ${args.join(" ")} exited with code ${proc.exitCode}`,
    )
  }
  return proc.stdout.toString()
}
