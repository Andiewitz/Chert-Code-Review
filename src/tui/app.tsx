import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { render, useKeyboard, useRenderer } from "@opentui/solid"
import { extToFiletype, getTreeSitterClient } from "@opentui/core"
import type { InputRenderable, ScrollBoxRenderable, SelectOption, SelectRenderable } from "@opentui/core"
import { realpathSync } from "node:fs"
import { basename, resolve } from "node:path"
import { currentBranch, listChangedFiles, loadPatch } from "../git"
import type { ReviewFile } from "../git"
import { buildTreeLines } from "../tree"
import type { TreeLine } from "../tree"
import { opencodeAvailable, runAgent, tailLines } from "../agent"
import {
  PROVIDERS,
  chatCompletion,
  clearProviderKey,
  findProvider,
  getActive,
  keySource,
  listModels,
  resolveKey,
  saveProviderKey,
  setActive,
} from "../connectors"
import {
  displayPath,
  enterProject,
  expandPath,
  findReposBelow,
  forgetProject,
  loadRecent,
  resolveProjectRoot,
} from "../projects"

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const COLORS = {
  bg: "#1e1e1e",
  rule: "#3a3a3a",
  dim: "#7a7a7a",
  text: "#d6d6d6",
  bright: "#ffffff",
  selectedBg: "#2e2e2e",
  accent: "#7aa2f7",
  danger: "#cc6666",
}

const STATUS_GLYPH: Record<ReviewFile["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  untracked: "??",
}

type EntryKind = "user" | "agent" | "system" | "error"

const ENTRY_FG: Record<EntryKind, string> = {
  user: COLORS.accent,
  agent: COLORS.text,
  system: COLORS.dim,
  error: COLORS.danger,
}

interface CommandDef {
  name: string
  aliases?: string[]
  usage: string
  description: string
  takesArg?: boolean
}

const COMMAND_DEFS: CommandDef[] = [
  { name: "help", usage: "/help", description: "show this list" },
  { name: "refresh", usage: "/refresh", description: "re-scan the working tree" },
  { name: "open", usage: "/open <query>", description: "jump to a file (path match)", takesArg: true },
  { name: "run", usage: "/run <command>", description: "run a shell command in the current project", takesArg: true },
  { name: "cd", usage: "/cd <dir>", description: "switch project directory", takesArg: true },
  { name: "project", usage: "/project [path]", description: "open project picker or switch to a project", takesArg: true },
  { name: "cwd", usage: "/cwd", description: "show the current project" },
  { name: "tree", usage: "/tree", description: "show the whole project tree" },
  { name: "connect", usage: "/connect [provider [key]]", description: "connector status / save a provider key", takesArg: true },
  { name: "disconnect", usage: "/disconnect <provider>", description: "remove a saved provider key", takesArg: true },
  { name: "use", usage: "/use <connector> [model]", description: "route plain-text prompts (opencode or a provider)", takesArg: true },
  { name: "models", usage: "/models [provider]", description: "list a provider's models", takesArg: true },
  { name: "quit", aliases: ["exit", "q"], usage: "/quit", description: "exit chert (Ctrl+C also works)" },
]

function buildHelpText(): string {
  const pad = Math.max(...COMMAND_DEFS.map((c) => c.usage.length)) + 2
  return [
    "commands:",
    ...COMMAND_DEFS.map((c) => `  ${c.usage.padEnd(pad)}${c.description}`),
    "connectors: opencode (default) · openrouter · gemini · groq · nim",
    "plain text (no /) goes to the active connector.",
  ].join("\n")
}

const HELP_TEXT = buildHelpText()

function resolveCommand(token: string): CommandDef | undefined {
  const t = token.toLowerCase()
  return COMMAND_DEFS.find((d) => d.name === t || d.aliases?.includes(t))
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i)
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0]
    dp[0] = j
    for (let i = 1; i <= a.length; i++) {
      const tmp = dp[i]
      dp[i] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[i], dp[i - 1])
      prev = tmp
    }
  }
  return dp[a.length]
}

function closestCommand(token: string): CommandDef | undefined {
  const t = token.toLowerCase()
  let best: { def: CommandDef; d: number } | undefined
  for (const def of COMMAND_DEFS) {
    for (const cand of [def.name, ...(def.aliases ?? [])]) {
      const d = levenshtein(t, cand)
      if (best === undefined || d < best.d) best = { def, d }
    }
  }
  return best?.def
}

function isCloseAutocorrect(token: string, def: CommandDef): boolean {
  const t = token.toLowerCase()
  const names = [def.name, ...(def.aliases ?? [])]
  const d = Math.min(...names.map((n) => levenshtein(t, n)))
  return d <= 1 || (d <= 2 && t.length >= 4 && names.some((n) => n.length >= 4))
}

function scoreCommand(def: CommandDef, query: string): number {
  const q = query.toLowerCase()
  if (q === "") return 1
  let best = 0
  for (const name of [def.name, ...(def.aliases ?? [])]) {
    if (name === q) best = Math.max(best, 100)
    else if (name.startsWith(q)) best = Math.max(best, 80)
    else if (name.includes(q)) best = Math.max(best, 50)
  }
  return best
}

function toRealPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

type MainView = "review" | "tree" | "log" | "projects"
type PickerKind = "recent" | "found"
interface PickerItem {
  path: string
  name: string
  kind: PickerKind
}

export function ReviewApp() {
  const renderer = useRenderer()
  const initialRoot = (() => {
    try {
      return resolveProjectRoot(process.cwd())
    } catch {
      return undefined
    }
  })()

  const [files, setFiles] = createSignal<ReviewFile[] | null>(null)
  const [loadError, setLoadError] = createSignal<string | null>(null)
  const [selected, setSelected] = createSignal(0)
  const [patch, setPatch] = createSignal("")
  const [treeLines, setTreeLines] = createSignal<TreeLine[]>([])
  const [treeIndex, setTreeIndex] = createSignal(0)
  const [view, setView] = createSignal<MainView>(initialRoot ? "review" : "projects")
  const [mode, setMode] = createSignal<"prompt" | "browse">("prompt")
  const [previousView, setPreviousView] = createSignal<"review" | "tree" | "log">("review")
  const [hasProject, setHasProject] = createSignal(initialRoot !== undefined)
  const [branch, setBranch] = createSignal("no commits")
  const [transcript, setTranscript] = createSignal<Array<{ kind: EntryKind; text: string }>>([])
  const [status, setStatus] = createSignal("")
  const [cwd, setCwd] = createSignal(process.cwd())
  const [connector, setConnector] = createSignal(getActive().connector)
  const [model, setModel] = createSignal<string | undefined>(getActive().model)
  const [inputValue, setInputValue] = createSignal("")
  const [pickerOpen, setPickerOpen] = createSignal(false)
  const [suggestionIndex, setSuggestionIndex] = createSignal(0)

  const [projectPickerItems, setProjectPickerItems] = createSignal<PickerItem[]>([])
  const [projectPickerIndex, setProjectPickerIndex] = createSignal(0)

  const activeLabel = createMemo(() => {
    const active = connector()
    if (active === "opencode") return "opencode"
    const provider = findProvider(active)
    return provider ? `${provider.id}/${model() ?? provider.defaultModel}` : active
  })

  function footerHints(): string {
    const m = mode()
    const v = view()
    if (m === "browse") {
      if (v === "projects") return "j/k select · Enter open · x forget · i ask · o projects · Ctrl+C quit"
      if (v === "tree") return "j/k rows · Enter open · i ask · Tab views · Ctrl+C quit"
      return "j/k files · space/b scroll · i ask · o projects · Ctrl+C quit"
    }
    if (v === "projects") return "↑↓ select · Enter open · / commands · Tab views · Ctrl+C quit"
    if (v === "tree") return "↑↓ rows · Enter open · / commands · Tab views · Ctrl+C quit"
    return "↑↓ files · Esc browse · / commands · Tab views · Ctrl+C quit"
  }

  const patchCache = new Map<string, string>()
  let patchFor = ""
  let selectRef: SelectRenderable | undefined
  let projectPickerSelectRef: SelectRenderable | undefined
  let diffScrollRef: ScrollBoxRenderable | undefined
  let diffRef: any
  let inputRef: InputRenderable | undefined
  let logRef: ScrollBoxRenderable | undefined
  let treeRef: ScrollBoxRenderable | undefined

  const file = createMemo(() => {
    const list = files()
    if (!list || list.length === 0) return undefined
    return list[Math.min(selected(), list.length - 1)]
  })

  function cwdBase(): string {
    const parts = cwd().split(/[\\/]/)
    return parts[parts.length - 1] || cwd()
  }

  function connectorsStatus(): string {
    const lines = [
      "connectors:",
      `  opencode     ${connector() === "opencode" ? "← active" : ""}  local opencode CLI (no key needed)`,
    ]
    for (const provider of PROVIDERS) {
      const source = keySource(provider.id)
      const isActive = connector() === provider.id
      const useModel = isActive ? model() ?? provider.defaultModel : provider.defaultModel
      lines.push(
        `  ${provider.id.padEnd(12)} ${source === undefined ? "✗ no key" : `✓ key: ${source}`}   ${provider.label} · ${useModel}${isActive ? "  ← active" : ""}`,
      )
    }
    lines.push("save a key: /connect <provider> <key>   ·   switch: /use <connector> [model]")
    return lines.join("\n")
  }

  function addEntry(kind: EntryKind, text: string): void {
    setTranscript((entries) => [...entries, { kind, text }])
  }

  function setPromptValue(value: string): void {
    if (inputRef) inputRef.value = value
    setInputValue(value)
  }

  function clearInput(): void {
    setPromptValue("")
  }

  const commandQuery = createMemo(() => {
    const v = inputValue()
    if (!v.startsWith("/")) return null
    const body = v.slice(1)
    if (/\s/.test(body)) return null
    return body.toLowerCase()
  })

  const filteredCommands = createMemo(() => {
    const q = commandQuery()
    if (q === null) return [] as CommandDef[]
    return COMMAND_DEFS.map((def) => ({ def, score: scoreCommand(def, q) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.def.name.localeCompare(b.def.name))
      .map((x) => x.def)
  })

  const visibleSuggestions = createMemo(() => (pickerOpen() ? COMMAND_DEFS : filteredCommands()))

  createEffect(() => {
    pickerOpen()
    commandQuery()
    setSuggestionIndex(0)
  })

  function acceptSuggestion(cmd: CommandDef | undefined): void {
    if (!cmd) return
    setPromptValue(`/${cmd.name}${cmd.takesArg ? " " : ""}`)
    setPickerOpen(false)
  }

  function refreshProjectPicker(): void {
    try {
      const recents = loadRecent()
      const recentReals = new Set(recents.map((r) => toRealPath(r.path)))
      const items: PickerItem[] = recents.map((r) => ({
        path: resolve(r.path),
        name: basename(resolve(r.path)) || resolve(r.path),
        kind: "recent" as const,
      }))
      const found = findReposBelow(cwd())
      for (const p of found) {
        const abs = resolve(p)
        const real = toRealPath(abs)
        if (recentReals.has(real)) continue
        items.push({ path: abs, name: basename(abs) || abs, kind: "found" })
      }
      setProjectPickerItems(items)
      const next = Math.max(0, Math.min(projectPickerIndex(), Math.max(0, items.length - 1)))
      setProjectPickerIndex(next)
      projectPickerSelectRef?.setSelectedIndex(next)
    } catch {
      setProjectPickerItems([])
      setProjectPickerIndex(0)
    }
  }

  function openProjectPicker(): void {
    if (view() !== "projects") setPreviousView(view() as "review" | "tree" | "log")
    refreshProjectPicker()
    setView("projects")
  }

  function openProjectAt(target: string): boolean {
    try {
      const expanded = expandPath(target, cwd())
      const root = enterProject(expanded)
      if (root === undefined) {
        const msg = `not inside a git repository: ${expanded}`
        if (view() === "projects") {
          setStatus(msg)
        } else {
          addEntry("error", msg)
          setView("log")
        }
        return false
      }
      setCwd(root)
      setHasProject(true)
      load()
      setView("review")
      setStatus(`opened ${basename(root) || root}`)
      addEntry("system", `project: ${root}`)
      return true
    } catch (error) {
      const msg = `open failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`
      if (view() === "projects") setStatus(msg)
      else {
        addEntry("error", msg)
        setView("log")
      }
      return false
    }
  }

  function selectProjectPickerIndex(index: number): void {
    const list = projectPickerItems()
    if (list.length === 0) return
    const i = Math.max(0, Math.min(index, list.length - 1))
    setProjectPickerIndex(i)
    projectPickerSelectRef?.setSelectedIndex(i)
  }

  function openSelectedProject(): void {
    const item = projectPickerItems()[projectPickerIndex()]
    if (!item) return
    openProjectAt(item.path)
  }

  function forgetSelectedProject(): void {
    const item = projectPickerItems()[projectPickerIndex()]
    if (!item) {
      setStatus("no project selected")
      return
    }
    if (item.kind !== "recent") {
      setStatus("not a recent project")
      return
    }
    try {
      forgetProject(item.path)
    } catch {
      // ignore
    }
    refreshProjectPicker()
    setStatus(`forgot ${item.name}`)
  }

  // Synchronous loads: git is fast, and sync state updates render
  // deterministically regardless of the host renderer's event loop.
  function load(): void {
    setFiles(null)
    setLoadError(null)
    setPatch("")
    patchCache.clear()
    patchFor = ""
    setSelected(0)
    try {
      setFiles(listChangedFiles())
      try {
        setBranch(currentBranch())
      } catch {
        setBranch("no commits")
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
      setBranch("no commits")
    }
    selectFile(0)
    // Rebuild the tree in place when it's on screen (/refresh, /cd).
    if (view() === "tree") {
      try {
        setTreeLines(buildTreeLines(changedGlyphs()))
        setTreeIndex(0)
      } catch {
        // Leave the stale tree; /tree or Tab reloads it.
      }
    }
  }

  function selectFile(index: number): void {
    const list = files()
    if (!list || list.length === 0) return
    const i = Math.max(0, Math.min(index, list.length - 1))
    setSelected(i)
    selectRef?.setSelectedIndex(i)
    const current = list[i]
    if (patchFor === current.path) return
    const cached = patchCache.get(current.path)
    if (cached !== undefined) {
      setPatch(cached)
      patchFor = current.path
      return
    }
    try {
      const result = loadPatch(current)
      patchCache.set(current.path, result)
      setPatch(result)
      patchFor = current.path
    } catch (error) {
      setPatch(`Error loading diff for ${current.path}: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      diffScrollRef?.scrollTo({ x: 0, y: 0 })
    } catch {
      // ignore
    }
  }

  function navigate(delta: number): void {
    selectFile(selected() + delta)
  }

  function changedGlyphs(): Map<string, string> {
    const map = new Map<string, string>()
    for (const f of files() ?? []) map.set(f.path, STATUS_GLYPH[f.status])
    return map
  }

  function loadTree(): void {
    try {
      setTreeLines(buildTreeLines(changedGlyphs()))
      setTreeIndex(0)
      setView("tree")
    } catch (error) {
      addEntry("error", `tree failed: ${error instanceof Error ? error.message : String(error)}`)
      setView("log")
    }
  }

  function moveTreeIndex(delta: number): void {
    const lines = treeLines()
    if (lines.length === 0) return
    const next = Math.max(0, Math.min(treeIndex() + delta, lines.length - 1))
    if (next === treeIndex()) return
    setTreeIndex(next)
    // Keep the selection a few rows inside the viewport on tall trees.
    treeRef?.scrollTo({ x: 0, y: Math.max(0, next - 10) })
  }

  function openTreeSelection(): void {
    const line = treeLines()[treeIndex()]
    if (line === undefined || line.isDir || line.path === undefined) {
      setStatus("select a file in the tree")
      return
    }
    const list = files() ?? []
    const index = list.findIndex((f) => f.path === line.path)
    if (index === -1) {
      setStatus(loadError() !== null ? `no diff for ${line.path}` : `unchanged: ${line.path}`)
      return
    }
    setView("review")
    selectFile(index)
    setStatus(`→ ${line.path}`)
  }

  if (initialRoot) {
    load()
  } else {
    refreshProjectPicker()
  }

  function submit(): void {
    const raw = (inputRef?.value ?? "").trim()
    if (raw === "") return
    clearInput()
    if (raw.startsWith("/")) {
      runCommand(raw.slice(1).trim())
    } else if (view() === "projects") {
      openProjectAt(raw)
    } else {
      void askAgent(raw)
    }
  }

  async function askAgent(prompt: string): Promise<void> {
    addEntry("user", prompt)
    setView("log")
    const active = connector()
    if (active === "opencode") {
      if (!opencodeAvailable()) {
        addEntry("error", "opencode CLI not found — install it (https://opencode.ai) or /connect a provider (openrouter, gemini, groq, nim)")
        setStatus("")
        return
      }
      setStatus("agent: thinking…")
      try {
        addEntry("agent", await runAgent(prompt, cwd()))
        setStatus("")
      } catch (error) {
        addEntry("error", error instanceof Error ? error.message : String(error))
        setStatus("agent: failed")
      }
      return
    }
    const provider = findProvider(active)
    if (!provider) {
      addEntry("error", `unknown connector "${active}"`)
      setStatus("")
      return
    }
    const key = resolveKey(provider.id)
    if (key === undefined) {
      addEntry("error", `no API key for ${provider.label} — /connect ${provider.id} <key> or set ${provider.envKeys[0]}`)
      setStatus("")
      return
    }
    const useModel = model() ?? provider.defaultModel
    setStatus(`${provider.id} ${useModel}: thinking…`)
    const system = `You are chert's code-review assistant. Current project directory: ${cwd()}. Locally changed files: ${(files() ?? []).map((f) => f.path).join(", ") || "none"}.`
    try {
      addEntry("agent", await chatCompletion(provider, key, useModel, system, prompt))
      setStatus("")
    } catch (error) {
      addEntry("error", error instanceof Error ? error.message : String(error))
      setStatus("agent: failed")
    }
  }

  function runCommand(line: string): void {
    if (line === "") {
      addEntry("system", HELP_TEXT)
      setView("log")
      return
    }
    const [name, ...restParts] = line.split(/\s+/)
    const rest = restParts.join(" ")
    let def = resolveCommand(name)
    if (!def) {
      const t = name.toLowerCase()
      const prefixes = COMMAND_DEFS.filter(
        (d) => d.name.startsWith(t) || (d.aliases ?? []).some((a) => a.startsWith(t)),
      )
      if (t !== "" && prefixes.length === 1) {
        def = prefixes[0]
      } else {
        const close = closestCommand(name)
        if (close && isCloseAutocorrect(name, close)) {
          def = close
        } else if (close) {
          addEntry("error", `unknown command /${name} — did you mean /${close.name}?`)
          setView("log")
          return
        } else {
          addEntry("error", `unknown command /${name} — try /help`)
          setView("log")
          return
        }
      }
      setStatus(`corrected /${name} → /${def.name}`)
    }

    switch (def.name) {
      case "help":
        addEntry("system", HELP_TEXT)
        setView("log")
        return
      case "refresh": {
        if (!hasProject()) {
          addEntry("error", "no project open, use /project")
          setView("log")
          return
        }
        load()
        setStatus(`refreshed ${files()?.length ?? 0} files`)
        return
      }
      case "open": {
        if (!hasProject()) {
          addEntry("error", "no project open, use /project")
          setView("log")
          return
        }
        const query = rest.toLowerCase()
        const list = files() ?? []
        const index = list.findIndex(
          (f) =>
            f.path.toLowerCase() === query ||
            f.path.toLowerCase().endsWith(query) ||
            f.path.toLowerCase().includes(query),
        )
        if (index === -1) {
          addEntry("error", `no file matching "${rest}"`)
          setView("log")
          return
        }
        setView("review")
        selectFile(index)
        setStatus(`→ ${list[index].path}`)
        return
      }
      case "run": {
        if (rest === "") {
          addEntry("error", "usage: /run <command>")
          setView("log")
          return
        }
        setView("log")
        addEntry("user", `/run ${rest}`)
        try {
          const argv = process.platform === "win32" ? ["cmd.exe", "/c", rest] : ["sh", "-c", rest]
          const proc = Bun.spawnSync(argv, { cwd: cwd(), stdout: "pipe", stderr: "pipe" })
          const stdout = proc.stdout.toString().trimEnd()
          const stderr = proc.stderr.toString().trimEnd()
          const combined = `${stdout}${stderr !== "" ? `\n${stderr}` : ""}`.trim()
          addEntry(proc.exitCode === 0 ? "system" : "error", combined === "" ? "(no output)" : tailLines(combined, 30))
          setStatus(proc.exitCode === 0 ? `✓ /run ${rest}` : `✗ /run exited with ${proc.exitCode}`)
        } catch (error) {
          addEntry("error", error instanceof Error ? error.message : String(error))
        }
        return
      }
      case "cd": {
        if (rest === "") {
          addEntry("system", `project: ${cwd()}`)
          setView("log")
          return
        }
        try {
          const target = expandPath(rest, cwd())
          const root = enterProject(target)
          if (root === undefined) {
            addEntry("error", `not inside a git repository: ${target}`)
            setView("log")
            return
          }
          setCwd(root)
          setHasProject(true)
          load()
          if (root !== target) {
            addEntry("system", `project: ${root} (repo root of ${target})`)
          } else {
            addEntry("system", `project: ${root}`)
          }
          setStatus("")
        } catch (error) {
          addEntry("error", `cd failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`)
          setView("log")
        }
        return
      }
      case "project": {
        if (rest === "") {
          openProjectPicker()
          return
        }
        openProjectAt(rest)
        return
      }
      case "cwd":
        addEntry("system", `project: ${cwd()}`)
        setView("log")
        return
      case "tree":
        if (!hasProject()) {
          addEntry("error", "no project open, use /project")
          setView("log")
          return
        }
        loadTree()
        return
      case "connect": {
        setView("log")
        if (rest === "") {
          addEntry("system", connectorsStatus())
          return
        }
        const [providerToken, ...keyParts] = rest.split(/\s+/)
        const provider = findProvider(providerToken)
        if (!provider) {
          addEntry("error", `unknown provider "${providerToken}" — providers: ${PROVIDERS.map((p) => p.id).join(", ")}`)
          return
        }
        const key = keyParts.join(" ").trim()
        if (key === "") {
          const source = keySource(provider.id)
          addEntry(
            "system",
            [
              `${provider.label} (${provider.id})`,
              `  key: ${source === "saved" ? "saved" : source === "env" ? `env (${provider.envKeys.join(" or ")})` : "not configured"}`,
              `  default model: ${provider.defaultModel}`,
              `  get a key: ${provider.keyUrl}`,
              `  save it: /connect ${provider.id} <key>`,
            ].join("\n"),
          )
          return
        }
        try {
          saveProviderKey(provider.id, key)
          addEntry("system", `saved ${provider.label} key`)
          setStatus(`✓ ${provider.id} connected`)
        } catch (error) {
          addEntry("error", error instanceof Error ? error.message : String(error))
        }
        return
      }
      case "disconnect": {
        setView("log")
        const provider = findProvider(rest.trim())
        if (!provider) {
          addEntry("error", `unknown provider "${rest}" — providers: ${PROVIDERS.map((p) => p.id).join(", ")}`)
          return
        }
        try {
          clearProviderKey(provider.id)
          addEntry("system", `cleared saved key for ${provider.label} (env vars still apply)`)
          setStatus("")
        } catch (error) {
          addEntry("error", error instanceof Error ? error.message : String(error))
        }
        return
      }
      case "use": {
        const [id, ...modelParts] = rest.split(/\s+/)
        if (id === "" || id === "opencode") {
          setConnector("opencode")
          setModel(undefined)
          setActive("opencode")
          setStatus("connector: opencode")
          return
        }
        setView("log")
        const provider = findProvider(id)
        if (!provider) {
          addEntry("error", `unknown connector "${id}" — connectors: opencode, ${PROVIDERS.map((p) => p.id).join(", ")}`)
          return
        }
        if (resolveKey(provider.id) === undefined) {
          addEntry("error", `no API key for ${provider.label} — /connect ${provider.id} <key> first`)
          return
        }
        const newModel = modelParts.join(" ").trim()
        setConnector(provider.id)
        setModel(newModel === "" ? undefined : newModel)
        setActive(provider.id, newModel === "" ? undefined : newModel)
        setStatus(`connector: ${activeLabel()}`)
        return
      }
      case "models": {
        const provider = findProvider(rest.trim()) ?? (connector() !== "opencode" ? findProvider(connector()) : undefined)
        if (!provider) {
          addEntry("error", `usage: /models <provider> — providers: ${PROVIDERS.map((p) => p.id).join(", ")}`)
          setView("log")
          return
        }
        const key = resolveKey(provider.id)
        if (key === undefined) {
          addEntry("error", `no API key for ${provider.label} — /connect ${provider.id} <key> first`)
          setView("log")
          return
        }
        setView("log")
        setStatus(`${provider.id}: listing models…`)
        void listModels(provider, key)
          .then((ids) => {
            addEntry("system", ids.length === 0 ? `${provider.label}: no models` : `${provider.label} models:\n${tailLines(ids.join("\n"), 30)}`)
            setStatus("")
          })
          .catch((error) => {
            addEntry("error", error instanceof Error ? error.message : String(error))
            setStatus("")
          })
        return
      }
      case "quit":
        renderer.destroy()
        process.exit(0)
        return
      default:
        addEntry("error", `unknown command /${name} — try /help`)
        setView("log")
    }
  }

  // The prompt input owns keyboard focus. Global handlers run before
  // renderable handlers, so we preventDefault the keys we want for ourselves
  // and let every printable character flow into the input untouched.
  useKeyboard((key) => {
    // Browse mode: single-key shortcuts. Prevent every key from reaching the
    // always-focused prompt input so nothing is typed.
    if (mode() === "browse") {
      if (key.ctrl && key.name === "c") return
      key.preventDefault()

      if (key.name === "j" || key.name === "down") {
        if (view() === "projects") selectProjectPickerIndex(projectPickerIndex() + 1)
        else if (view() === "tree") moveTreeIndex(1)
        else if (view() === "review" && hasProject()) navigate(1)
        return
      }
      if (key.name === "k" || key.name === "up") {
        if (view() === "projects") selectProjectPickerIndex(projectPickerIndex() - 1)
        else if (view() === "tree") moveTreeIndex(-1)
        else if (view() === "review" && hasProject()) navigate(-1)
        return
      }

      // Scroll the diff pane.
      if (key.name === "space" || key.name === " " || key.sequence === " " || key.raw === " " || key.name === "pagedown" || (key.ctrl && key.name === "d")) {
        try { diffScrollRef?.scrollBy({ x: 0, y: 15 }) } catch (e) { console.error("scroll err", e) }
        return
      }
      if (key.name === "b" || key.name === "pageup" || (key.ctrl && key.name === "u")) {
        try { diffScrollRef?.scrollBy({ x: 0, y: -15 }) } catch { /* ignore */ }
        return
      }
      if (key.name === "g" && !key.shift) {
        try { diffScrollRef?.scrollTo({ x: 0, y: 0 }) } catch { /* ignore */ }
        return
      }
      if (key.name === "G" || (key.name === "g" && key.shift)) {
        try { diffScrollRef?.scrollTo({ x: 0, y: Infinity }) } catch { /* ignore */ }
        return
      }

      // Hunk jumps (stretch): DiffRenderable exposes getHunkRowOffsets().
      if (key.name === "]" || key.name === "[") {
        try {
          const offsets = (diffRef && typeof diffRef.getHunkRowOffsets === "function")
            ? diffRef.getHunkRowOffsets()
            : []
          if (Array.isArray(offsets) && offsets.length > 0) {
            const cur = diffScrollRef?.scrollTop ?? 0
            let target: number | undefined
            if (key.name === "]") {
              target = offsets.find((o: number) => o > cur + 1)
            } else {
              for (let i = offsets.length - 1; i >= 0; i--) {
                if (offsets[i] < cur - 1) { target = offsets[i]; break }
              }
            }
            if (target !== undefined) diffScrollRef?.scrollTo({ x: 0, y: target })
          }
        } catch {
          // ignore
        }
        return
      }

      if (key.name === "tab") {
        const next = view() === "review" ? "tree" : view() === "tree" ? "log" : view() === "log" ? "review" : "projects"
        if (next === "projects") openProjectPicker()
        else if (next === "tree") { if (hasProject()) loadTree(); else setView("tree") }
        else setView(next)
        return
      }
      if (key.name === "return" || key.name === "enter") {
        if (view() === "tree") { openTreeSelection(); return }
        if (view() === "projects") { openSelectedProject(); return }
        setMode("prompt")
        return
      }
      if (key.name === "i") { setMode("prompt"); return }
      if (key.name === "/" || key.sequence === "/" || key.raw === "/") { setMode("prompt"); setPromptValue("/"); return }
      if (key.name === "r") {
        if (hasProject()) { load(); setStatus(`refreshed ${files()?.length ?? 0} files`) }
        return
      }
      if (key.name === "o") { openProjectPicker(); return }
      if (key.name === "?" || key.sequence === "?" || key.raw === "?") { addEntry("system", HELP_TEXT); setView("log"); return }
      if (key.name === "q") { renderer.destroy(); process.exit(0) }
      return
    }

    // Prompt mode (existing behavior).
    const list = visibleSuggestions()
    const picking = pickerOpen()
    const typingCommand = commandQuery() !== null
    const showList = picking || (typingCommand && list.length > 0)

    if (view() === "projects" && (inputRef?.value ?? "") === "" && key.name === "x" && !showList) {
      key.preventDefault()
      forgetSelectedProject()
      return
    }

    if (key.ctrl && key.name === "p") {
      key.preventDefault()
      if (pickerOpen()) setPickerOpen(false)
      else { setPickerOpen(true); setSuggestionIndex(0) }
      return
    }

    if (key.name === "escape" || key.sequence === "\x1b" || key.raw === "\x1b") {
      if (pickerOpen()) { key.preventDefault(); setPickerOpen(false); return }
      if ((inputRef?.value ?? "") !== "") { clearInput(); return }
      setMode("browse")
      return
    }

    if ((key.name === "up" || key.name === "down") && showList) {
      key.preventDefault()
      if (list.length === 0) return
      const dir = key.name === "up" ? -1 : 1
      setSuggestionIndex((i) => Math.max(0, Math.min(i + dir, list.length - 1)))
      return
    }

    if (key.name === "tab") {
      key.preventDefault()
      if (showList && list.length > 0) {
        acceptSuggestion(list[Math.min(suggestionIndex(), list.length - 1)])
        return
      }
      const next = view() === "review" ? "tree" : view() === "tree" ? "log" : view() === "log" ? "review" : "projects"
      if (next === "projects") openProjectPicker()
      else if (next === "tree") { if (hasProject()) loadTree(); else setView("tree") }
      else setView(next)
      return
    }

    if (key.name === "return" || key.name === "enter") {
      key.preventDefault()
      if (picking && list.length > 0) {
        acceptSuggestion(list[Math.min(suggestionIndex(), list.length - 1)])
        return
      }
      if (view() === "projects" && (inputRef?.value ?? "") === "") {
        openSelectedProject()
        return
      }
      if (view() === "tree" && (inputRef?.value ?? "") === "") {
        openTreeSelection()
        return
      }
      submit()
      return
    }

    if ((key.name === "up" || key.name === "down") && (inputRef?.value ?? "") === "") {
      if (view() === "projects") {
        key.preventDefault()
        selectProjectPickerIndex(projectPickerIndex() + (key.name === "up" ? -1 : 1))
        return
      }
      if (view() === "tree") {
        key.preventDefault()
        moveTreeIndex(key.name === "up" ? -1 : 1)
        return
      }
      if (view() === "review" && hasProject()) {
        key.preventDefault()
        navigate(key.name === "up" ? -1 : 1)
        return
      }
    }
  })

  // Keep the log pinned to the bottom as entries arrive.
  createEffect(() => {
    transcript()
    view()
    logRef?.scrollTo({ x: 0, y: Infinity })
  })

  const options = createMemo<SelectOption[]>(() =>
    (files() ?? []).map((f, index) => ({
      name: `${STATUS_GLYPH[f.status].padEnd(2)} ${f.path}`,
      description: `+${f.additions} -${f.deletions}`,
      value: index,
    })),
  )

  const projectPickerOptions = createMemo<SelectOption[]>(() =>
    projectPickerItems().map((item, index) => ({
      name: item.name,
      description: `${displayPath(item.path)} · ${item.kind === "recent" ? "recent" : "found here"}`,
      value: index,
    })),
  )

  const headerInfo = createMemo(() => {
    if (!hasProject()) return "no project selected"
    const project = cwdBase()
    const count = files() === null ? "loading…" : loadError() ? "error" : `${files()!.length} files`
    return `${project} · ${branch()} · ${count}`
  })

  const filetype = createMemo(() => {
    const path = file()?.path ?? ""
    return path === "" ? "" : extToFiletype(path.includes(".") ? path.slice(path.lastIndexOf(".")) : path)
  })

  const suggestionWindow = createMemo(() => {
    const list = visibleSuggestions()
    const show = pickerOpen() || (commandQuery() !== null && list.length > 0)
    if (!show) return { items: [] as CommandDef[], offset: 0, show: false }
    const max = 8
    const idx = Math.min(suggestionIndex(), Math.max(0, list.length - 1))
    let start = 0
    if (list.length > max) {
      start = Math.min(Math.max(0, idx - max + 1), list.length - max)
    }
    return { items: list.slice(start, start + max), offset: start, show: true }
  })

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={COLORS.bg}>
      <box height={1} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1}>
        <text fg={COLORS.bright}>chert</text>
        <text fg={COLORS.dim}>{` · ${headerInfo()}`}</text>
        <box flexGrow={1} />
        <text fg={COLORS.dim}>{`[ ${activeLabel()} ]`}</text>
      </box>
      <box height={1} flexShrink={0} border={["bottom"]} borderColor={COLORS.rule} />

      <Show
        when={view() === "projects"}
        fallback={
          <Show
            when={view() === "log"}
            fallback={
              <Show
                when={view() === "tree"}
                fallback={
                  <Show
                    when={hasProject()}
                    fallback={
                      <box flexGrow={1} paddingLeft={1}>
                        <text fg={COLORS.dim}> no project open, use /project</text>
                      </box>
                    }
                  >
                    <box flexGrow={1} flexDirection="row">
                      <select
                        ref={(el: SelectRenderable) => {
                          selectRef = el
                        }}
                        width="38%"
                        height="100%"
                        options={options()}
                        showDescription={true}
                        showScrollIndicator={true}
                        backgroundColor={COLORS.bg}
                        focusedBackgroundColor={COLORS.bg}
                        textColor={COLORS.text}
                        focusedTextColor={COLORS.bright}
                        selectedBackgroundColor={COLORS.selectedBg}
                        selectedTextColor={COLORS.bright}
                        descriptionColor={COLORS.dim}
                        selectedDescriptionColor={COLORS.dim}
                      />

                      <box flexGrow={1} height="100%" paddingLeft={1}>
                        <Show when={!loadError()} fallback={<text fg={COLORS.danger}>{` ${loadError()}`}</text>}>
                          <Show
                            when={file()}
                            fallback={<text fg={COLORS.dim}>{` ${files() === null ? "Loading changes…" : "No local changes"}`}</text>}
                          >
                            <scrollbox
                              ref={(el: ScrollBoxRenderable) => (diffScrollRef = el)}
                              flexGrow={1}
                              backgroundColor={COLORS.bg}
                            >
                              <diff
                                ref={(el: any) => (diffRef = el)}
                                width="100%"
                                diff={patch()}
                                view="unified"
                                filetype={filetype()}
                                showLineNumbers={true}
                              />
                            </scrollbox>
                          </Show>
                        </Show>
                      </box>
                    </box>
                  </Show>
                }
              >
                <Show
                  when={hasProject()}
                  fallback={
                    <box flexGrow={1} paddingLeft={1}>
                      <text fg={COLORS.dim}> no project open, use /project</text>
                    </box>
                  }
                >
                  <scrollbox
                    ref={(el: ScrollBoxRenderable) => (treeRef = el)}
                    flexGrow={1}
                    backgroundColor={COLORS.bg}
                    paddingLeft={1}
                  >
                    <For each={treeLines()}>
                      {(line, index) => (
                        <text fg={index() === treeIndex() ? COLORS.bright : line.isDir ? COLORS.dim : COLORS.text}>
                          {`${index() === treeIndex() ? "▸ " : "  "}${line.text}`}
                        </text>
                      )}
                    </For>
                  </scrollbox>
                </Show>
              </Show>
            }
          >
            <scrollbox
              ref={(el: ScrollBoxRenderable) => (logRef = el)}
              flexGrow={1}
              backgroundColor={COLORS.bg}
              paddingLeft={1}
            >
              <For each={transcript()}>
                {(entry) => (
                  <For each={entry.text.split("\n")}>
                    {(line) => <text fg={ENTRY_FG[entry.kind]}>{line === "" ? " " : line}</text>}
                  </For>
                )}
              </For>
            </scrollbox>
          </Show>
        }
      >
        <Show
          when={projectPickerItems().length > 0}
          fallback={
            <box flexGrow={1} paddingLeft={1}>
              <text fg={COLORS.dim}> no projects yet. type a path below (like ~/code/myapp) and press Enter</text>
            </box>
          }
        >
          <select
            ref={(el: SelectRenderable) => {
              projectPickerSelectRef = el
              el.setSelectedIndex(projectPickerIndex())
            }}
            flexGrow={1}
            options={projectPickerOptions()}
            showDescription={true}
            showScrollIndicator={true}
            backgroundColor={COLORS.bg}
            focusedBackgroundColor={COLORS.bg}
            textColor={COLORS.text}
            focusedTextColor={COLORS.bright}
            selectedBackgroundColor={COLORS.selectedBg}
            selectedTextColor={COLORS.bright}
            descriptionColor={COLORS.dim}
            selectedDescriptionColor={COLORS.dim}
          />
        </Show>
      </Show>

      <Show
        when={suggestionWindow().show}
        fallback={<box height={1} flexShrink={0} border={["top"]} borderColor={COLORS.rule} />}
      >
        <box flexShrink={0} flexDirection="column" border={["top"]} borderColor={COLORS.rule} paddingLeft={1} paddingRight={1}>
          <Show when={pickerOpen()}>
            <text fg={COLORS.dim}> commands (Ctrl+P)</text>
          </Show>
          <For each={suggestionWindow().items}>
            {(cmd, i) => {
              const idx = () => suggestionWindow().offset + i()
              const active = () => idx() === Math.min(suggestionIndex(), Math.max(0, visibleSuggestions().length - 1))
              const label = `/${cmd.name}${cmd.aliases?.length ? ` (${cmd.aliases.join(", ")})` : ""}`
              return (
                <box height={1} flexDirection="row" backgroundColor={active() ? COLORS.selectedBg : COLORS.bg}>
                  <text fg={active() ? COLORS.bright : COLORS.accent}>{`${active() ? "▸ " : "  "}${label}`.padEnd(28)}</text>
                  <text fg={active() ? COLORS.text : COLORS.dim}>{cmd.description}</text>
                </box>
              )
            }}
          </For>
        </box>
      </Show>

      <box height={1} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1}>
        <text fg={mode() === "browse" ? COLORS.dim : COLORS.bright}>{mode() === "browse" ? "· " : "> "}</text>
        <input
          ref={(el: InputRenderable) => {
            inputRef = el
            el.focus()
          }}
          flexGrow={1}
          backgroundColor={COLORS.bg}
          focusedBackgroundColor={COLORS.bg}
          textColor={COLORS.bright}
          focusedTextColor={COLORS.bright}
          placeholder={mode() === "browse" ? "press i to type, / for commands, ? for help" : "type / for commands, or ask the agent…"}
          placeholderColor={COLORS.dim}
          onInput={(value: string) => setInputValue(value)}
        />
      </box>
      <box height={1} flexShrink={0} border={["bottom"]} borderColor={COLORS.rule} />
      <box height={1} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1}>
        <text fg={COLORS.dim}>{footerHints()}</text>
        <box flexGrow={1} />
        <Show when={status() !== ""}>
          <text fg={COLORS.dim}>{status()}</text>
        </Show>
      </box>
    </box>
  )
}

export async function launch(startDir?: string): Promise<void> {
  try {
    enterProject(startDir ?? process.cwd())
  } catch {
    // ignore; picker will be shown if no project
  }
  // Initialize the tree-sitter client up front (before the render loop takes
  // over) so the diff pane can highlight. Failure is non-fatal: renderables
  // fall back to plain text.
  await getTreeSitterClient().initialize().catch(() => {})
  await render(() => <ReviewApp />, { exitOnCtrlC: true })
}
