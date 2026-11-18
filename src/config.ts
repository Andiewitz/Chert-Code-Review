// Shared configuration storage: the ~/.chert directory (CHERT_CONFIG_DIR
// overrides it, which keeps tests hermetic) plus JSON helpers that never leave
// a half-written file behind.

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { bestEffort, tryOr } from "./best-effort"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export function configDir(): string {
  return process.env.CHERT_CONFIG_DIR ?? join(homedir(), ".chert")
}

/** Read and parse a JSON file; undefined when it is missing or malformed. */
export function readJson<T>(path: string): T | undefined {
  return tryOr<T | undefined>(() => JSON.parse(readFileSync(path, "utf8")) as T, undefined)
}

interface WriteJsonOptions {
  /** POSIX mode for the new file. Defaults to the process umask. */
  mode?: number
}

/**
 * Write JSON atomically: a sibling temp file is written, then renamed over the
 * target, so a crash or a concurrent reader never observes half a document.
 * `mode` is applied when the temp file is created, so a file holding API keys
 * is never briefly world-readable.
 */
export function writeJsonAtomic(path: string, data: unknown, options: WriteJsonOptions = {}): void {
  mkdirSync(dirname(path), { recursive: true })
  const payload = `${JSON.stringify(data, null, 2)}\n`
  const mode = options.mode ?? 0o666
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, payload, { mode })
  // Windows refuses to rename over an existing file, so fall back to a direct
  // write; the temp file is then redundant.
  const renamed = tryOr(() => {
    renameSync(tmp, path)
    return true
  }, false)
  if (!renamed) {
    writeFileSync(path, payload, { mode })
    bestEffort("remove the superseded temp file", () => unlinkSync(tmp))
  }
}
