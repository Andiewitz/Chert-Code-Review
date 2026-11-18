// Connector commands: /connect, /disconnect, /use and /models.

import {
  PROVIDERS,
  clearProviderKey,
  findProvider,
  keySource,
  listModels,
  resolveKey,
  saveProviderKey,
  setActive,
} from "../../connectors"
import { MAX_COMMAND_OUTPUT_LINES } from "../../limits"
import { tailLines } from "../../text"
import type { CommandContext } from "./context"

const providerIds = () => PROVIDERS.map((provider) => provider.id).join(", ")

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function connectCommand(ctx: CommandContext): void {
  ctx.setView("log")
  if (ctx.args === "") {
    ctx.addEntry("system", ctx.connectorsStatus())
    return
  }

  const [providerToken, ...keyParts] = ctx.args.split(/\s+/)
  const provider = findProvider(providerToken)
  if (!provider) {
    ctx.addEntry("error", `unknown provider "${providerToken}" — providers: ${providerIds()}`)
    return
  }

  const key = keyParts.join(" ").trim()
  if (key === "") {
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
    ctx.addEntry("system", `saved ${provider.label} key`)
    ctx.setStatus(`✓ ${provider.id} connected`)
  } catch (error) {
    ctx.addEntry("error", describeError(error))
  }
}

export function disconnectCommand(ctx: CommandContext): void {
  ctx.setView("log")
  const provider = findProvider(ctx.args.trim())
  if (!provider) {
    ctx.addEntry("error", `unknown provider "${ctx.args}" — providers: ${providerIds()}`)
    return
  }
  try {
    clearProviderKey(provider.id)
    ctx.addEntry("system", `cleared saved key for ${provider.label} (env vars still apply)`)
    ctx.setStatus("")
  } catch (error) {
    ctx.addEntry("error", describeError(error))
  }
}

/** /use: no argument or "opencode" returns to the local CLI. */
export function useCommand(ctx: CommandContext): void {
  const [id, ...modelParts] = ctx.args.split(/\s+/)
  if (id === "" || id === "opencode") {
    ctx.setConnector("opencode", undefined)
    setActive("opencode")
    ctx.setStatus("connector: opencode")
    return
  }

  ctx.setView("log")
  const provider = findProvider(id)
  if (!provider) {
    ctx.addEntry("error", `unknown connector "${id}" — connectors: opencode, ${providerIds()}`)
    return
  }
  if (resolveKey(provider.id) === undefined) {
    ctx.addEntry("error", `no API key for ${provider.label} — /connect ${provider.id} <key> first`)
    return
  }

  const model = modelParts.join(" ").trim()
  ctx.setConnector(provider.id, model === "" ? undefined : model)
  setActive(provider.id, model === "" ? undefined : model)
  ctx.setStatus(`connector: ${ctx.activeLabel()}`)
}

export function modelsCommand(ctx: CommandContext): void {
  const provider =
    findProvider(ctx.args.trim()) ??
    (ctx.connectorId() !== "opencode" ? findProvider(ctx.connectorId()) : undefined)
  if (!provider) {
    ctx.addEntry("error", `usage: /models <provider> — providers: ${providerIds()}`)
    ctx.setView("log")
    return
  }
  const key = resolveKey(provider.id)
  if (key === undefined) {
    ctx.addEntry("error", `no API key for ${provider.label} — /connect ${provider.id} <key> first`)
    ctx.setView("log")
    return
  }

  ctx.setView("log")
  ctx.setStatus(`${provider.id}: listing models…`)
  void listModels(provider, key)
    .then((ids) => {
      ctx.addEntry(
        "system",
        ids.length === 0
          ? `${provider.label}: no models`
          : `${provider.label} models:\n${tailLines(ids.join("\n"), MAX_COMMAND_OUTPUT_LINES)}`,
      )
      ctx.setStatus("")
    })
    .catch((error) => {
      ctx.addEntry("error", describeError(error))
      ctx.setStatus("")
    })
}
