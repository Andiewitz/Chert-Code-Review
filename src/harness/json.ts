// Shared JSON shape check for the harnesses: opencode events and model lists
// are parsed from untyped output, so every field is checked before use.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
