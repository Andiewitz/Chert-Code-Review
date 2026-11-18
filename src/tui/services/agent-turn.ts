// One turn of plain conversation with whichever connector is active: build the
// request, call opencode or an OpenAI-compatible provider, and report the text.
// AI notes only come from the walk protocol, so an answer here is prose and
// nothing else: there is one agent-output path, and this is not it.

import { chatCompletion, findProvider, resolveKey } from "../../connectors"
import type { ProviderDef } from "../../connectors"
import { PROVIDERS } from "../../connectors"
import { createOpencodeHarness } from "../../harness/opencode"
import { MAX_AGENT_ANSWER_LINES } from "../../limits"
import { tailLines } from "../../text"

/** One adapter for the whole process, so detection is probed once. */
const opencode = createOpencodeHarness()

export interface AgentTurnRequest {
  prompt: string
  /** "opencode" or a provider id. */
  connectorId: string
  /** Explicit model for a provider; defaults to the provider's default. */
  model: string | undefined
  projectRoot: string
  changedFiles: string[]
  /** Called when the provider (and model) is known, for the status line prefix. */
  onPrefixChange?: (prefix: string) => void
}

export interface AgentTurnResult {
  /** The answer, or a ready-to-show error message. */
  text: string
  isError: boolean
}

/** The single wording used whenever there is no usable AI connection. */
function noAiConnectedMessage(provider: ProviderDef): string {
  return `No AI is connected yet. Easiest: get a free key at ${provider.keyUrl}, then type /connect ${provider.id} YOUR_KEY and then /use ${provider.id}.`
}

function failed(text: string): AgentTurnResult {
  return { text, isError: true }
}

export async function runAgentTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
  const { connectorId } = request

  if (connectorId === "opencode") {
    if (!opencode.detect().available) {
      return failed(noAiConnectedMessage(PROVIDERS[0]))
    }
    const answer = await opencode.askOnce(request.projectRoot, request.prompt)
    return { text: tailLines(answer.trim(), MAX_AGENT_ANSWER_LINES), isError: false }
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
  return { text: await chatCompletion(provider, key, model, system, request.prompt), isError: false }
}
