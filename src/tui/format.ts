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

/**
 * Shorten from the middle: long errors keep both the subject and the advice at
 * the end, which a plain cut would throw away.
 */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.max(0, Math.floor((max - 1) * 0.6))
  const tail = Math.max(0, max - 1 - head)
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}
