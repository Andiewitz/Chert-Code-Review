// Connectors: direct LLM provider support for the prompt's plain-text mode.
// Every supported provider exposes an OpenAI-compatible chat completions API,
// so a single client covers OpenRouter, Google Gemini, Groq, and NVIDIA NIM.
// Keys resolve from ~/.chert/connectors.json (CHERT_CONFIG_DIR overrides the
// directory, which keeps tests hermetic) or from environment variables.

import { join } from "node:path"
import { tailLines } from "./agent"
import { configDir, readJson, writeJsonAtomic } from "./config"

export interface ProviderDef {
  id: string
  aliases?: string[]
  label: string
  /** OpenAI-compatible base URL, no trailing slash. */
  baseUrl: string
  defaultModel: string
  envKeys: string[]
  keyUrl: string
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
    envKeys: ["OPENROUTER_API_KEY"],
    keyUrl: "https://openrouter.ai/keys",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.5-flash",
    envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    keyUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    envKeys: ["GROQ_API_KEY"],
    keyUrl: "https://console.groq.com/keys",
  },
  {
    id: "nim",
    aliases: ["nvidia"],
    label: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    defaultModel: "meta/llama-3.3-70b-instruct",
    envKeys: ["NVIDIA_API_KEY", "NIM_API_KEY"],
    keyUrl: "https://build.nvidia.com",
  },
]

export function findProvider(idOrAlias: string): ProviderDef | undefined {
  const needle = idOrAlias.toLowerCase()
  return PROVIDERS.find((p) => p.id === needle || p.aliases?.includes(needle))
}

// ---------------------------------------------------------------------------
// Key storage
// ---------------------------------------------------------------------------

interface StoredConfig {
  providers?: Record<string, { key?: string }>
  active?: { connector: string; model?: string }
}

function configFile(): string {
  return join(configDir(), "connectors.json")
}

function loadConfig(): StoredConfig {
  return readJson<StoredConfig>(configFile()) ?? {}
}

function saveConfig(config: StoredConfig): void {
  try {
    writeJsonAtomic(configFile(), config, { mode: 0o600 })
  } catch (error) {
    throw new Error(
      `could not write ${configFile()}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** Where a usable key comes from: a saved file entry or an env variable. */
export function keySource(providerId: string): "saved" | "env" | undefined {
  const stored = loadConfig().providers?.[providerId]?.key
  if (stored) return "saved"
  const provider = findProvider(providerId)
  if (provider && provider.envKeys.some((name) => (process.env[name] ?? "") !== "")) return "env"
  return undefined
}

export function resolveKey(providerId: string): string | undefined {
  const stored = loadConfig().providers?.[providerId]?.key
  if (stored) return stored
  const provider = findProvider(providerId)
  if (!provider) return undefined
  for (const name of provider.envKeys) {
    const value = process.env[name]
    if (value !== undefined && value !== "") return value
  }
  return undefined
}

export function saveProviderKey(providerId: string, key: string): void {
  const provider = findProvider(providerId)
  if (!provider) throw new Error(`unknown provider "${providerId}"`)
  const config = loadConfig()
  config.providers = { ...config.providers, [provider.id]: { ...config.providers?.[provider.id], key } }
  saveConfig(config)
}

export function clearProviderKey(providerId: string): void {
  const provider = findProvider(providerId)
  if (!provider) throw new Error(`unknown provider "${providerId}"`)
  const config = loadConfig()
  if (config.providers?.[provider.id] !== undefined) {
    const { [provider.id]: _removed, ...rest } = config.providers
    config.providers = rest
    saveConfig(config)
  }
}

// ---------------------------------------------------------------------------
// Active connector
// ---------------------------------------------------------------------------

export function getActive(): { connector: string; model?: string } {
  const stored = loadConfig().active
  if (
    stored !== undefined &&
    (stored.connector === "opencode" || findProvider(stored.connector) !== undefined)
  ) {
    return stored
  }
  return { connector: "opencode" }
}

export function setActive(connector: string, model?: string): void {
  const config = loadConfig()
  config.active = { connector, ...(model !== undefined && model !== "" ? { model } : {}) }
  saveConfig(config)
}

// ---------------------------------------------------------------------------
// OpenAI-compatible API calls
// ---------------------------------------------------------------------------

export async function chatCompletion(
  provider: ProviderDef,
  key: string,
  model: string,
  system: string,
  prompt: string,
): Promise<string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  }
  if (provider.id === "openrouter") headers["X-Title"] = "chert"

  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(
      `${provider.label} API error ${response.status}${body !== "" ? `: ${tailLines(body.trim(), 3)}` : ""}`,
    )
  }
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const content = data.choices?.[0]?.message?.content
  if (content === undefined || content === "") {
    throw new Error(`${provider.label} returned no content`)
  }
  return content.trim()
}

export async function listModels(provider: ProviderDef, key: string): Promise<string[]> {
  const response = await fetch(`${provider.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${key}` },
  })
  if (!response.ok) {
    throw new Error(`${provider.label} API error ${response.status}`)
  }
  const data = (await response.json()) as { data?: Array<{ id?: string }> }
  const ids = (data.data ?? []).map((m) => m.id ?? "").filter((id) => id !== "")
  // Gemini's compatible endpoint lists ids like "models/gemini-2.0-flash";
  // chat completions expects the bare model name.
  if (provider.id === "gemini") {
    return ids.map((id) => (id.startsWith("models/") ? id.slice("models/".length) : id))
  }
  return ids
}
