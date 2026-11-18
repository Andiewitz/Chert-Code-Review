// One turn of conversation with whichever connector is active: build the
// request, call opencode or an OpenAI-compatible provider, and split any
// chert-highlights block out of the answer. The TUI owns all state; this module
// only performs the call and reports what came back.

import { opencodeAvailable, runAgent } from "../../agent"
import { chatCompletion, findProvider, resolveKey } from "../../connectors"
import type { ProviderDef } from "../../connectors"
import { parseAgentHighlights } from "../../highlights"
import type { Highlight } from "../../highlights"
import { PROVIDERS } from "../../connectors"

export interface AgentTurnRequest {
  prompt: string
  /** "opencode" or a provider id. */
  connectorId: string
  /** Explicit model for a provider; defaults to the provider's default. */
  model: string | undefined
  projectRoot: string
  changedFiles: string[]
  /** Diff rows for a changed file, used to validate AI highlights. */
  getRows: (path: string) => { kind: string; oldNo?: number; newNo?: number; text: string }[] | undefined
  existingHighlights: Highlight[]
  /** Called when the provider (and model) is known, for the status line prefix. */
  onPrefixChange?: (prefix: string) => void
}

export interface AgentTurnResult {
  /** Cleaned answer, or a ready-to-show error message. */
  text: string
  isError: boolean
  /** New highlights to append; never persisted here. */
  highlights: Highlight[]
  /** Why individual highlights were rejected, for the status line. */
  skipped: string[]
}

/** The single wording used whenever there is no usable AI connection. */
export function noAiConnectedMessage(provider: ProviderDef): string {
  return `No AI is connected yet. Easiest: get a free key at ${provider.keyUrl}, then type /connect ${provider.id} YOUR_KEY and then /use ${provider.id}.`
}

function failed(text: string): AgentTurnResult {
  return { text, isError: true, highlights: [], skipped: [] }
}

function withParsedHighlights(answer: string, request: AgentTurnRequest): AgentTurnResult {
  const parsed = parseAgentHighlights(
    answer,
    request.changedFiles,
    request.getRows,
    request.existingHighlights,
  )
  return { text: parsed.cleanText, isError: false, highlights: parsed.highlights, skipped: parsed.skipped }
}

export async function runAgentTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
  const { connectorId } = request

  if (connectorId === "opencode") {
    if (!opencodeAvailable()) {
      return failed(noAiConnectedMessage(PROVIDERS[0]))
    }
    return withParsedHighlights(await runAgent(request.prompt, request.projectRoot), request)
  }

  const provider = findProvider(connectorId)
  if (!provider) {
    return failed(`unknown connector "${connectorId}"`)
  }
  const key = resolveKey(provider.id)
  if (key === undefined) {
    return failed(noAiConnectedMessage(provider))
  }

  const model = request.model ?? provider.defaultModel
  request.onPrefixChange?.(`${provider.id} ${model}: Thinking… `)
  const system =
    `You are chert's code-review assistant. Current project directory: ${request.projectRoot}. ` +
    `Locally changed files: ${request.changedFiles.join(", ") || "none"}.`
  return withParsedHighlights(await chatCompletion(provider, key, model, system, request.prompt), request)
}
