// Small pure text helpers shared by the agent bridge and the connectors.

/** Keep at most `max` trailing lines, noting how many were hidden. */
export function tailLines(text: string, max: number): string {
  const lines = text.split("\n")
  if (lines.length <= max) return text
  return `… ${lines.length - max} earlier lines hidden\n${lines.slice(-max).join("\n")}`
}
