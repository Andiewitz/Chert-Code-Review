import { createEffect, createMemo, createSignal, For, Show, onCleanup } from "solid-js"
import { render, useKeyboard, useRenderer } from "@opentui/solid"
import { extToFiletype, getTreeSitterClient } from "@opentui/core"
import type { InputRenderable, ScrollBoxRenderable, SelectOption, SelectRenderable } from "@opentui/core"
import { basename, dirname, resolve } from "node:path"
import { commitParent, commitSubject, currentBranch, listChangedFiles, loadPatch, mergeBase, resolveReviewBase, resolveSha, validateRef } from "../git"
import type { ReviewSource } from "../git"
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
  parseCdArgument,
  resolveProject,
  resolveProjectRoot,
} from "../projects"
import { QUESTIONS } from "../questions"
import { parsePatch } from "../diffrows"
import type { Row } from "../diffrows"

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const COLORS = {
  bg: "#1e1e1e",
  rule: "#3a3a3a",
  dim: "#9a9a9a",
  text: "#d6d6d6",
  bright: "#ffffff",
  selectedBg: "#2e2e2e",
  accent: "#7aa2f7",
  danger: "#cc6666",
}

const STATUS_GLYPH: Record<ReviewFile["status"], string> = {
  added: "new",
  modified: "changed",
  deleted: "deleted",
  untracked: "new",
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
  { name: "cd", usage: "/cd <name or path>", description: "switch project directory", takesArg: true },
  { name: "projects", usage: "/projects", description: "list saved projects" },
  { name: "forget", usage: "/forget <name or path>", description: "remove a saved project", takesArg: true },
  { name: "cwd", usage: "/cwd", description: "show the current project" },
  { name: "tree", usage: "/tree", description: "show the whole project tree" },
  { name: "log", usage: "/log", description: "show chat history" },
  { name: "review", usage: "/review [working|staged|branch [base]|last|commit <ref>]", description: "what to review", takesArg: true },
  { name: "connect", usage: "/connect [provider [key]]", description: "connector status / save a provider key", takesArg: true },
  { name: "disconnect", usage: "/disconnect <provider>", description: "remove a saved provider key", takesArg: true },
  { name: "use", usage: "/use <connector> [model]", description: "route plain-text prompts (opencode or a provider)", takesArg: true },
  { name: "models", usage: "/models [provider]", description: "list a provider's models", takesArg: true },
  { name: "quit", aliases: ["exit", "q"], usage: "/quit", description: "exit chert (Ctrl+C also works)" },
]

function buildHelpText(): string {
  const pad = Math.max(...COMMAND_DEFS.map((c) => c.usage.length)) + 2
  return [
    "keys:",
    "  Left/Right choose an action · Enter does it",
    "  Up/Down scroll the diff · PgUp/PgDn scroll the answer (when open)",
    "  Esc menu · Ctrl+C quit",
    "  type a question and press Enter to ask",
    "",
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
    const { realpathSync } = require("node:fs")
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

type MainView = "review" | "tree" | "log" | "done"
type PickerKind = "recent" | "found"
interface PickerItem {
  path: string
  name: string
  kind: PickerKind
}

const ACTION_ITEMS = ["Back", "Is it slow?", "Is it messy?", "Is it safe?", "Next"]

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
  const [view, setView] = createSignal<MainView>("review")
  const [previousView, setPreviousView] = createSignal<"review" | "tree" | "log">("review")
  const [hasProject, setHasProject] = createSignal(initialRoot !== undefined)
  const [reviewSource, setReviewSource] = createSignal<ReviewSource>({ kind: "working" })
  const [branch, setBranch] = createSignal("no commits")
  const [transcript, setTranscript] = createSignal<Array<{ kind: EntryKind; text: string }>>([])
  const [status, setStatus] = createSignal("")
  const [cwd, setCwd] = createSignal(process.cwd())
  const [connector, setConnector] = createSignal(getActive().connector)
  const [model, setModel] = createSignal<string | undefined>(getActive().model)
  const [inputValue, setInputValue] = createSignal("")
  const [pickerOpen, setPickerOpen] = createSignal(false)
  const [suggestionIndex, setSuggestionIndex] = createSignal(0)

  let previousProject: string | null = null

  // Phase 3 guided review state
  const [action, setAction] = createSignal(4)
  const [queue, setQueue] = createSignal<string[]>([])
  const [fileMemory, setFileMemory] = createSignal(new Map<string, "asked" | "passed">())
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [allFilesOpen, setAllFilesOpen] = createSignal(false)
  const [menuIndex, setMenuIndex] = createSignal(0)
  const [allFilesIndex, setAllFilesIndex] = createSignal(0)

  // Phase 4 answer state
  const [answerOpen, setAnswerOpen] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [scrollTarget, setScrollTarget] = createSignal<"diff" | "answer">("diff")
  const [lastQuestion, setLastQuestion] = createSignal("")
  const [lastAnswer, setLastAnswer] = createSignal("")
  const [answerFile, setAnswerFile] = createSignal("")
  const [answerIsError, setAnswerIsError] = createSignal(false)
  const [focus, setFocus] = createSignal<"files" | "code" | "prompt">("files")
  const [codeCursor, setCodeCursor] = createSignal(0)

  const activeLabel = createMemo(() => {
    const active = connector()
    if (active === "opencode") return "opencode"
    const provider = findProvider(active)
    return provider ? `${provider.id}/${model() ?? provider.defaultModel}` : active
  })

  const sourceLabel = createMemo(() => {
    const src = reviewSource()
    switch (src.kind) {
      case "working":
        return "reviewing: uncommitted changes"
      case "staged":
        return "reviewing: staged changes"
      case "branch":
        return `reviewing: everything on ${currentBranch()} since ${src.base}`
      case "commit": {
        const subj = src.subject.length > 40 ? src.subject.slice(0, 40) + "…" : src.subject
        return `reviewing: commit ${src.sha.slice(0, 7)}: ${subj}`
      }
    }
  })

  const patchCache = new Map<string, string>()
  let patchFor = ""
  let selectRef: SelectRenderable | undefined
  let projectPickerSelectRef: SelectRenderable | undefined
  let diffScrollRef: ScrollBoxRenderable | undefined
  let codeScrollRef: ScrollBoxRenderable | undefined
  let answerScrollRef: ScrollBoxRenderable | undefined
  let diffRef: any
  let inputRef: InputRenderable | undefined
  let logRef: ScrollBoxRenderable | undefined
  let treeRef: ScrollBoxRenderable | undefined
  let menuSelectRef: SelectRenderable | undefined
  let allFilesSelectRef: SelectRenderable | undefined

  const file = createMemo(() => {
    const list = files()
    if (!list || list.length === 0) return undefined
    return list[Math.min(selected(), list.length - 1)]
  })

  const isLastFile = createMemo(() => {
    const q = queue()
    const cur = file()?.path
    if (q.length === 0 || cur === undefined) return true
    return q.indexOf(cur) === q.length - 1
  })

  const isFirstFile = createMemo(() => {
    const q = queue()
    const cur = file()?.path
    if (q.length === 0 || cur === undefined) return true
    return q.indexOf(cur) <= 0
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

  // Synchronous loads
  function load(): void {
    setFiles(null)
    setLoadError(null)
    setPatch("")
    patchCache.clear()
    patchFor = ""
    setSelected(0)
    setQueue([])
    setFileMemory(new Map())
    setAction(4)
    setMenuOpen(false)
    setAllFilesOpen(false)
    setAnswerOpen(false)
    setAnswerFile("")
    setAnswerIsError(false)
    try {
      setFiles(listChangedFiles(reviewSource()))
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
    try {
      const list = files()
      if (list) setQueue(list.map((f) => f.path))
    } catch {
      setQueue([])
    }
    if (view() === "tree") {
      try {
        setTreeLines(buildTreeLines(changedGlyphs()))
        setTreeIndex(0)
      } catch {
        // leave stale
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
    if (patchFor === current.path) {
      setAction(4)
      return
    }
    const cached = patchCache.get(current.path)
    if (cached !== undefined) {
      setPatch(cached)
      patchFor = current.path
      setAction(4)
      try { diffScrollRef?.scrollTo({ x: 0, y: 0 }) } catch { /* ignore */ }
      return
    }
    try {
      const result = loadPatch(current, reviewSource())
      patchCache.set(current.path, result)
      setPatch(result)
      patchFor = current.path
    } catch (error) {
      setPatch(`Error loading diff for ${current.path}: ${error instanceof Error ? error.message : String(error)}`)
    }
    setAction(4)
    try { diffScrollRef?.scrollTo({ x: 0, y: 0 }) } catch { /* ignore */ }
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

  // Queue helpers
  function goToFile(path: string): void {
    const list = files() ?? []
    const idx = list.findIndex((f) => f.path === path)
    if (idx !== -1) selectFile(idx)
    setAction(4)
    if (answerFile() !== path) setAnswerOpen(false)
  }

  function nextFile(): void {
    const cur = file()?.path
    if (cur) {
      const mem = new Map(fileMemory())
      if (!mem.has(cur)) mem.set(cur, "passed")
      setFileMemory(mem)
    }
    const q = queue()
    const i = q.indexOf(cur ?? "")
    if (i === -1 || i === q.length - 1) {
      setView("done")
      return
    }
    goToFile(q[i + 1])
  }

  function prevFile(): void {
    const cur = file()?.path
    const q = queue()
    const i = q.indexOf(cur ?? "")
    if (i <= 0) return
    goToFile(q[i - 1])
  }

  function markAsked(path: string): void {
    const mem = new Map(fileMemory())
    mem.set(path, "asked")
    setFileMemory(mem)
  }

  // Shorten long paths from the left
  function shortenPath(p: string, max: number): string {
    if (p.length <= max) return p
    const parts = p.split("/")
    let out = parts[parts.length - 1]
    for (let i = parts.length - 2; i >= 0; i--) {
      const cand = parts[i] + "/" + out
      if (cand.length + 2 > max) {
        return "…/" + out
      }
      out = cand
    }
    return out
  }

  function stepHeader(): string {
    const q = queue()
    const cur = file()?.path ?? ""
    const i = Math.max(0, q.indexOf(cur))
    const total = q.length === 0 ? (files()?.length ?? 0) : q.length
    const pos = total === 0 ? 0 : i + 1
    const barLen = 20
    const filled = total === 0 ? 0 : Math.round((pos / total) * barLen)
    const bar = "█".repeat(filled) + "░".repeat(barLen - filled)
    const f = file()
    const statusWord = f ? STATUS_GLYPH[f.status] : ""
    // map glyph to plain word
    const plain = f ? (f.status === "added" || f.status === "untracked" ? "new" : f.status === "deleted" ? "deleted" : "changed") : ""
    const adds = f ? `+${f.additions}` : ""
    const dels = f ? `-${f.deletions}` : ""
    const path = shortenPath(cur, 40)
    return `File ${pos} of ${total}  [${bar}]  ${path}   ${plain}  ${adds} ${dels}`.trim()
  }

  if (initialRoot) {
    load()
  }

  // Menu / all-files select options
  const menuOptions = createMemo<SelectOption[]>(() => [
    { name: "Project tree", description: "browse all files", value: 0 },
    { name: "Chat history", description: "past questions and answers", value: 1 },
    { name: "Refresh changes", description: "re-scan the working tree", value: 2 },
    { name: "Review something else", description: "switch review source", value: 3 },
    { name: "Help", description: "what the keys do", value: 4 },
    { name: "Quit", description: "exit chert", value: 5 },
  ])

  const allFilesOptions = createMemo<SelectOption[]>(() => {
    const mem = fileMemory()
    return (files() ?? []).map((f, idx) => {
      const m = mem.get(f.path)
      const marker = m === "asked" ? "✓" : m === "passed" ? "-" : " "
      return {
        name: `${marker} ${f.path}`,
        description: f.status === "added" || f.status === "untracked" ? "new" : f.status === "deleted" ? "deleted" : "changed",
        value: idx,
      }
    })
  })

  function listProjects(): void {
    const recents = loadRecent()
    if (recents.length === 0) {
      addEntry("system", "No saved projects yet. Type /cd and a folder path.")
      setView("log")
      return
    }
    const lines = recents.map((r) => {
      const name = basename(r.path)
      return `${name.padEnd(20)}  ${displayPath(r.path)}`
    })
    addEntry("system", lines.join("\n"))
    setView("log")
  }

  const cdMatches = createMemo(() => {
    const v = inputValue()
    if (!v.startsWith("/cd ")) return null
    const q = v.slice(4).trim()
    const recents = loadRecent()
    let matches = recents
    if (q !== "") {
      const lower = q.toLowerCase()
      matches = recents.filter((r) => basename(r.path).toLowerCase().includes(lower))
    }
    return matches.slice(0, 4).map((r) => basename(r.path))
  })

  function submit(): void {
    const raw = (inputRef?.value ?? "").trim()
    if (raw === "") return
    clearInput()
    if (raw.startsWith("/")) {
      runCommand(raw.slice(1).trim())
      return
    }
    if (busy()) {
      setStatus("Still thinking about your last question.")
      return
    }
    const cur = file()?.path
    if (cur) markAsked(cur)
    setAction(4)
    void askAgent(raw)
  }

  async function askAgent(prompt: string): Promise<void> {
    addEntry("user", prompt)
    setLastQuestion(prompt)
    setBusy(true)
    setLastAnswer("")
    setAnswerIsError(false)
    const startedAt = Date.now()
    let statusPrefix = "Thinking… "
    setStatus("Thinking… 0s")
    let interval: ReturnType<typeof setInterval> | undefined
    interval = setInterval(() => {
      setStatus(`${statusPrefix}${Math.floor((Date.now() - startedAt) / 1000)}s`)
    }, 1000)
    const clearTimer = () => {
      if (interval !== undefined) {
        clearInterval(interval)
        interval = undefined
      }
    }
    // Request cancelling is not implemented yet (comes later).
    try {
      const active = connector()
      if (active === "opencode") {
        if (!opencodeAvailable()) {
          const msg = "No AI is connected yet. Easiest: get a free key at https://openrouter.ai/keys, then type /connect openrouter YOUR_KEY and then /use openrouter."
          // build from PROVIDERS for the first available url
          const prov = PROVIDERS[0]
          const better = `No AI is connected yet. Easiest: get a free key at ${prov.keyUrl}, then type /connect ${prov.id} YOUR_KEY and then /use ${prov.id}.`
          addEntry("error", better)
          setLastAnswer(better)
          setAnswerIsError(true)
          return
        }
        statusPrefix = "Thinking… "
        setStatus("Thinking… 0s")
        const result = await runAgent(prompt, cwd())
        addEntry("agent", result)
        setLastAnswer(result)
        return
      }
      const provider = findProvider(active)
      if (!provider) {
        const msg = `unknown connector "${active}"`
        addEntry("error", msg)
        setLastAnswer(msg)
        setAnswerIsError(true)
        return
      }
      const key = resolveKey(provider.id)
      if (key === undefined) {
        const msg = `No AI is connected yet. Easiest: get a free key at ${provider.keyUrl}, then type /connect ${provider.id} YOUR_KEY and then /use ${provider.id}.`
        addEntry("error", msg)
        setLastAnswer(msg)
        setAnswerIsError(true)
        return
      }
      const useModel = model() ?? provider.defaultModel
      statusPrefix = `${provider.id} ${useModel}: Thinking… `
      setStatus(`${statusPrefix}0s`)
      const system = `You are chert's code-review assistant. Current project directory: ${cwd()}. Locally changed files: ${(files() ?? []).map((f) => f.path).join(", ") || "none"}.`
      const result = await chatCompletion(provider, key, useModel, system, prompt)
      addEntry("agent", result)
      setLastAnswer(result)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      addEntry("error", msg)
      setLastAnswer(msg)
      setAnswerIsError(true)
    } finally {
      clearTimer()
      setBusy(false)
      const v = view()
      if (v === "review") {
        setAnswerFile(file()?.path ?? "")
        setAnswerOpen(true)
        setAction(4)
        setStatus("")
      } else if (v === "tree") {
        setStatus("answer ready, press a in review")
      } else {
        setStatus("")
      }
    }
  }

  function runCommand(line: string): void {
    if (line === "") {
      addEntry("system", HELP_TEXT)
      setView("log")
      return
    }
    const trimmed = line.trim()
    const firstSpace = trimmed.search(/\s/)
    const name = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)
    const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace).trim()
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
          addEntry("error", "No project open. Press Esc, then pick Pick another project.")
          setView("log")
          return
        }
        load()
        setStatus(`refreshed ${files()?.length ?? 0} files`)
        return
      }
      case "open": {
        if (!hasProject()) {
          addEntry("error", "No project open. Press Esc, then pick Pick another project.")
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
        // reset queue to all files? keep current queue
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
          listProjects()
          return
        }
        if (rest === "-") {
          if (previousProject === null) {
            addEntry("error", "No previous project.")
            setView("log")
            return
          }
          const target = previousProject
          const savedCwd = hasProject() ? cwd() : null
          const root = enterProject(target)
          if (root === undefined) {
            addEntry("error", `that folder isn't a git project: ${target}`)
            setView("log")
            return
          }
          if (savedCwd !== null && savedCwd !== root) previousProject = savedCwd
          setCwd(root)
          setHasProject(true)
          load()
          setView("review")
          setStatus(`opened ${basename(root) || root}`)
          addEntry("system", `project: ${root}`)
          return
        }
        const query = parseCdArgument(rest)
        const result = resolveProject(query)
        if (result.kind === "open") {
          const savedCwd = hasProject() ? cwd() : null
          if (savedCwd !== null && savedCwd !== result.root) previousProject = savedCwd
          setCwd(result.root)
          setHasProject(true)
          load()
          setView("review")
          setStatus(`opened ${result.name}`)
          addEntry("system", `project: ${result.root}`)
          return
        }
        if (result.kind === "ambiguous") {
          const lines = result.matches.map((m) => `  ${basename(m.path).padEnd(20)}  ${displayPath(m.path)}`)
          addEntry("system", `Several saved projects match "${query}":\n${lines.join("\n")}\ntype more letters or the full path`)
          setView("log")
          return
        }
        if (result.kind === "contains") {
          addEntry("system", `That folder isn't a git project, but it contains: ${result.repoNames.join(", ")}. Try /cd ${result.repoNames[0]}.`)
          setView("log")
          return
        }
        addEntry("error", `No project or folder called "${query}". Type /cd alone to see your saved projects.`)
        setView("log")
        return
      }
      case "projects": {
        listProjects()
        return
      }
      case "forget": {
        if (rest === "") {
          addEntry("error", "usage: /forget <name or path>")
          setView("log")
          return
        }
        // /forget accepts a name or a path; try the raw name first.
        const rawName = rest.trim()
        const q = parseCdArgument(rest)
        const recents = loadRecent()
        let match = recents.find((r) => basename(r.path).toLowerCase() === rawName.toLowerCase() || r.path === q || basename(r.path).toLowerCase() === q.toLowerCase())
        if (match === undefined) {
          const matches = recents.filter((r) => basename(r.path).toLowerCase().includes(q.toLowerCase()))
          if (matches.length === 1) match = matches[0]
          else if (matches.length > 1) {
            addEntry("error", `Several saved projects match "${q}". Type more letters.`)
            setView("log")
            return
          }
        }
        if (match === undefined) {
          addEntry("error", `No saved project called "${q}".`)
          setView("log")
          return
        }
        forgetProject(match.path)
        addEntry("system", "removed from your list (your files were not touched)")
        setView("log")
        return
      }
      case "review": {
        const tokens = rest.split(/\s+/).filter(Boolean)
        const sub = (tokens[0] ?? "").toLowerCase()
        if (sub === "") {
          const src = reviewSource()
          let label = ""
          switch (src.kind) {
            case "working": label = "uncommitted changes"; break
            case "staged": label = "staged changes"; break
            case "branch": label = `everything on this branch since ${src.base}`; break
            case "commit": label = `commit ${src.sha.slice(0, 7)}: ${src.subject}`; break
          }
          addEntry("system", `reviewing: ${label}\n/review working · /review staged · /review branch [name] · /review last · /review commit <ref>`)
          setView("log")
          return
        }
        if (sub === "working") {
          setReviewSource({ kind: "working" })
          load()
          setStatus("reviewing: uncommitted changes")
          return
        }
        if (sub === "staged") {
          setReviewSource({ kind: "staged" })
          load()
          setStatus("reviewing: staged changes")
          return
        }
        if (sub === "last") {
          const sha = resolveSha("HEAD")
          if (sha === null) {
            addEntry("error", "No commits yet.")
            setView("log")
            return
          }
          const parent = commitParent(sha)
          const subject = commitSubject(sha)
          setReviewSource({ kind: "commit", sha, parent, subject })
          load()
          setStatus(`reviewing: commit ${sha.slice(0, 7)}`)
          return
        }
        if (sub === "commit") {
          const ref = tokens[1] ?? ""
          if (ref === "" || !validateRef(ref)) {
            addEntry("error", `Not a valid commit: "${ref}".`)
            setView("log")
            return
          }
          const sha = resolveSha(ref)
          if (sha === null) {
            addEntry("error", `Could not resolve "${ref}".`)
            setView("log")
            return
          }
          const parent = commitParent(sha)
          const subject = commitSubject(sha)
          setReviewSource({ kind: "commit", sha, parent, subject })
          load()
          setStatus(`reviewing: commit ${sha.slice(0, 7)}`)
          return
        }
        if (sub === "branch") {
          const baseArg = tokens.slice(1).join(" ").trim()
          let base: string | null = null
          if (baseArg !== "") {
            if (!validateRef(baseArg)) {
              addEntry("error", `Not a valid branch: "${baseArg}".`)
              setView("log")
              return
            }
            base = baseArg
          } else {
            base = resolveReviewBase()
          }
          if (base === null) {
            addEntry("error", "I couldn't find the main branch. Type /review branch <name>.")
            setView("log")
            return
          }
          const current = currentBranch()
          if (current === base) {
            addEntry("system", `You're already on ${base}; staying on uncommitted changes.`)
            setView("log")
            return
          }
          // merge base
          let mb: string
          try {
            mb = mergeBase(current, base)
          } catch {
            addEntry("error", `Could not find where ${current} split from ${base}.`)
            setView("log")
            return
          }
          setReviewSource({ kind: "branch", base, mergeBase: mb })
          load()
          setStatus(`reviewing: everything on ${current} since ${base}`)
          return
        }
        addEntry("error", `Unknown review source "${sub}". Try /review with no arguments.`)
        setView("log")
        return
      }
      case "log":
        setView("log")
        return
      case "cwd":
        addEntry("system", `project: ${cwd()}`)
        setView("log")
        return
      case "tree":
        if (!hasProject()) {
          addEntry("error", "No project open. Press Esc, then pick Pick another project.")
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

  // Keyboard handling: no modes. Box empty => screen keys. Box has text => editing.
  useKeyboard((key) => {
    const hasText = (inputRef?.value ?? "") !== ""
    const showList = pickerOpen() || (commandQuery() !== null && (filteredCommands().length > 0))

    // Ctrl+P command picker
    if (key.ctrl && key.name === "p") {
      key.preventDefault()
      if (pickerOpen()) setPickerOpen(false)
      else { setPickerOpen(true); setSuggestionIndex(0) }
      return
    }

    // Esc
    if (key.name === "escape") {
      if (pickerOpen()) { key.preventDefault(); setPickerOpen(false); return }
      if (menuOpen()) { setMenuOpen(false); setAllFilesOpen(false); return }
      if (allFilesOpen()) { setAllFilesOpen(false); return }
      if (hasText) { clearInput(); return }
      if (view() === "review") { setMenuOpen(true); return }
      return
    }

    // Suggestion list navigation
    if ((key.name === "up" || key.name === "down") && showList) {
      key.preventDefault()
      const list = visibleSuggestions()
      if (list.length === 0) return
      const dir = key.name === "up" ? -1 : 1
      setSuggestionIndex((i) => Math.max(0, Math.min(i + dir, list.length - 1)))
      return
    }

    if (key.name === "tab") {
      const matches = cdMatches()
      if (matches !== null && matches.length > 0) {
        key.preventDefault()
        const first = matches[0]
        const recents = loadRecent()
        const rec = recents.find((r) => basename(r.path) === first)
        const name = rec ? basename(rec.path) : first
        const completed = name.includes(" ") ? `"${name}"` : name
        setPromptValue(`/cd ${completed} `)
        return
      }
      return
    }

    if (key.name === "return" || key.name === "enter") {
      key.preventDefault()
      if (pickerOpen() && visibleSuggestions().length > 0) {
        acceptSuggestion(visibleSuggestions()[Math.min(suggestionIndex(), visibleSuggestions().length - 1)])
        return
      }
      if (hasText) {
        submit()
        return
      }
      if (view() === "tree") { openTreeSelection(); return }
      if (menuOpen()) { handleMenuSelection(menuIndex()); return }
      if (allFilesOpen()) {
        const af = (files() ?? [])[allFilesIndex()]
        if (af) { setAllFilesOpen(false); setMenuOpen(false); selectFile(files()!.indexOf(af)); setFocus("files") }
        return
      }
      if (view() === "review") {
        if (focus() === "files") {
          setFocus("code")
          return
        }
        // code focus: Enter on a highlight? handled by Enter on highlighted line? 
        // For now, Enter does nothing special in code focus.
        return
      }
      return
    }

    // Empty box: screen keys
    if (!hasText) {
      if (view() === "review") {
        if (key.name === "left" || key.name === "right") {
          key.preventDefault()
          setFocus((f) => (f === "files" ? "code" : f === "code" ? "files" : f))
          return
        }
        if (focus() === "files") {
          if (key.name === "up" || key.name === "down") {
            key.preventDefault()
            navigate(key.name === "up" ? -1 : 1)
            return
          }
        } else if (focus() === "code") {
          if (key.name === "up" || key.name === "down") {
            key.preventDefault()
            const rows = codeRows()
            if (rows.length === 0) return
            const dir = key.name === "up" ? -1 : 1
            setCodeCursor((c) => Math.max(0, Math.min(c + dir, rows.length - 1)))
            // auto-scroll
            try { codeScrollRef?.scrollTo({ x: 0, y: Math.max(0, codeCursor() - 5) }) } catch { /* ignore */ }
            return
          }
          if (key.name === "pageup" || key.name === "pagedown") {
            key.preventDefault()
            const delta = key.name === "pageup" ? -10 : 10
            const rows = codeRows()
            setCodeCursor((c) => Math.max(0, Math.min(c + delta, rows.length - 1)))
            try { codeScrollRef?.scrollTo({ x: 0, y: Math.max(0, codeCursor() - 5) }) } catch { /* ignore */ }
            return
          }
        }
        return
      }
      if (view() === "tree") {
        if (key.name === "up" || key.name === "down") {
          key.preventDefault()
          moveTreeIndex(key.name === "up" ? -1 : 1)
          return
        }
        return
      }
      if (menuOpen()) {
        if (key.name === "up" || key.name === "down") {
          key.preventDefault()
          const dir = key.name === "up" ? -1 : 1
          setMenuIndex((i) => {
            const next = Math.max(0, Math.min(i + dir, menuOptions().length - 1))
            menuSelectRef?.setSelectedIndex(next)
            return next
          })
          return
        }
        return
      }
      if (allFilesOpen()) {
        if (key.name === "up" || key.name === "down") {
          key.preventDefault()
          const dir = key.name === "up" ? -1 : 1
          setAllFilesIndex((i) => {
            const next = Math.max(0, Math.min(i + dir, (files()?.length ?? 1) - 1))
            allFilesSelectRef?.setSelectedIndex(next)
            return next
          })
          return
        }
        return
      }
    }
  })


  function handleMenuSelection(i: number): void {
    switch (i) {
      case 0: // Project tree
        setMenuOpen(false)
        if (hasProject()) loadTree()
        else setView("tree")
        return
      case 1: // Chat history
        setMenuOpen(false)
        setView("log")
        return
      case 2: // Refresh changes
        setMenuOpen(false)
        if (hasProject()) { load(); setStatus(`refreshed ${files()?.length ?? 0} files`) }
        return
      case 3: // Review something else
        setMenuOpen(false)
        addEntry("system", "Type /review working · /review staged · /review branch [name] · /review last · /review commit <ref>")
        setView("log")
        return
      case 4: // Help
        addEntry("system", HELP_TEXT)
        setView("log")
        setMenuOpen(false)
        return
      case 5: // Quit
        renderer.destroy()
        process.exit(0)
        return
    }
  }

  function handleDoneSelection(i: number): void {
    const skipped = (files() ?? []).filter((f) => fileMemory().get(f.path) === "passed").map((f) => f.path)
    // options: 0 go back over skipped, 1 refresh, 2 pick another, 3 quit
    if (i === 0) {
      if (skipped.length === 0) return
      setQueue(skipped)
      setView("review")
      if (skipped.length > 0) goToFile(skipped[0])
      return
    }
    if (i === 1) {
      load()
      setView("review")
      return
    }
    if (i === 2) {
      listProjects()
      return
    }
    if (i === 3) {
      renderer.destroy()
      process.exit(0)
      return
    }
  }

  function doneOptions(): SelectOption[] {
    const skippedCount = (files() ?? []).filter((f) => fileMemory().get(f.path) === "passed").length
    const askedCount = (files() ?? []).filter((f) => fileMemory().get(f.path) === "asked").length
    const total = files()?.length ?? 0
    const opts: SelectOption[] = []
    if (skippedCount > 0) opts.push({ name: `Go back over the ${skippedCount} skipped files`, description: "", value: 0 })
    opts.push({ name: "Refresh (check for new changes)", description: "", value: 1 })
    opts.push({ name: "Pick another project", description: "", value: 2 })
    opts.push({ name: "Quit", description: "", value: 3 })
    return opts
  }

  function activateAction(i: number): void {
    const cur = file()?.path
    if (cur === undefined) return
    if (i === 0) {
      // Back
      if (!isFirstFile()) prevFile()
      return
    }
    if (i === 1) {
      if (busy()) { setStatus("Still thinking about your last question."); return }
      markAsked(cur)
      setAction(4)
      void askAgent(QUESTIONS.slow(cur))
      return
    }
    if (i === 2) {
      if (busy()) { setStatus("Still thinking about your last question."); return }
      markAsked(cur)
      setAction(4)
      void askAgent(QUESTIONS.messy(cur))
      return
    }
    if (i === 3) {
      if (busy()) { setStatus("Still thinking about your last question."); return }
      markAsked(cur)
      setAction(4)
      void askAgent(QUESTIONS.safe(cur))
      return
    }
    if (i === 4) {
      nextFile()
      return
    }
  }

  function footerHints(): string {
    const hasText = (inputRef?.value ?? "") !== ""
    if (hasText) return "Enter send · Esc clear · Ctrl+C quit"
    if (view() === "tree") return "Up/Down move · Enter open · Esc menu · Ctrl+C quit"
    if (view() === "log") return "Esc menu · Ctrl+C quit"
    if (view() === "done") return "Up/Down choose · Enter go · Ctrl+C quit"
    if (menuOpen()) return "Up/Down choose · Enter go · Esc close · Ctrl+C quit"
    if (allFilesOpen()) return "Up/Down choose · Enter jump · Esc close · Ctrl+C quit"
    // review (two-pane)
    if (answerOpen() && answerFile() === (file()?.path ?? "")) return "Left/Right switch pane · Up/Down move · Enter open · PgUp/PgDn read the answer · Esc menu · Ctrl+C quit"
    return "Left/Right switch pane · Up/Down move · Enter open · Esc menu · Ctrl+C quit"
  }

  // Keep the log pinned to the bottom as entries arrive.
  createEffect(() => {
    transcript()
    view()
    logRef?.scrollTo({ x: 0, y: Infinity })
  })

  // Reset diff scroll to top whenever the displayed patch changes.
  createEffect(() => {
    patch()
    setTimeout(() => {
      try { diffScrollRef?.scrollTo({ x: 0, y: 0 }) } catch { /* ignore */ }
    }, 50)
  })

  // Reset diff scroll to top whenever the displayed patch changes.
  createEffect(() => {
    patch()
    try { diffScrollRef?.scrollTo({ x: 0, y: 0 }) } catch { /* ignore */ }
  })

  const options = createMemo<SelectOption[]>(() =>
    (files() ?? []).map((f, index) => ({
      name: `${STATUS_GLYPH[f.status]} ${shortenPath(f.path, 22)}`,
      description: `+${f.additions} -${f.deletions}`,
      value: index,
    })),
  )

  const headerInfo = createMemo(() => {
    if (!hasProject()) return "no project selected"
    const project = cwdBase()
    const count = files() === null ? "loading…" : loadError() ? "error" : `${files()!.length} files`
    return `${project} · ${branch()} · ${sourceLabel()}`
  })

  const filetype = createMemo(() => {
    const path = file()?.path ?? ""
    return path === "" ? "" : extToFiletype(path.includes(".") ? path.slice(path.lastIndexOf(".")) : path)
  })

  const codeRows = createMemo<Row[]>(() => parsePatch(patch()))

  const codeCursorRow = createMemo(() => {
    const rows = codeRows()
    if (rows.length === 0) return 0
    return Math.max(0, Math.min(codeCursor(), rows.length - 1))
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

      <Show when={view() === "done"} fallback={
        <Show when={view() === "log"} fallback={
          <Show when={view() === "tree"} fallback={
            <Show when={!menuOpen() && !allFilesOpen()}>
              <Show when={hasProject()} fallback={
                <box flexGrow={1} flexDirection="column" paddingLeft={1}>
                  <text fg={COLORS.dim}>No project open. Type /cd and a project name or folder, for example /cd myapp</text>
                  <box height={1} />
                  <For each={loadRecent().slice(0, 8)}>
                    {(r) => <text fg={COLORS.dim}>{`  ${basename(r.path).padEnd(20)}  ${displayPath(r.path)}`}</text>}
                  </For>
                </box>
              }>
                <box flexGrow={1} flexDirection="row">
                  <box width="30%" flexDirection="column" border={["right"]} borderColor={COLORS.rule}>
                    <box height={1} flexShrink={0} paddingLeft={1}>
                      <text fg={focus() === "files" ? COLORS.bright : COLORS.dim}>{`${focus() === "files" ? "\u25B8 " : "  "}Files (${files()?.length ?? 0})`}</text>
                    </box>
                    <select
                      ref={(el: SelectRenderable) => { selectRef = el }}
                      flexGrow={1}
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
                  </box>
                  <box flexGrow={1} flexDirection="column" paddingLeft={1}>
                    <box height={1} flexShrink={0}>
                      <text fg={focus() === "code" ? COLORS.bright : COLORS.dim}>{`${file()?.path ?? ""}   ${file() ? (file()!.status === "added" || file()!.status === "untracked" ? "new" : file()!.status === "deleted" ? "deleted" : "changed") : ""}  ${file() ? `+${file()!.additions} -${file()!.deletions}` : ""}`}</text>
                    </box>
                    <box height={1} flexShrink={0} border={["bottom"]} borderColor={COLORS.rule} />
                    <scrollbox
                      ref={(el: ScrollBoxRenderable) => { codeScrollRef = el }}
                      flexGrow={1}
                      backgroundColor={COLORS.bg}
                    >
                      <For each={codeRows()}>
                        {(row, i) => {
                          const isCursor = () => i() === codeCursorRow()
                          const gutter = row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "
                          const num = row.kind === "del" ? (row.oldNo ?? "") : (row.newNo ?? "")
                          return (
                            <box flexDirection="row" backgroundColor={isCursor() ? COLORS.selectedBg : COLORS.bg}>
                              <text fg={COLORS.dim}>{isCursor() ? ">" : " "}</text>
                              <text fg={COLORS.dim}>{String(num).padStart(4)} </text>
                              <text fg={row.kind === "add" ? COLORS.accent : row.kind === "del" ? COLORS.danger : COLORS.text}>{`${gutter} ${row.text}`}</text>
                            </box>
                          )
                        }}
                      </For>
                    </scrollbox>
                    <Show when={answerOpen() && answerFile() === (file()?.path ?? "")}>
                      <box height="35%" border={["top"]} borderColor={COLORS.rule} flexDirection="column" paddingLeft={1}>
                        <text fg={COLORS.dim}>{`You asked: ${lastQuestion().length > 50 ? lastQuestion().slice(0, 50) + "\u2026" : lastQuestion()}  \u00b7  ${activeLabel()}`}</text>
                        <scrollbox
                          ref={(el: ScrollBoxRenderable) => (answerScrollRef = el)}
                          flexGrow={1}
                          backgroundColor={COLORS.bg}
                        >
                          <text wrapMode="word" fg={busy() ? COLORS.dim : (answerIsError() ? COLORS.danger : COLORS.text)}>{busy() ? status() : lastAnswer()}</text>
                        </scrollbox>
                      </box>
                    </Show>
                  </box>
                </box>
              </Show>
            </Show>
          }>{/* Tree view */}
            <Show when={hasProject()} fallback={
              <box flexGrow={1} paddingLeft={1}>
                <text fg={COLORS.dim}>No project open. Type /cd and a project name or folder, for example /cd myapp</text>
              </box>
            }>
              <scrollbox ref={(el: ScrollBoxRenderable) => (treeRef = el)} flexGrow={1} backgroundColor={COLORS.bg} paddingLeft={1}>
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
        }>{/* Log view */}
          <scrollbox ref={(el: ScrollBoxRenderable) => (logRef = el)} flexGrow={1} backgroundColor={COLORS.bg} paddingLeft={1}>
            <For each={transcript()}>
              {(entry) => (
                <For each={entry.text.split("\n")}>
                  {(line) => <text fg={ENTRY_FG[entry.kind]}>{line === "" ? " " : line}</text>}
                </For>
              )}
            </For>
          </scrollbox>
        </Show>
      }>{/* Done view */}
        <box flexGrow={1} flexDirection="column" paddingLeft={1}>
          <text fg={COLORS.bright}>All done.</text>
          <text fg={COLORS.dim}>{` You looked at ${files()?.length ?? 0} files:  asked about ${(files() ?? []).filter((f) => fileMemory().get(f.path) === "asked").length},  skipped ${(files() ?? []).filter((f) => fileMemory().get(f.path) === "passed").length} without asking.`}</text>
          <Show when={(files() ?? []).filter((f) => fileMemory().get(f.path) === "passed").length === 0}>
            <text fg={COLORS.dim}>You asked about every file.</text>
          </Show>
          <box height={1} />
          <select
            ref={(el: SelectRenderable) => (menuSelectRef = el)}
            flexGrow={1}
            options={doneOptions()}
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
        </box>
      </Show>

      {/* Menu overlay */}

      <Show when={menuOpen()}>
        <box flexGrow={1} flexDirection="column" paddingLeft={1}>
          <text fg={COLORS.bright}>Menu</text>
          <box height={1} />
          <select
            ref={(el: SelectRenderable) => (menuSelectRef = el)}
            flexGrow={1}
            options={menuOptions()}
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
        </box>
      </Show>

      {/* All files overlay */}
      <Show when={allFilesOpen()}>
        <box flexGrow={1} flexDirection="column" paddingLeft={1}>
          <text fg={COLORS.bright}>All files</text>
          <box height={1} />
          <select
            ref={(el: SelectRenderable) => (allFilesSelectRef = el)}
            flexGrow={1}
            options={allFilesOptions()}
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
        </box>
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

      <Show when={cdMatches() !== null}>
        <box height={1} flexShrink={0} paddingLeft={1}>
          <text fg={COLORS.dim}>
            {cdMatches()!.length === 0
              ? "no saved project matches, press Enter to try it as a folder"
              : `matches: ${cdMatches()!.join(" · ")}`}
          </text>
        </box>
      </Show>
      <box height={1} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1}>
        <text fg={COLORS.bright}>{"> "}</text>
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
          placeholder="or type your own question here, then press Enter"
          placeholderColor={COLORS.dim}
          onInput={(value: string) => setInputValue(value)}
        />
      </box>
      <box height={1} flexShrink={0} border={["bottom"]} borderColor={COLORS.rule} />
      <box height={1} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1}>
        <Show when={busy()} fallback={
          <>
            <text fg={COLORS.dim}>{footerHints()}</text>
            <box flexGrow={1} />
            <Show when={status() !== ""}>
              <text fg={COLORS.dim}>{status()}</text>
            </Show>
          </>
        }>
          <text fg={COLORS.dim}>{`${status()} · Ctrl+C quit`}</text>
        </Show>
      </box>
    </box>
  )
}

export async function launch(startDir?: string): Promise<void> {
  try {
    enterProject(startDir ?? process.cwd())
  } catch {
    // ignore
  }
  await getTreeSitterClient().initialize().catch(() => {})
  await render(() => <ReviewApp />, { exitOnCtrlC: true })
}
