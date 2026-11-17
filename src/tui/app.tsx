import { createEffect, createMemo, createSignal, For, Show, onCleanup } from "solid-js"
import { render, useKeyboard, useRenderer } from "@opentui/solid"
import { TextAttributes, extToFiletype, getTreeSitterClient } from "@opentui/core"
import type { InputRenderable, ScrollBoxRenderable, SelectOption } from "@opentui/core"
import { basename, dirname, join, resolve } from "node:path"
import { commitParent, commitSubject, currentBranch, gitDir, listChangedFiles, listRecentCommits, loadPatch, mergeBase, resolveReviewBase, resolveSha, validateRef } from "../git"
import type { ReviewSource } from "../git"
import type { ReviewFile } from "../git"
import { buildTreeLines } from "../tree"
import type { TreeLine } from "../tree"
import { opencodeAvailable, runAgent, tailLines } from "../agent"
import {
  PROVIDERS,
  chatCompletion,
  clearProviderKey,
  configDir,
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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { loadHighlights, parseAgentHighlights, saveHighlights, resolveHighlights } from "../highlights"
import type { Highlight, HighlightLevel } from "../highlights"

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

export type ThemeName = "default" | "dark-contrast" | "whiteout" | "github"

export const THEME_LABELS: Record<ThemeName, string> = {
  "default": "Default",
  "dark-contrast": "Dark Contrast",
  "whiteout": "Whiteout",
  "github": "GitHub",
}

export const THEME_DESCRIPTIONS: Record<ThemeName, string> = {
  "default": "The default chert theme.",
  "dark-contrast": "Pure black background with maximum-contrast colors.",
  "whiteout": "White background; blue instead of green, purple instead of red.",
  "github": "GitHub's color palette.",
}

export interface ThemePalette {
  bg: string
  rule: string
  dim: string
  text: string
  bright: string
  selectedBg: string
  accent: string
  purple: string
  purpleBright: string
  purpleDim: string
  danger: string
  add: string
}

export const THEMES: Record<ThemeName, ThemePalette> = {
  "default": {
    bg: "#0f0d13", rule: "#2a2433", dim: "#7d7488", text: "#cfc8d8", bright: "#f6f2fb",
    selectedBg: "#241d33", accent: "#a78bfa", purple: "#a78bfa", purpleBright: "#d6c6ff",
    purpleDim: "#6d5bb0", danger: "#e5788a", add: "#7ec699",
  },
  "dark-contrast": {
    bg: "#000000", rule: "#555555", dim: "#aaaaaa", text: "#ffffff", bright: "#ffffff",
    selectedBg: "#222222", accent: "#ff79c6", purple: "#bd93f9", purpleBright: "#ffffff",
    purpleDim: "#6272a4", danger: "#ff5555", add: "#50fa7b",
  },
  "whiteout": {
    bg: "#ffffff", rule: "#d0d7de", dim: "#57606a", text: "#000000", bright: "#000000",
    selectedBg: "#eaeef2", accent: "#0969da", purple: "#8250df", purpleBright: "#6639ba",
    purpleDim: "#d8b9ff", danger: "#8250df", add: "#0969da",
  },
  "github": {
    bg: "#0d1117", rule: "#30363d", dim: "#8b949e", text: "#c9d1d9", bright: "#f0f6fc",
    selectedBg: "#161b22", accent: "#58a6ff", purple: "#a371f7", purpleBright: "#bc8cff",
    purpleDim: "#6e40c9", danger: "#f85149", add: "#3fb950",
  },
}

function loadThemeName(): ThemeName {
  try {
    const raw = readFileSync(join(configDir(), "theme.json"), "utf8")
    const parsed = JSON.parse(raw) as { theme?: string }
    if (parsed && typeof parsed.theme === "string" && parsed.theme in THEMES) return parsed.theme as ThemeName
  } catch { /* ignore */ }
  return "default"
}

function saveThemeName(name: ThemeName): void {
  try {
    mkdirSync(configDir(), { recursive: true })
    writeFileSync(join(configDir(), "theme.json"), JSON.stringify({ theme: name }) + "\n")
  } catch { /* ignore */ }
}

const [themeName, setThemeNameSignal] = createSignal<ThemeName>(loadThemeName())
export function currentTheme(): ThemeName { return themeName() }
export function setTheme(name: ThemeName): void {
  setThemeNameSignal(name)
  saveThemeName(name)
}
export function colors(): ThemePalette { return THEMES[themeName()] }
export const COLORS = colors

// Terminal cells have no font size, so hierarchy comes from weight and tone:
// bold + bright for what the eye should land on, dim for everything else.
const ATTR = {
  none: 0,
  bold: TextAttributes.BOLD,
  dim: TextAttributes.DIM,
}

const WORDMARK = [
  " ██████╗██╗  ██╗███████╗██████╗ ████████╗",
  "██╔════╝██║  ██║██╔════╝██╔══██╗╚══██╔══╝",
  "██║     ███████║█████╗  ██████╔╝   ██║   ",
  "██║     ██╔══██║██╔══╝  ██╔══██╗   ██║   ",
  "╚██████╗██║  ██║███████╗██║  ██║   ██║   ",
  " ╚═════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝   ╚═╝   ",
]

const WORDMARK_FG = ["#e2d6ff", "#d3c0ff", "#c4aeff", "#b39bfb", "#9f86f4", "#8367d8"]

/** Shorten a path from the left, keeping the last segments that fit. */
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

interface PickerRow {
  label: string
  hint?: string
}

interface Suggestion {
  key: string
  label: string
  description: string
  insert: string
}

/** A keyboard-driven list: arrows move the cursor, Enter acts on it. */
function RowList(props: { rows: () => PickerRow[]; index: () => number }) {
  return (
    <For each={props.rows()}>
      {(row, i) => {
        const active = () => i() === props.index()
        return (
          <box flexDirection="row" height={1} flexShrink={0} backgroundColor={active() ? COLORS().selectedBg : COLORS().bg}>
            <text fg={active() ? COLORS().purpleBright : COLORS().rule}>{active() ? "  ▸ " : "    "}</text>
            <text fg={active() ? COLORS().bright : COLORS().text} attributes={active() ? ATTR.bold : ATTR.none}>
              {row.label}
            </text>
            <box flexGrow={1} />
            <Show when={row.hint !== undefined}>
              <text fg={active() ? COLORS().dim : COLORS().rule} attributes={ATTR.dim}>
                {row.hint ?? ""}
              </text>
            </Show>
          </box>
        )
      }}
    </For>
  )
}

/** Launch/home screen: the chert wordmark above a recent-project picker. */
function HomeScreen(props: { recents: () => Array<{ path: string }>; index: () => number; noProject: boolean }) {
  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingRight={2}>
      <box height={1} flexShrink={0} />
      <For each={WORDMARK}>
        {(line, i) => (
          <text fg={WORDMARK_FG[i()] ?? COLORS().purple} attributes={ATTR.bold}>
            {line}
          </text>
        )}
      </For>
      <box height={1} flexShrink={0} />
      <text fg={COLORS().dim}>{"review your changes, one file at a time"}</text>
      <box height={1} flexShrink={0} />
      <Show when={props.noProject}>
        <text fg={COLORS().dim} attributes={ATTR.dim}>{"No project open · choose a recent project, or type /cd <path>"}</text>
        <box height={1} flexShrink={0} />
      </Show>
      <text fg={COLORS().purple} attributes={ATTR.bold}>{"Recent projects"}</text>
      <box height={1} flexShrink={0} />
      <Show
        when={props.recents().length > 0}
        fallback={<text fg={COLORS().dim} attributes={ATTR.dim}>{"Nothing here yet — type /cd <path> to open a project."}</text>}
      >
        <RowList
          rows={() =>
            props.recents().map((r) => ({ label: basename(r.path), hint: shortenPath(displayPath(r.path), 38) }))
          }
          index={props.index}
        />
      </Show>
      <box flexGrow={1} />
    </box>
  )
}

const STATUS_GLYPH: Record<ReviewFile["status"], string> = {
  added: "new",
  modified: "changed",
  deleted: "deleted",
  untracked: "new",
}

type EntryKind = "user" | "agent" | "system" | "error"

function entryFg(kind: EntryKind): string {
  const c = COLORS()
  switch (kind) {
    case "user": return c.accent
    case "agent": return c.text
    case "system": return c.dim
    case "error": return c.danger
  }
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
  { name: "highlights", usage: "/highlights [clear [yes]]", description: "list or clear highlights", takesArg: true },
  { name: "export", usage: "/export", description: "export review notes to markdown" },
  { name: "review", usage: "/review [working|staged|branch [base]|last|commit <ref>]", description: "what to review", takesArg: true },
  { name: "connect", usage: "/connect [provider [key]]", description: "connector status / save a provider key", takesArg: true },
  { name: "disconnect", usage: "/disconnect <provider>", description: "remove a saved provider key", takesArg: true },
  { name: "use", usage: "/use <connector> [model]", description: "route plain-text prompts (opencode or a provider)", takesArg: true },
  { name: "models", usage: "/models [provider]", description: "list a provider's models", takesArg: true },
  { name: "themes", usage: "/themes [name]", description: "list or switch color theme", takesArg: true },
  { name: "quit", aliases: ["exit", "q"], usage: "/quit", description: "exit chert (Ctrl+C also works)" },
]

function buildHelpText(): string {
  const pad = Math.max(...COMMAND_DEFS.map((c) => c.usage.length)) + 2
  return [
    "keys:",
    "  Up/Down     previous / next file",
    "  Left/Right  pick an action: Back · slow · messy · safe · Next",
    "  Enter       run the picked action",
    "  Space       mark the file reviewed",
    "  h           highlight lines (↑↓ move, Enter select, Esc done)",
    "  PgUp/PgDn   scroll the diff, or the answer when it is open",
    "  Esc         menu · Ctrl+C quit",
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
  const [reviewPickerOpen, setReviewPickerOpen] = createSignal(false)
  const [reviewPickerIndex, setReviewPickerIndex] = createSignal(0)
  const [projectsOpen, setProjectsOpen] = createSignal(false)
  const [projectsIndex, setProjectsIndex] = createSignal(0)
  const [doneIndex, setDoneIndex] = createSignal(0)

  // Phase 4 answer state
  const [answerOpen, setAnswerOpen] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [scrollTarget, setScrollTarget] = createSignal<"diff" | "answer">("diff")
  const [lastQuestion, setLastQuestion] = createSignal("")
  const [lastAnswer, setLastAnswer] = createSignal("")
  const [answerFile, setAnswerFile] = createSignal("")
  const [answerIsError, setAnswerIsError] = createSignal(false)
  const [focus, setFocus] = createSignal<"files" | "code">("files")
  const [codeCursor, setCodeCursor] = createSignal(0)
  const [reviewed, setReviewed] = createSignal(new Set<string>())
  const [highlights, setHighlights] = createSignal<Highlight[]>([])
  const [resolvedHighlights, setResolvedHighlights] = createSignal(new Map<string, { startRow: number; endRow: number; moved: boolean } | null>())
  const [rangeStart, setRangeStart] = createSignal<number | null>(null)
  const [highlightMenuOpen, setHighlightMenuOpen] = createSignal(false)
  const [highlightMenuIndex, setHighlightMenuIndex] = createSignal(0)
  const [highlightNoteMode, setHighlightNoteMode] = createSignal(false)
  const [highlightNoteText, setHighlightNoteText] = createSignal("")
  const [pendingHighlight, setPendingHighlight] = createSignal<Highlight | null>(null)
  const [highlightsClearPending, setHighlightsClearPending] = createSignal(false)

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
  let diffScrollRef: ScrollBoxRenderable | undefined
  let codeScrollRef: ScrollBoxRenderable | undefined
  let answerScrollRef: ScrollBoxRenderable | undefined
  let diffRef: any
  let inputRef: InputRenderable | undefined
  let logRef: ScrollBoxRenderable | undefined
  let treeRef: ScrollBoxRenderable | undefined
  let fileScrollRef: ScrollBoxRenderable | undefined
  let allFilesScrollRef: ScrollBoxRenderable | undefined
  let reviewPickerScrollRef: ScrollBoxRenderable | undefined

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

  // Panels that replace the review: menu, all-files list, recent projects.
  const mainVisible = createMemo(() => !menuOpen() && !allFilesOpen() && !projectsOpen() && !reviewPickerOpen())

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

  function commandToSuggestion(def: CommandDef): Suggestion {
    const label = `/${def.name}${def.aliases?.length ? ` (${def.aliases.join(", ")})` : ""}`
    return { key: def.name, label, description: def.description, insert: `/${def.name}${def.takesArg ? " " : ""}` }
  }

  const reviewInput = createMemo(() => {
    const v = inputValue().trimStart()
    const lower = v.toLowerCase()
    if (!lower.startsWith("/review")) return null
    return v.slice("/review".length).trimStart()
  })

  const allReviewTargets = createMemo(() => {
    const items: Suggestion[] = []
    const targets: { key: string; description: string; insert: string }[] = [
      { key: "working", description: "uncommitted changes", insert: "/review working" },
      { key: "staged", description: "staged changes", insert: "/review staged" },
      { key: "last", description: "the last commit", insert: "/review last" },
      { key: "branch", description: "everything on this branch since base", insert: "/review branch " },
    ]
    for (const t of targets) {
      items.push({ key: t.key, label: `/review ${t.key}`, description: t.description, insert: t.insert })
    }
    if (hasProject()) {
      for (const c of listRecentCommits()) {
        const short = c.sha.slice(0, 7)
        items.push({ key: c.sha, label: short, description: c.subject, insert: `/review commit ${c.sha}` })
      }
    }
    return items
  })

  const reviewSuggestions = createMemo(() => {
    const q = reviewInput()
    if (q === null) return [] as Suggestion[]
    const needle = q.toLowerCase()
    const matches = (text: string) => needle === "" || text.toLowerCase().includes(needle)
    return allReviewTargets().filter((s) => matches(s.label) || matches(s.description) || matches(s.key))
  })

  const themeInput = createMemo(() => {
    const v = inputValue().trimStart()
    const lower = v.toLowerCase()
    if (!lower.startsWith("/themes")) return null
    const rest = v.slice("/themes".length)
    // Only show the theme list once the user has moved past the command name
    // (a trailing space or partial theme name), not while typing "/themes".
    if (rest === "" || !/^\s/.test(rest)) return null
    return rest.trimStart()
  })

  const allThemeTargets = createMemo(() => {
    return (Object.keys(THEMES) as ThemeName[]).map((t) => ({
      key: t,
      label: THEME_LABELS[t],
      description: THEME_DESCRIPTIONS[t],
      insert: `/themes ${t}`,
    }))
  })

  const themeSuggestions = createMemo(() => {
    const q = themeInput()
    if (q === null) return [] as Suggestion[]
    const needle = q.toLowerCase()
    const matches = (text: string) => needle === "" || text.toLowerCase().includes(needle)
    return allThemeTargets().filter((s) => matches(s.label) || matches(s.description) || matches(s.key))
  })

  const filteredCommands = createMemo(() => {
    const q = commandQuery()
    if (q === null) return [] as Suggestion[]
    return COMMAND_DEFS.map((def) => ({ def, score: scoreCommand(def, q) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.def.name.localeCompare(b.def.name))
      .map((x) => commandToSuggestion(x.def))
  })

  const visibleSuggestions = createMemo(() => {
    if (pickerOpen()) return COMMAND_DEFS.map(commandToSuggestion)
    if (themeInput() !== null) return themeSuggestions()
    return filteredCommands()
  })

  createEffect(() => {
    pickerOpen()
    commandQuery()
    setSuggestionIndex(0)
  })

  function acceptSuggestion(s: Suggestion | undefined): void {
    if (!s) return
    setPromptValue(s.insert)
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
    // before overwriting, compute reviewed files that changed
    let unChecked = 0
    try {
      const oldSet = reviewed()
      const newFiles = listChangedFiles(reviewSource())
      for (const k of oldSet) {
        const [path, oldHash] = k.split("\u0000")
        const f = newFiles.find((x) => x.path === path)
        if (f) {
          // compute new hash from patch (load patch)
          try {
            const p = loadPatch(f, reviewSource())
            const newHash = String(Bun.hash(p))
            if (newHash !== oldHash) unChecked++
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    setQueue([])
    setFileMemory(new Map())
    setAction(4)
    setMenuOpen(false)
    if (unChecked > 0) setStatus(`${unChecked} reviewed files changed and were un-checked`)
    setAllFilesOpen(false)
    setAnswerOpen(false)
    setAnswerFile("")
    setAnswerIsError(false)
    try {
      setHighlights(loadHighlights())
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
    try { fileScrollRef?.scrollTo({ x: 0, y: Math.max(0, i - 6) }) } catch { /* ignore */ }
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

  function stepHeader(): string {
    const q = queue()
    const cur = file()?.path ?? ""
    const i = Math.max(0, q.indexOf(cur))
    const total = q.length === 0 ? (files()?.length ?? 0) : q.length
    const pos = total === 0 ? 0 : i + 1
    return `${pos} of ${total} files · ${reviewedCount()} reviewed`
  }

  if (initialRoot) {
    load()
  }

  // Menu / all-files select options
  const menuOptions = createMemo<SelectOption[]>(() => [
    { name: "Browse files", description: "every file in the project", value: 0 },
    { name: "Chat history", description: "past questions and answers", value: 1 },
    { name: "Recent projects", description: "switch to another project", value: 2 },
    { name: "Refresh changes", description: "re-scan the working tree", value: 3 },
    { name: "Change review source", description: "staged, branch, or a commit", value: 4 },
    { name: "Review summary", description: "reviewed, asked, highlighted", value: 5 },
    { name: "Next unreviewed file", description: "jump to the next one", value: 6 },
    { name: "Help", description: "keys and commands", value: 7 },
    { name: "Quit", description: "exit chert", value: 8 },
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
    if (highlightNoteMode()) {
      const hl = pendingHighlight()
      if (hl) {
        const finalHl = { ...hl, note: (inputRef?.value ?? "").trim() }
        const next = [...highlights(), finalHl]
        setHighlights(next)
        try { saveHighlights(next) } catch { /* ignore */ }
        setStatus(`highlighted lines ${hl.start}-${hl.end}`)
      }
      setHighlightNoteMode(false)
      setPendingHighlight(null)
      clearInput()
      return
    }
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
        const parsed = parseAgentHighlights(result, (files() ?? []).map((f) => f.path), new Map((files() ?? []).map((f) => [f.path, codeRows()] as [string, any])), highlights())
        if (parsed.highlights.length > 0) {
          const next = [...highlights(), ...parsed.highlights]
          setHighlights(next)
          try { saveHighlights(next) } catch { /* ignore */ }
          const skipMsg = parsed.skipped.length > 0 ? ` (${parsed.skipped.length} skipped: ${parsed.skipped[0]})` : ""
          setStatus(`AI added ${parsed.highlights.length} highlights${skipMsg}`)
        }
        addEntry("agent", parsed.cleanText)
        setLastAnswer(parsed.cleanText)
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
      const parsed = parseAgentHighlights(result, (files() ?? []).map((f) => f.path), new Map((files() ?? []).map((f) => [f.path, codeRows()] as [string, any])), highlights())
      if (parsed.highlights.length > 0) {
        const next = [...highlights(), ...parsed.highlights]
        setHighlights(next)
        try { saveHighlights(next) } catch { /* ignore */ }
        const skipMsg = parsed.skipped.length > 0 ? ` (${parsed.skipped.length} skipped: ${parsed.skipped[0]})` : ""
        setStatus(`AI added ${parsed.highlights.length} highlights${skipMsg}`)
      }
      addEntry("agent", parsed.cleanText)
      setLastAnswer(parsed.cleanText)
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
          setReviewPickerOpen(true)
          setReviewPickerIndex(0)
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
      case "highlights": {
        const toks = rest.split(/\s+/).filter(Boolean)
        if (toks[0] === "clear") {
          if (toks[1] !== "yes") {
            const count = highlights().length
            addEntry("system", `This will delete ${count} saved highlights. Type /highlights clear yes to confirm.`)
            setView("log")
            return
          }
          saveHighlights([])
          setHighlights([])
          setResolvedHighlights(new Map())
          addEntry("system", "cleared all highlights")
          setView("log")
          return
        }
        const hs = highlights()
        if (hs.length === 0) {
          addEntry("system", "No highlights yet.")
          setView("log")
          return
        }
        const lines = hs.map((h) => {
          const status = resolvedHighlights().get(h.id) === null ? "outdated" : ""
          return `${h.path}:${h.start}-${h.end}  ${h.by === "you" ? "you" : "AI " + h.level}  ${h.note || "(no note)"}  ${status}`
        })
        addEntry("system", lines.join("\n"))
        setView("log")
        return
      }
      case "export": {
        const lines: string[] = []
        lines.push("# chert review export")
        lines.push(`Project: ${cwd()}`)
        lines.push(`Reviewing: ${sourceLabel()}`)
        lines.push(`Date: ${new Date().toISOString()}`)
        lines.push("")
        const byFile = new Map<string, any[]>()
        for (const h of highlights()) {
          if (!byFile.has(h.path)) byFile.set(h.path, [])
          byFile.get(h.path)!.push(h)
        }
        for (const [path, hs] of byFile) {
          lines.push(`## ${path}`)
          for (const h of hs) {
            lines.push(`- ${h.by === "you" ? "you" : "AI " + h.level} lines ${h.start}-${h.end}: ${h.note || "(no note)"}`)
            for (const t of h.text) lines.push(`  > ${t}`)
          }
          lines.push("")
        }
        const md = lines.join("\n")
        try {
          const dir = join(gitDir(), "chert")
          mkdirSync(dir, { recursive: true })
          writeFileSync(join(dir, "last-review.md"), md)
          addEntry("system", `Exported to ${join(dir, "last-review.md")}\n\n${md}`)
        } catch (error) {
          addEntry("error", `export failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        setView("log")
        return
      }
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
      case "themes": {
        const arg = rest.trim().toLowerCase()
        if (arg === "") {
          // The bottom suggestion box lists the themes; nothing to do here.
          return
        }
        // resolve name/alias
        const aliases: Record<string, ThemeName> = {
          default: "default", dark: "dark-contrast", "dark-contrast": "dark-contrast", contrast: "dark-contrast",
          white: "whiteout", whiteout: "whiteout", light: "whiteout",
          github: "github", gh: "github",
        }
        const resolved = aliases[arg]
        if (!resolved) {
          addEntry("error", `unknown theme "${rest}" — try: default, dark-contrast, whiteout, github`)
          return
        }
        setTheme(resolved)
        addEntry("system", `theme: ${THEME_LABELS[resolved]}`)
        setStatus(`theme: ${THEME_LABELS[resolved]}`)
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
    const showList = pickerOpen() || (commandQuery() !== null && filteredCommands().length > 0) || (themeInput() !== null && themeSuggestions().length > 0)

    // Review source picker (opened by /review)
    if (reviewPickerOpen()) {
      if (key.name === "up" || key.name === "down") {
        key.preventDefault()
        const items = allReviewTargets()
        const dir = key.name === "up" ? -1 : 1
        setReviewPickerIndex((i) => {
          const next = Math.max(0, Math.min(i + dir, Math.max(0, items.length - 1)))
          try { reviewPickerScrollRef?.scrollTo({ x: 0, y: Math.max(0, next - 6) }) } catch { /* ignore */ }
          return next
        })
        return
      }
      if (key.name === "return" || key.name === "enter") {
        key.preventDefault()
        const items = allReviewTargets()
        const item = items[reviewPickerIndex()]
        if (item) {
          setReviewPickerOpen(false)
          runCommand(item.insert.slice(1))
        }
        return
      }
      if (key.name === "escape") {
        key.preventDefault()
        setReviewPickerOpen(false)
        return
      }
      return
    }

    // Ctrl+P command picker
    if (key.ctrl && key.name === "p") {
      key.preventDefault()
      if (pickerOpen()) setPickerOpen(false)
      else { setPickerOpen(true); setSuggestionIndex(0) }
      return
    }

    // Highlight menu overlay
    if (highlightMenuOpen()) {
      if (key.name === "up" || key.name === "down") {
        key.preventDefault()
        const dir = key.name === "up" ? -1 : 1
        setHighlightMenuIndex((i) => Math.max(0, Math.min(i + dir, 3)))
        return
      }
      if (key.name === "return" || key.name === "enter") {
        key.preventDefault()
        const idx = highlightMenuIndex()
        const cur = codeCursorRow()
        const h = highlightForRowIndex(cur)
        if (!h) { setHighlightMenuOpen(false); return }
        if (idx === 0) {
          // Ask the AI about these lines
          setHighlightMenuOpen(false)
          const q = `Look at lines ${h.start}-${h.end} in ${h.path}. ${h.note ? h.note + " " : ""}The lines are:\n${h.text.map((t) => `  ${t}`).join("\n")}\nExplain in plain words, with the exact lines.`
          markAsked(h.path)
          void askAgent(q)
          return
        }
        if (idx === 1) {
          // Edit note
          setHighlightMenuOpen(false)
          setHighlightNoteMode(true)
          setHighlightNoteText(h.note)
          setPendingHighlight(h)
          setPromptValue(h.note)
          setStatus("edit note (Enter saves, Esc cancels)")
          return
        }
        if (idx === 2) {
          // Dismiss (AI) or Remove (mine)
          const next = highlights().filter((x) => x.id !== h.id)
          setHighlights(next)
          try { saveHighlights(next) } catch { /* ignore */ }
          setResolvedHighlights(new Map(resolvedHighlights()))
          setHighlightMenuOpen(false)
          setStatus(h.by === "ai" ? "dismissed AI highlight" : "removed highlight")
          return
        }
        // Close
        setHighlightMenuOpen(false)
        return
      }
      if (key.name === "escape") {
        key.preventDefault()
        setHighlightMenuOpen(false)
        return
      }
      return
    }

    // Esc
    if (key.name === "escape") {
      if (pickerOpen()) { key.preventDefault(); setPickerOpen(false); return }
      if (menuOpen()) { setMenuOpen(false); setAllFilesOpen(false); return }
      if (projectsOpen()) { setProjectsOpen(false); return }
      if (allFilesOpen()) { setAllFilesOpen(false); return }
      if (reviewPickerOpen()) { setReviewPickerOpen(false); return }
      if (highlightNoteMode()) { setHighlightNoteMode(false); setPendingHighlight(null); clearInput(); setStatus(""); return }
      if (rangeStart() !== null) { setRangeStart(null); setStatus(""); return }
      if (hasText) { clearInput(); return }
      if (view() === "review" && focus() === "code") { setFocus("files"); setStatus(""); return }
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
      const list = visibleSuggestions()
      if (list.length > 0) {
        key.preventDefault()
        setSuggestionIndex((i) => (i + 1) % list.length)
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
      if (themeInput() !== null && visibleSuggestions().length > 0) {
        acceptSuggestion(visibleSuggestions()[Math.min(suggestionIndex(), visibleSuggestions().length - 1)])
        submit()
        return
      }
      if (hasText) {
        submit()
        return
      }
      if (view() === "tree") { openTreeSelection(); return }
      if (view() === "done") { activateDoneRow(doneIndex()); return }
      if (view() === "review" && !hasProject()) { openRecent(projectsIndex()); return }

      if (menuOpen()) { handleMenuSelection(menuIndex()); return }
      if (projectsOpen()) {
        const recents = loadRecent()
        const item = recents[projectsIndex()]
        if (item) {
          setProjectsOpen(false)
          setMenuOpen(false)
          openRecent(projectsIndex())
        }
        return
      }
      if (allFilesOpen()) {
        const af = (files() ?? [])[allFilesIndex()]
        if (af) { setAllFilesOpen(false); setMenuOpen(false); selectFile(files()!.indexOf(af)); setFocus("files") }
        return
      }
      if (view() === "review") {
        if (focus() === "files") {
          activateAction(action())
          return
        }
        // code focus: Enter
        const cur = codeCursorRow()
        const rows = codeRows()
        const row = rows[cur]
        const isCodeRow = row !== undefined && (row.kind === "context" || row.kind === "add" || row.kind === "del")
        const h = highlightForRowIndex(cur)
        if (h) {
          setHighlightMenuOpen(true)
          setHighlightMenuIndex(0)
          return
        }
        if (!isCodeRow) {
          setStatus("Move to a code line to highlight.")
          return
        }
        if (rangeStart() === null) {
          setRangeStart(cur)
          setStatus(`Highlighting from line ${cur + 1}. Move to the last line and press Enter. Esc cancels.`)
          return
        }
        // complete range
        const rs = rangeStart()!
        const start = Math.min(rs, cur)
        const end = Math.max(rs, cur)
        // validate: cannot cross hunk header or mix sides
        const allRows = codeRows()
        const sides = new Set<string>()
        let crossesHunk = false
        let lastHunk = -1
        for (let i = start; i <= end; i++) {
          const r = allRows[i]
          if (!r) { crossesHunk = true; break }
          if (r.kind === "hunk") { crossesHunk = true; break }
          if (r.kind === "meta") { crossesHunk = true; break }
          const side = r.kind === "del" ? "old" : "new"
          sides.add(side)
        }
        if (crossesHunk) {
          setStatus("Highlight range cannot cross a hunk header.")
          setRangeStart(null)
          return
        }
        if (sides.size > 1) {
          setStatus("Highlight range cannot mix old and new sides.")
          setRangeStart(null)
          return
        }
        const side = sides.size === 1 ? (Array.from(sides)[0] as "new" | "old") : "new"
        const textLines = allRows.slice(start, end + 1).map((r) => r.text)
        const before = allRows.slice(Math.max(0, start - 2), start).map((r) => r.text)
        const after = allRows.slice(end + 1, end + 3).map((r) => r.text)
        const lineNo = (r: Row) => (side === "new" ? (r.newNo ?? 0) : (r.oldNo ?? 0))
        const startLine = lineNo(allRows[start])
        const endLine = lineNo(allRows[end])
        const hl: Highlight = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          path: file()?.path ?? "",
          side,
          start: startLine,
          end: endLine,
          text: textLines,
          before,
          after,
          by: "you",
          level: "note",
          note: "",
          createdAt: Date.now(),
        }
        // prompt for note
        setHighlightNoteMode(true)
        setHighlightNoteText("")
        // store pending highlight temporarily? Use a temp signal. We'll save on note submit.
        // Store in a temp variable via a signal.
        setPendingHighlight(hl)
        setRangeStart(null)
        setStatus("note for these lines (Enter saves, Enter with nothing saves without a note, Esc cancels)")
        return
      }
      return
    }

    // Empty box: screen keys
    if (!hasText) {
      if (view() === "done") {
        if (key.name === "up" || key.name === "down") {
          key.preventDefault()
          const dir = key.name === "up" ? -1 : 1
          setDoneIndex((i) => Math.max(0, Math.min(i + dir, Math.max(0, doneOptions().length - 1))))
          return
        }
        return
      }
      if (view() === "review" && !hasProject()) {
        if (key.name === "up" || key.name === "down") {
          key.preventDefault()
          const dir = key.name === "up" ? -1 : 1
          const count = loadRecent().length
          setProjectsIndex((i) => Math.max(0, Math.min(i + dir, Math.max(0, count - 1))))
          return
        }
        if (key.name === "delete") {
          key.preventDefault()
          const item = loadRecent()[projectsIndex()]
          if (item) {
            forgetProject(item.path)
            setProjectsIndex((i) => Math.max(0, Math.min(i, Math.max(0, loadRecent().length - 1))))
            setStatus(`forgot ${basename(item.path)}`)
          }
          return
        }
        return
      }
      if (view() === "review") {
        if (key.name === "left" || key.name === "right") {
          key.preventDefault()
          const dir = key.name === "left" ? -1 : 1
          setAction((i) => Math.max(0, Math.min(i + dir, ACTION_ITEMS.length - 1)))
          return
        }
        if (key.name === "h") {
          key.preventDefault()
          const entering = focus() !== "code"
          setFocus(entering ? "code" : "files")
          setRangeStart(null)
          setStatus("")
          if (entering) {
            const first = codeRows().findIndex((r) => r.kind !== "meta")
            const row = first === -1 ? 0 : first
            setCodeCursor(row)
            try { codeScrollRef?.scrollTo({ x: 0, y: Math.max(0, row - 3) }) } catch { /* ignore */ }
          }
          return
        }
        if (key.name === " " || key.name === "space") {
          key.preventDefault()
          const f = file()
          if (f) {
            const keyStr = `${f.path}\u0000${Bun.hash(patch())}`
            const next = new Set(reviewed())
            if (next.has(keyStr)) next.delete(keyStr)
            else next.add(keyStr)
            setReviewed(next)
          }
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
            return next
          })
          return
        }
        return
      }
      if (projectsOpen()) {
        if (key.name === "up" || key.name === "down") {
          key.preventDefault()
          const dir = key.name === "up" ? -1 : 1
          const recents = loadRecent()
          setProjectsIndex((i) => {
            const next = Math.max(0, Math.min(i + dir, Math.max(0, recents.length - 1)))
            return next
          })
          return
        }
        if (key.name === "delete") {
          key.preventDefault()
          const item = loadRecent()[projectsIndex()]
          if (item) {
            forgetProject(item.path)
            setProjectsIndex((i) => Math.max(0, Math.min(i, Math.max(0, loadRecent().length - 1))))
            setStatus(`forgot ${basename(item.path)}`)
          }
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
            try { allFilesScrollRef?.scrollTo({ x: 0, y: Math.max(0, next - 6) }) } catch { /* ignore */ }
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
      case 2: // Switch project
        setMenuOpen(false)
        setProjectsOpen(true)
        setProjectsIndex(0)
        return
      case 3: // Refresh changes
        setMenuOpen(false)
        if (hasProject()) { load(); setStatus(`refreshed ${files()?.length ?? 0} files`) }
        return
      case 4: // Review something else
        setMenuOpen(false)
        addEntry("system", "Type /review working · /review staged · /review branch [name] · /review last · /review commit <ref>")
        setView("log")
        return
      case 5: // Review summary
        setMenuOpen(false)
        const asked = (files() ?? []).filter((f) => fileMemory().get(f.path) === "asked").length
        const hlYours = highlights().filter((h) => h.by === "you").length
        const hlAi = highlights().filter((h) => h.by === "ai").length
        addEntry("system", `Reviewed ${reviewedCount()} of ${files()?.length ?? 0} files. Asked about ${asked}. Highlights: ${hlYours} yours, ${hlAi} from the AI.`)
        setView("log")
        return
      case 6: // Next unreviewed file
        setMenuOpen(false)
        {
          const unrev = (files() ?? []).find((f) => !reviewed().has(`${f.path}\u0000${Bun.hash(patchCache.get(f.path) ?? "")}`))
          if (unrev) {
            selectFile((files() ?? []).indexOf(unrev))
            setFocus("files")
          }
        }
        return
      case 7: // Help
        addEntry("system", HELP_TEXT)
        setView("log")
        setMenuOpen(false)
        return
      case 8: // Quit
        renderer.destroy()
        process.exit(0)
        return
    }
  }

  function openRecent(index: number): void {
    const item = loadRecent()[index]
    if (!item) return
    const root = enterProject(item.path)
    if (root === undefined) {
      setStatus(`can't open ${displayPath(item.path)}`)
      return
    }
    const savedCwd = hasProject() ? cwd() : null
    if (savedCwd !== null && savedCwd !== root) previousProject = savedCwd
    setProjectsOpen(false)
    setMenuOpen(false)
    setCwd(root)
    setHasProject(true)
    load()
    setView("review")
    setStatus(`opened ${basename(root) || root}`)
  }

  function activateDoneRow(i: number): void {
    const option = doneOptions()[i]
    if (!option) return
    handleDoneSelection(Number(option.value))
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
    if (view() === "tree") return "↑↓ move · Enter open · Esc menu · Ctrl+C quit"
    if (view() === "log") return "Esc menu · Ctrl+C quit"
    if (view() === "done") return "↑↓ choose · Enter go · Ctrl+C quit"
    if (menuOpen()) return "↑↓ choose · Enter go · Esc close · Ctrl+C quit"
    if (allFilesOpen()) return "↑↓ choose · Enter jump · Esc close · Ctrl+C quit"
    if (!hasProject()) return "↑↓ choose · Enter open · /cd <path> · Esc menu · Ctrl+C quit"
    if (focus() === "code") return "↑↓ line · Enter select · Esc done · Ctrl+C quit"
    if (answerOpen() && answerFile() === (file()?.path ?? "")) return "↑↓ file · ←→ action · Enter run · PgUp/PgDn answer · Esc menu"
    return "↑↓ file · ←→ action · Enter run · Space reviewed · h highlight · Esc menu"
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

  // Resolve highlights for the current file whenever rows or highlights change.
  createEffect(() => {
    const rows = codeRows()
    const hs = highlights().filter((h) => h.path === (file()?.path ?? ""))
    const newSide = new Map<string, { startRow: number; endRow: number; moved: boolean } | null>()
    const oldSide = new Map<string, { startRow: number; endRow: number; moved: boolean } | null>()
    // resolve for "new" side
    const newResolved = resolveHighlights(rows, "new", hs)
    const oldResolved = resolveHighlights(rows, "old", hs)
    const merged = new Map<string, { startRow: number; endRow: number; moved: boolean } | null>()
    for (const [k, v] of newResolved) merged.set(k, v)
    for (const [k, v] of oldResolved) if (!merged.has(k)) merged.set(k, v)
    setResolvedHighlights(merged)
  })

  // Reset diff scroll to top whenever the displayed patch changes.
  createEffect(() => {
    patch()
    try { diffScrollRef?.scrollTo({ x: 0, y: 0 }) } catch { /* ignore */ }
  })

  const headerInfo = createMemo(() => {
    if (!hasProject()) return "no project selected"
    const project = cwdBase()
    const count = files() === null ? "loading…" : loadError() ? "error" : `${files()!.length} files`
    return `${project} · ${branch()}`
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

  function highlightColor(h: Highlight): string {
    if (h.by === "you") return COLORS().accent
    if (h.level === "high") return COLORS().danger
    if (h.level === "medium") return "#e0af68"
    return COLORS().dim
  }


  function highlightForRowIndex(idx: number): Highlight | undefined {
    const resolved = resolvedHighlights()
    const hs = highlights().filter((h) => h.path === (file()?.path ?? ""))
    for (const h of hs) {
      const r = resolved.get(h.id)
      if (r && r.startRow <= idx && idx <= r.endRow) return h
    }
    return undefined
  }

  const noteStrip = createMemo(() => {
    const rows = codeRows()
    const idx = codeCursorRow()
    const h = highlightForRowIndex(idx)
    if (!h) return ""
    const who = h.by === "you" ? "you" : `AI ${h.level}`
    const note = h.note.trim() === "" ? "(no note)" : h.note
    return `${who} \u00b7 ${note}`
  })

  function reviewedKeyFor(f: ReviewFile | undefined): string {
    if (!f) return ""
    const p = patchCache.get(f.path) ?? ""
    return `${f.path}\u0000${Bun.hash(p)}`
  }

  const reviewedCount = createMemo(() => {
    const set = reviewed()
    let n = 0
    for (const f of files() ?? []) {
      if (set.has(`${f.path}\u0000${Bun.hash(patchCache.get(f.path) ?? "")}`)) n++
    }
    return n
  })

  const suggestionWindow = createMemo(() => {
    const list = visibleSuggestions()
    const show = pickerOpen() || (commandQuery() !== null && list.length > 0) || (themeInput() !== null && list.length > 0)
    if (!show) return { items: [] as Suggestion[], offset: 0, show: false }
    const max = 8
    const idx = Math.min(suggestionIndex(), Math.max(0, list.length - 1))
    let start = 0
    if (list.length > max) {
      start = Math.min(Math.max(0, idx - max + 1), list.length - max)
    }
    return { items: list.slice(start, start + max), offset: start, show: true }
  })

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={COLORS().bg}>
      <box height={1} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1}>
        <text fg={COLORS().purple} attributes={ATTR.bold}>chert</text>
        <text fg={COLORS().dim}>{` · ${headerInfo()}`}</text>
        <box flexGrow={1} />
        <text fg={COLORS().dim} attributes={ATTR.dim}>{`[ ${activeLabel()} ]`}</text>
      </box>
      <box height={1} flexShrink={0} border={["bottom"]} borderColor={COLORS().rule} />
      <box height={1} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1}>
        <text fg={COLORS().dim} attributes={ATTR.dim}>{hasProject() && view() === "review" ? sourceLabel() : " "}</text>
        <box flexGrow={1} />
        <text fg={COLORS().purpleBright} attributes={ATTR.dim}>
          {hasProject() && view() === "review" ? stepHeader() : " "}
        </text>
      </box>
      <box height={1} flexShrink={0} border={["bottom"]} borderColor={COLORS().rule} />

      <Show when={view() === "done"} fallback={
        <Show when={view() === "log"} fallback={
          <Show when={view() === "tree"} fallback={
            <Show when={mainVisible()}>
              <Show when={hasProject()} fallback={<HomeScreen recents={() => loadRecent()} index={() => projectsIndex()} noProject={true} />}>
                <box flexGrow={1} flexDirection="row">
                  <box width="32%" flexDirection="column" border={["right"]} borderColor={COLORS().rule}>
                    <box height={1} flexShrink={0} paddingLeft={1} paddingRight={1} flexDirection="row">
                      <text fg={focus() === "files" ? COLORS().purple : COLORS().dim} attributes={ATTR.bold}>
                        {`${focus() === "files" ? "\u25B8 " : "  "}Files`}
                      </text>
                      <text fg={COLORS().dim} attributes={ATTR.dim}>{` (${files()?.length ?? 0})`}</text>
                    </box>
                    <scrollbox ref={(el: ScrollBoxRenderable) => { fileScrollRef = el }} flexGrow={1} backgroundColor={COLORS().bg}>
                      <For each={files() ?? []}>
                        {(f, i) => {
                          const active = () => i() === selected()
                          const done = () => reviewed().has(reviewedKeyFor(f))
                          const glyph = () =>
                            f.status === "deleted" ? "D" : f.status === "added" || f.status === "untracked" ? "A" : "M"
                          const glyphFg = () =>
                            f.status === "deleted" ? COLORS().danger : f.status === "added" || f.status === "untracked" ? COLORS().add : COLORS().purpleBright
                          return (
                            <box flexDirection="row" height={1} flexShrink={0} backgroundColor={active() ? COLORS().selectedBg : COLORS().bg}>
                              <text fg={active() ? COLORS().purpleBright : COLORS().rule}>{active() ? "\u25B8 " : "  "}</text>
                              <text fg={done() ? COLORS().add : glyphFg()} attributes={done() ? ATTR.bold : ATTR.none}>
                                {done() ? "\u2713 " : `${glyph()} `}
                              </text>
                              <text fg={active() ? COLORS().bright : COLORS().text} attributes={active() ? ATTR.bold : ATTR.none}>
                                {shortenPath(f.path, 18)}
                              </text>
                            </box>
                          )
                        }}
                      </For>
                    </scrollbox>
                  </box>
                  <box flexGrow={1} flexDirection="column" paddingLeft={1}>
                    <box height={1} flexShrink={0} flexDirection="row">
                      <text fg={focus() === "code" ? COLORS().bright : COLORS().text} attributes={ATTR.bold}>
                        {file()?.path ?? ""}
                      </text>
                      <box flexGrow={1} />
                      <text fg={COLORS().dim} attributes={ATTR.dim}>
                        {`${file() ? (file()!.status === "added" || file()!.status === "untracked" ? "new" : file()!.status === "deleted" ? "deleted" : "changed") : ""}  ${file() ? `+${file()!.additions} -${file()!.deletions}` : ""}`}
                      </text>
                    </box>
                    <box height={1} flexShrink={0} border={["bottom"]} borderColor={COLORS().rule} />
                    <Show when={(files()?.length ?? 0) === 0}>
                      <box height={1} flexShrink={0} paddingTop={1} paddingLeft={1}>
                        <text fg={COLORS().dim}>{"Nothing to review — the working tree is clean."}</text>
                      </box>
                    </Show>
                    <scrollbox
                      ref={(el: ScrollBoxRenderable) => { codeScrollRef = el }}
                      flexGrow={1}
                      backgroundColor={COLORS().bg}
                    >
                      <For each={codeRows()}>
                        {(row, i) => {
                          const isCursor = () => i() === codeCursorRow()
                          const gutter = row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "
                          const num = row.kind === "del" ? (row.oldNo ?? "") : (row.newNo ?? "")
                          const h = () => highlightForRowIndex(i())
                          return (
                            <box flexDirection="row" backgroundColor={isCursor() ? COLORS().selectedBg : (row.kind === "add" ? "#1a2420" : row.kind === "del" ? "#2a1a1f" : COLORS().bg)}>
                              <text fg={COLORS().purple}>{isCursor() && focus() === "code" ? ">" : " "}</text>
                              <text fg={h() ? highlightColor(h()!) : COLORS().dim}>{h() ? "\u258C" : " "}</text>
                              <text fg={COLORS().dim}>{String(num).padStart(4)} </text>
                              <text
                                fg={row.kind === "add" ? COLORS().add : row.kind === "del" ? COLORS().danger : row.kind === "hunk" ? COLORS().purple : row.kind === "meta" ? COLORS().dim : COLORS().text}
                                attributes={row.kind === "meta" ? ATTR.dim : ATTR.none}
                              >{`${gutter} ${row.text}`}</text>
                            </box>
                          )
                        }}
                      </For>
                    </scrollbox>
                    <Show when={answerOpen() && answerFile() === (file()?.path ?? "")}>
                      <box height="35%" border={["top"]} borderColor={COLORS().rule} flexDirection="column" paddingLeft={1}>
                        <text fg={COLORS().dim}>{`You asked: ${lastQuestion().length > 50 ? lastQuestion().slice(0, 50) + "\u2026" : lastQuestion()}  \u00b7  ${activeLabel()}`}</text>
                        <scrollbox
                          ref={(el: ScrollBoxRenderable) => (answerScrollRef = el)}
                          flexGrow={1}
                          backgroundColor={COLORS().bg}
                        >
                          <text wrapMode="word" fg={busy() ? COLORS().dim : (answerIsError() ? COLORS().danger : COLORS().text)}>{busy() ? status() : lastAnswer()}</text>
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
                <text fg={COLORS().dim}>No project open. Type /cd and a project name or folder, for example /cd myapp</text>
              </box>
            }>
              <scrollbox ref={(el: ScrollBoxRenderable) => (treeRef = el)} flexGrow={1} backgroundColor={COLORS().bg} paddingLeft={1}>
                <For each={treeLines()}>
                  {(line, index) => (
                    <text fg={index() === treeIndex() ? COLORS().bright : line.isDir ? COLORS().dim : COLORS().text}>
                      {`${index() === treeIndex() ? "▸ " : "  "}${line.text}`}
                    </text>
                  )}
                </For>
              </scrollbox>
            </Show>
          </Show>
        }>{/* Log view */}
          <scrollbox ref={(el: ScrollBoxRenderable) => (logRef = el)} flexGrow={1} backgroundColor={COLORS().bg} paddingLeft={1}>
            <For each={transcript()}>
              {(entry) => (
                <For each={entry.text.split("\n")}>
                  {(line) => <text fg={entryFg(entry.kind)}>{line === "" ? " " : line}</text>}
                </For>
              )}
            </For>
          </scrollbox>
        </Show>
      }>{/* Done view */}
        <box flexGrow={1} flexDirection="column" paddingLeft={1}>
          <text fg={COLORS().bright}>All done.</text>
          <text fg={COLORS().dim}>{` You looked at ${files()?.length ?? 0} files:  asked about ${(files() ?? []).filter((f) => fileMemory().get(f.path) === "asked").length},  skipped ${(files() ?? []).filter((f) => fileMemory().get(f.path) === "passed").length} without asking.`}</text>
          <Show when={(files() ?? []).filter((f) => fileMemory().get(f.path) === "passed").length === 0}>
            <text fg={COLORS().dim}>You asked about every file.</text>
          </Show>
          <box height={1} />
          <text fg={COLORS().purple} attributes={ATTR.bold}>{"What next"}</text>
          <box height={1} />
          <RowList rows={() => doneOptions().map((o) => ({ label: o.name }))} index={() => doneIndex()} />
          <box flexGrow={1} />
        </box>
      </Show>

      {/* Menu overlay */}

      <Show when={menuOpen()}>
        <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingRight={2}>
          <box height={1} flexShrink={0} />
          <For each={WORDMARK}>
            {(line, i) => (
              <text fg={WORDMARK_FG[i()] ?? COLORS().purple} attributes={ATTR.bold}>
                {line}
              </text>
            )}
          </For>
          <box height={1} flexShrink={0} />
          <text fg={COLORS().dim} attributes={ATTR.dim}>{"menu"}</text>
          <box height={1} flexShrink={0} />
          <RowList
            rows={() => menuOptions().map((o) => ({ label: o.name, hint: o.description }))}
            index={() => menuIndex()}
          />
          <box flexGrow={1} />
        </box>
      </Show>

      {/* All files overlay */}
      <Show when={allFilesOpen()}>
        <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingRight={2}>
          <box height={1} flexShrink={0} />
          <text fg={COLORS().purple} attributes={ATTR.bold}>{`All files (${files()?.length ?? 0})`}</text>
          <box height={1} flexShrink={0} />
          <scrollbox ref={(el: ScrollBoxRenderable) => { allFilesScrollRef = el }} flexGrow={1} backgroundColor={COLORS().bg}>
            <RowList
              rows={() => allFilesOptions().map((o) => ({ label: o.name, hint: o.description }))}
              index={() => allFilesIndex()}
            />
          </scrollbox>
          <box flexGrow={1} />
        </box>
      </Show>

      <Show when={reviewPickerOpen()}>
        <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingRight={2}>
          <box height={1} flexShrink={0} />
          <text fg={COLORS().purple} attributes={ATTR.bold}>{"Review source"}</text>
          <box height={1} flexShrink={0} />
          <scrollbox ref={(el: ScrollBoxRenderable) => { reviewPickerScrollRef = el }} flexGrow={1} backgroundColor={COLORS().bg}>
            <RowList
              rows={() => allReviewTargets().map((s) => ({ label: s.label, hint: s.description }))}
              index={() => reviewPickerIndex()}
            />
          </scrollbox>
          <box flexGrow={1} />
        </box>
      </Show>


      <Show when={highlightMenuOpen()}>
        <box flexGrow={1} flexDirection="column" paddingLeft={1}>
          <text fg={COLORS().bright}>Highlight</text>
          <box height={1} />
          <text fg={highlightMenuIndex() === 0 ? COLORS().bright : COLORS().dim}>{`${highlightMenuIndex() === 0 ? "▸ " : "  "}Ask the AI about these lines`}</text>
          <text fg={highlightMenuIndex() === 1 ? COLORS().bright : COLORS().dim}>{`${highlightMenuIndex() === 1 ? "▸ " : "  "}Edit note`}</text>
          <text fg={highlightMenuIndex() === 2 ? COLORS().bright : COLORS().dim}>{`${highlightMenuIndex() === 2 ? "▸ " : "  "}${highlightForRowIndex(codeCursorRow())?.by === "ai" ? "Dismiss" : "Remove"}`}</text>
          <text fg={highlightMenuIndex() === 3 ? COLORS().bright : COLORS().dim}>{`${highlightMenuIndex() === 3 ? "▸ " : "  "}Close`}</text>
        </box>
      </Show>

      <Show when={projectsOpen()}>
        <HomeScreen recents={() => loadRecent()} index={() => projectsIndex()} noProject={false} />
      </Show>

      <Show
        when={suggestionWindow().show}
        fallback={<box height={1} flexShrink={0} border={["top"]} borderColor={COLORS().rule} />}
      >
        <box flexShrink={0} flexDirection="column" border={["top"]} borderColor={COLORS().rule} paddingLeft={1} paddingRight={1}>
          <Show when={pickerOpen()}>
            <text fg={COLORS().dim}> commands (Ctrl+P)</text>
          </Show>
          <For each={suggestionWindow().items}>
            {(cmd, i) => {
              const idx = () => suggestionWindow().offset + i()
              const active = () => idx() === Math.min(suggestionIndex(), Math.max(0, visibleSuggestions().length - 1))
              const pal = () => (themeInput() !== null ? THEMES[cmd.key as ThemeName] : null)
              const bg = () => pal() ? (active() ? pal()!.selectedBg : pal()!.bg) : (active() ? COLORS().selectedBg : COLORS().bg)
              const labelFg = () => pal() ? (active() ? pal()!.bright : pal()!.accent) : (active() ? COLORS().bright : COLORS().accent)
              const descFg = () => pal() ? (active() ? pal()!.text : pal()!.dim) : (active() ? COLORS().text : COLORS().dim)
              return (
                <box height={1} flexDirection="row" backgroundColor={bg()}>
                  <text fg={labelFg()}>{`${active() ? "▸ " : "  "}${cmd.label}`.padEnd(28)}</text>
                  <text fg={descFg()}>{cmd.description}</text>
                </box>
              )
            }}
          </For>
        </box>
      </Show>

      <Show when={cdMatches() !== null}>
        <box height={1} flexShrink={0} paddingLeft={1}>
          <text fg={COLORS().dim}>
            {cdMatches()!.length === 0
              ? "no saved project matches, press Enter to try it as a folder"
              : `matches: ${cdMatches()!.join(" · ")}`}
          </text>
        </box>
      </Show>
      <Show when={noteStrip() !== ""}>
        <box height={1} flexShrink={0} paddingLeft={1} paddingRight={1}>
          <text fg={COLORS().purpleBright} attributes={ATTR.dim}>{noteStrip()}</text>
        </box>
      </Show>
      <Show when={hasProject() && view() === "review" && !menuOpen() && !allFilesOpen() && !projectsOpen()}>
        <box height={1} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1}>
          <For each={ACTION_ITEMS}>
            {(label, i) => (
              <text
                fg={i() === action() ? COLORS().bg : COLORS().dim}
                bg={i() === action() ? COLORS().purple : undefined}
                attributes={i() === action() ? ATTR.bold : ATTR.none}
              >{` ${label} `}</text>
            )}
          </For>
          <box flexGrow={1} />
          <Show when={focus() === "code"}>
            <text fg={COLORS().purple} attributes={ATTR.dim}>{"highlight mode · Esc to leave"}</text>
          </Show>
        </box>
      </Show>
      <box height={1} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1}>
        <text fg={COLORS().purple} attributes={ATTR.bold}>{"> "}</text>
        <input
          ref={(el: InputRenderable) => {
            inputRef = el
            el.focus()
          }}
          flexGrow={1}
          backgroundColor={COLORS().bg}
          focusedBackgroundColor={COLORS().bg}
          textColor={COLORS().bright}
          focusedTextColor={COLORS().bright}
          placeholder={hasProject() ? "ask a question, or type / for commands" : "open a project with /cd <path>, or press Esc"}
          placeholderColor={COLORS().dim}
          onInput={(value: string) => setInputValue(value)}
        />
      </box>
      <box height={1} flexShrink={0} border={["bottom"]} borderColor={COLORS().rule} />
      <box height={1} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1}>
        <Show when={busy()} fallback={
          <>
            <text fg={COLORS().dim} attributes={ATTR.dim}>{footerHints()}</text>
            <box flexGrow={1} />
            <Show when={status() !== ""}>
              <text fg={COLORS().purpleBright} attributes={ATTR.dim}>{status()}</text>
            </Show>
          </>
        }>
          <text fg={COLORS().purple} attributes={ATTR.dim}>{`${status()} · Ctrl+C quit`}</text>
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
