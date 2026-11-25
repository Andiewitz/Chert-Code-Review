// The opencode server connection: the URL chert resolves from the environment
// and the health probe that proves a configured server is up before a call.

import { isRecord } from "./json"

/** A health probe should answer or fail fast; it runs before every request. */
const HEALTH_TIMEOUT_MS = 1_500

/** The server CHERT_OPENCODE_SERVER points at, or null for the background service. */
export function resolveServerUrl(raw?: string): string | null {
  const value = (raw ?? process.env.CHERT_OPENCODE_SERVER ?? "").trim()
  if (value === "") return null
  const withScheme = /^https?:\/\//i.test(value) ? value : `http://${value}`
  return withScheme.replace(/\/+$/, "")
}

export interface ServerHealth {
  ok: boolean
  version: string | null
}

/**
 * Ask the server whether it is up. A refused or slow connection is "not up".
 * v2 serves its web UI for unknown paths, so a 2xx proves the server is there
 * even when the body is not the JSON a v1 server would return.
 */
export async function probeServer(url: string, timeoutMs = HEALTH_TIMEOUT_MS): Promise<ServerHealth> {
  try {
    const response = await fetch(`${url}/global/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return { ok: false, version: null }
    const body: unknown = await response.json().catch(() => null)
    if (!isRecord(body)) return { ok: true, version: null }
    return {
      ok: body.healthy !== false,
      version: typeof body.version === "string" ? body.version : null,
    }
  } catch {
    return { ok: false, version: null }
  }
}
