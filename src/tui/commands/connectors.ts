// Connector commands: /connect, /disconnect, /use and /models.
// opencode is a connector like the API-key providers: it needs no key, its
// model is pinned with /connect opencode <model> and checked with one real call.

import {
  PROVIDERS,
  clearConnectorModel,
  clearProviderKey,
  findProvider,
  keySource,
  listModels,
  resolveKey,
  saveProviderKey,
  setActive,
  storedModel,
} from "../../connectors"
import { createOpencodeHarness } from "../../harness/opencode"
import { recommendOpencodeModel } from "../../harness/opencode-models"
import type { HarnessAdapter, HarnessDetection } from "../../harness/types"
import { MAX_COMMAND_OUTPUT_LINES } from "../../limits"
import { headLines } from "../../text"
import type { CommandContext } from "./context"

const OPENCODE = "opencode"
const PROVIDER_IDS = () => PROVIDERS.map((provider) => provider.id).join(", ")

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The one opencode adapter this process uses for detection and pinning. */
function harness(): HarnessAdapter {
  return createOpencodeHarness()
}

/** A concrete pin command, or the shape to fill in when nothing is listed. */
function pinCommand(models: string[], exclude?: string): string {
  const model = recommendOpencodeModel(models, exclude)
  return model === undefined ? `/connect ${OPENCODE} <model>` : `/connect ${OPENCODE} ${model}`
}

/** How opencode is set up, in the same words the status row uses. */
function opencodeDetails(ctx: CommandContext, version: string | null, ids: string[]): string[] {
  const pinned = ctx.model() ?? ""
  const lines = [
    `${OPENCODE} (${version ?? "not installed"})`,
    `  model: ${pinned === "" ? "default (opencode's own)" : pinned}`,
  ]
  lines.push(
    pinned === ""
      ? `  recommended: ${pinCommand(ids)}`
      : `  check it: /models ${OPENCODE} · clear it: /disconnect ${OPENCODE}`,
  )
  return lines
}

export function connectCommand(ctx: CommandContext): void {
  if (ctx.args === "") {
    ctx.setView("log")
    ctx.addEntry("system", ctx.connectorsStatus())
    return
  }

  const [token, ...rest] = ctx.args.split(/\s+/)
  if (token === OPENCODE) {
    connectOpencode(ctx, rest.join(" ").trim())
    return
  }

  const provider = findProvider(token)
  if (!provider) {
    ctx.showError(`unknown provider "${token}" — providers: ${OPENCODE}, ${PROVIDER_IDS()}`)
    return
  }

  const key = rest.join(" ").trim()
  if (key === "") {
    ctx.setView("log")
    const source = keySource(provider.id)
    const keyLine =
      source === "saved"
        ? "saved"
        : source === "env"
          ? `env (${provider.envKeys.join(" or ")})`
          : "not configured"
    ctx.addEntry(
      "system",
      [
        `${provider.label} (${provider.id})`,
        `  key: ${keyLine}`,
        `  default model: ${provider.defaultModel}`,
        `  get a key: ${provider.keyUrl}`,
        `  save it: /connect ${provider.id} <key>`,
      ].join("\n"),
    )
    return
  }

  try {
    saveProviderKey(provider.id, key)
    ctx.showNotice(`saved ${provider.label} key`)
    ctx.setStatus(`✓ ${provider.id} connected`)
  } catch (error) {
    ctx.showError(describeError(error))
  }
}

/** `/connect opencode [model]`: activate it, or pin and verify a model. */
function connectOpencode(ctx: CommandContext, model: string): void {
  const adapter = harness()
  ctx.setView("log")
  if (model !== "") {
    void adapter.detect().then((found) => pinOpencodeModel(ctx, adapter, model, found))
    return
  }
  // A bare /connect opencode chooses it, reusing whatever model was saved.
  try {
    const active = setActive(OPENCODE)
    ctx.setConnector(OPENCODE, active.model)
    ctx.setStatus(`connector: ${ctx.activeLabel()}`)
  } catch (error) {
    ctx.showError(describeError(error))
    return
  }
  void adapter.detect().then((found) => {
    for (const line of opencodeDetails(ctx, found.version, adapter.listModels?.() ?? [])) {
      ctx.addEntry("system", line)
    }
  })
}

/** Save a model only after opencode answers once with it. */
async function pinOpencodeModel(
  ctx: CommandContext,
  adapter: HarnessAdapter,
  model: string,
  found: HarnessDetection,
): Promise<void> {
  if (!found.available) {
    ctx.showError(found.reason ?? "opencode is not installed")
    return
  }
  if (adapter.probeModel === undefined) {
    ctx.showError("this opencode cannot check a model; upgrade opencode and try again")
    return
  }
  ctx.setStatus(`checking ${model}…`)
  try {
    await adapter.probeModel(model, ctx.projectRoot())
    const active = setActive(OPENCODE, model)
    ctx.setConnector(OPENCODE, active.model)
    ctx.showNotice(`saved opencode model ${model}`)
    ctx.setStatus(`connector: ${ctx.activeLabel()}`)
  } catch (error) {
    // The harness names a replacement; a stubbed probe gets one added here.
    const message = describeError(error)
    const hint = message.includes(`/connect ${OPENCODE}`)
      ? ""
      : `\ntry ${pinCommand(adapter.listModels?.() ?? [], model)}`
    ctx.showError(message + hint)
    ctx.setStatus("")
  }
}

export function disconnectCommand(ctx: CommandContext): void {
  const id = ctx.args.trim()
  if (id === OPENCODE) {
    const wasActive = ctx.connectorId() === OPENCODE
    if (!clearConnectorModel(OPENCODE)) {
      ctx.showNotice("opencode has no saved model; it keeps using its own default")
      return
    }
    if (wasActive) {
      ctx.setConnector(OPENCODE, undefined)
      ctx.setStatus(`connector: ${ctx.activeLabel()}`)
    }
    ctx.showNotice("cleared the opencode model; it uses its own default again")
    return
  }
  const provider = findProvider(id)
  if (!provider) {
    ctx.showError(`unknown provider "${id}" — providers: ${OPENCODE}, ${PROVIDER_IDS()}`)
    return
  }
  try {
    clearProviderKey(provider.id)
    ctx.showNotice(`cleared saved key for ${provider.label} (env vars still apply)`)
    ctx.setStatus("")
  } catch (error) {
    ctx.showError(describeError(error))
  }
}

/** /use: no argument or "opencode" returns to the local CLI, pin included. */
export function useCommand(ctx: CommandContext): void {
  const [id, ...modelParts] = ctx.args.split(/\s+/)
  const model = modelParts.join(" ").trim()
  if (id === "" || id === OPENCODE) {
    try {
      // Switching back reuses the model remembered for opencode.
      const active = setActive(OPENCODE, model === "" ? undefined : model)
      ctx.setConnector(OPENCODE, active.model)
      ctx.setStatus(`connector: ${ctx.activeLabel()}`)
    } catch (error) {
      ctx.showError(describeError(error))
    }
    return
  }

  const provider = findProvider(id)
  if (!provider) {
    ctx.showError(`unknown connector "${id}" — connectors: ${OPENCODE}, ${PROVIDER_IDS()}`)
    return
  }
  if (resolveKey(provider.id) === undefined) {
    ctx.showError(`no API key for ${provider.label} — /connect ${provider.id} <key> first`)
    return
  }

  try {
    // A remembered provider model survives a trip to another connector.
    const active = setActive(provider.id, model === "" ? undefined : model)
    ctx.setConnector(provider.id, active.model)
    ctx.setStatus(`connector: ${ctx.activeLabel()}`)
  } catch (error) {
    ctx.showError(describeError(error))
  }
}

/** `/models opencode [filter]`: the built-in models first, with a pin to copy. */
function opencodeModels(ctx: CommandContext, filter: string): void {
  const adapter = harness()
  const ids = adapter.listModels?.() ?? []
  ctx.setView("log")
  const needle = filter.toLowerCase()
  const shown = needle === "" ? ids : ids.filter((id) => id.toLowerCase().includes(needle))
  if (shown.length === 0) {
    ctx.addEntry(
      "system",
      filter === ""
        ? `${OPENCODE}: no models (is the CLI installed?)`
        : `${OPENCODE}: no models match "${filter}"`,
    )
    return
  }
  const isActive = ctx.connectorId() === OPENCODE
  const current = isActive ? ctx.model() : storedModel(OPENCODE)
  const marked = shown.map((id) => {
    if (id !== current) return id
    return `${id}  ← ${isActive ? "active" : "saved"}`
  })
  const lines = [
    `${OPENCODE} models${filter === "" ? "" : ` matching "${filter}"`} (${shown.length}):`,
    headLines(marked.join("\n"), MAX_COMMAND_OUTPUT_LINES),
  ]
  const suggested = recommendOpencodeModel(shown, current)
  if (suggested !== undefined) lines.push(`pin one: /connect ${OPENCODE} ${suggested}`)
  ctx.addEntry("system", lines.join("\n"))
}

export function modelsCommand(ctx: CommandContext): void {
  const [connectorArg, ...filterParts] = ctx.args.split(/\s+/)
  const filter = filterParts.join(" ").trim()
  const target = connectorArg === "" ? ctx.connectorId() : connectorArg
  if (target === OPENCODE) {
    opencodeModels(ctx, filter)
    return
  }
  const provider = findProvider(target)
  if (!provider) {
    ctx.showError(
      `usage: /models [${OPENCODE}|<provider>] [filter] — providers: ${OPENCODE}, ${PROVIDER_IDS()}`,
    )
    return
  }
  const key = resolveKey(provider.id)
  if (key === undefined) {
    ctx.showError(`no API key for ${provider.label} — /connect ${provider.id} <key> first`)
    return
  }

  ctx.setView("log")
  ctx.setStatus(`${provider.id}: listing models…`)
  void listModels(provider, key)
    .then((ids) => {
      const needle = filter.toLowerCase()
      const shown = needle === "" ? ids : ids.filter((id) => id.toLowerCase().includes(needle))
      ctx.addEntry(
        "system",
        shown.length === 0
          ? `${provider.label}: ${filter === "" ? "no models" : `no models match "${filter}"`}`
          : `${provider.label} models${filter === "" ? "" : ` matching "${filter}"`} (${shown.length}):\n${headLines(shown.join("\n"), MAX_COMMAND_OUTPUT_LINES)}`,
      )
      ctx.setStatus("")
    })
    .catch((error) => {
      ctx.showError(describeError(error))
      ctx.setStatus("")
    })
}
