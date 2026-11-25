// opencode's model catalog: listing, sorting, and the suggestion shown when a
// pinned model is rejected. Model ids are `provider/model`; built-in ids start
// with `opencode/` and need no provider key.

import { tryOr } from "../best-effort"
import { isRecord } from "./json"
import { probeVersion } from "./process"

/** A one-shot check that a model is usable, run right after it is pinned. */
export const MODEL_PROBE_PROMPT = "Reply with the single word: ready."
/** Local, keyless models first; everything else follows opencode's own order. */
const OPENCODE_FIRST = "opencode/"
/** Shown only when the CLI cannot list a concrete alternative. */
const MODEL_ERROR_HINT = "opencode rejected the model. See /models opencode, then /connect opencode <model>."

/** A model error names the model, the fix, and one concrete model to try. */
export function modelErrorHint(model: string, message: string, recommended?: string): string {
  const line =
    model === ""
      ? `opencode rejected its model: ${message}`
      : `opencode rejected ${model}${model.includes("/") ? ` from ${model.slice(0, model.indexOf("/"))}` : ""}: ${message}`
  return `${line}\n${recommended === undefined ? MODEL_ERROR_HINT : `try /connect opencode ${recommended} (see /models opencode)`}`
}

/**
 * The model to suggest when one fails: a built-in opencode model first (they
 * need no provider key), then any listed model, never the one that just failed.
 */
export function recommendOpencodeModel(models: string[], exclude?: string): string | undefined {
  const usable = models.filter((id) => id !== exclude)
  return (
    usable.find((id) => id.startsWith(OPENCODE_FIRST) && id.includes("free")) ??
    usable.find((id) => id.startsWith(OPENCODE_FIRST)) ??
    usable[0]
  )
}

/** Parse one `models` output: ids one per line, or a JSON array of ids. */
export function parseModelList(stdout: string): string[] {
  const text = stdout.trim()
  if (text === "") return []
  const parsed = tryOr(() => JSON.parse(text) as unknown, undefined)
  const raw = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.models)
      ? parsed.models
      : undefined
  const ids: string[] = []
  for (const entry of raw ?? []) {
    const id =
      typeof entry === "string" ? entry : isRecord(entry) && typeof entry.id === "string" ? entry.id : ""
    if (id !== "") ids.push(id)
  }
  if (raw !== undefined) return sortModels(ids)
  return sortModels(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((id) => id !== ""),
  )
}

/** Keyless local models first, then the provider's order, without duplicates. */
function sortModels(ids: string[]): string[] {
  const seen = new Set<string>()
  const unique = ids.filter((id) => {
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
  return [
    ...unique.filter((id) => id.startsWith(OPENCODE_FIRST)),
    ...unique.filter((id) => !id.startsWith(OPENCODE_FIRST)),
  ]
}

/** `models`, keyless local ones first: the CLI's own list. */
export function listOpencodeModels(command: string, serverUrl: () => string | null): string[] {
  if (probeVersion(command) === null) return []
  const argv = [command, "models"]
  const server = serverUrl()
  if (server !== null) argv.push("--server", server)
  const stdout = tryOr(() => {
    const proc = Bun.spawnSync(argv, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env },
    })
    return proc.exitCode === 0 ? proc.stdout.toString() : ""
  }, "")
  return parseModelList(stdout)
}
