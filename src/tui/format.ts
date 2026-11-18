// Pure display helpers. No state, no I/O, no theme lookups.

/** Shorten a path from the left, keeping the last segments that fit. */
export function shortenPath(path: string, max: number): string {
  if (path.length <= max) return path
  const parts = path.split("/")
  let out = parts[parts.length - 1]
  for (let i = parts.length - 2; i >= 0; i--) {
    const candidate = parts[i] + "/" + out
    if (candidate.length + 2 > max) {
      return "…/" + out
    }
    out = candidate
  }
  return out
}

/** Cut text to `max` characters, marking the cut with an ellipsis. */
export function truncateEnd(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text
}
