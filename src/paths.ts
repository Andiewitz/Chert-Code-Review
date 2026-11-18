// Filesystem path helpers shared by the project list, the tree view and the TUI.

import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { tryOr } from "./best-effort"

/** Resolve symlinks when possible; fall back to an absolute, normalised path. */
export function toRealPath(path: string): string {
  return tryOr(() => realpathSync(path), resolve(path))
}

/** The last segment of a path, handling both separators (for display). */
export function lastPathSegment(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}
