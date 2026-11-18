// For side effects that are genuinely optional from the user's point of view:
// scrolling, persisting a preference, warming a cache. A failure must never
// break the review, but the label keeps the intent greppable.

/** Run `action`, swallowing any error. `label` says why that is safe. */
export function bestEffort(label: string, action: () => void): void {
  try {
    action()
  } catch {
    // best effort: label
  }
}

/**
 * Run `attempt` and fall back when it throws (a probe: "is this a repo?",
 * "does this file exist?"). Unlike bestEffort, the return value is the point.
 */
export function tryOr<T>(attempt: () => T, fallback: T): T {
  try {
    return attempt()
  } catch {
    return fallback
  }
}
