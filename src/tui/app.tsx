import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { render, useKeyboard, useRenderer } from "@opentui/solid"
import { getTreeSitterClient } from "@opentui/core"
import type { InputRenderable, ScrollBoxRenderable, SelectOption } from "@opentui/core"
import { basename, join } from "node:path"
import { currentBranch, listChangedFiles, listRecentCommits, loadPatch, resolveSha } from "../git"
import type { ReviewSource } from "../git"
import type { ReviewFile } from "../git"
import { buildTreeLines } from "../tree"
import type { TreeLine } from "../tree"
import { PROVIDERS, findProvider, getActive, keySource } from "../connectors"
import { displayPath, loadRecent, openProject, resolveProjectRoot } from "../projects"
import { bestEffort, tryOr } from "../best-effort"
import { MAX_SAVED_HIGHLIGHTS } from "../limits"
import { configDir, readJson, writeJsonAtomic } from "../config"
import { HomeScreen } from "./components/home-screen"
import { Overlays } from "./components/overlays"
import { RowList } from "./components/row-list"
import { Wordmark } from "./components/wordmark"
import { connectCommand, disconnectCommand, modelsCommand, useCommand } from "./commands/connectors"
import {
  cdCommand,
  cwdCommand,
  forgetCommand,
  openCommand,
  projectsCommand,
  refreshCommand,
  treeCommand,
} from "./commands/navigation"
import { exportCommand, highlightsCommand, logCommand, reviewCommand } from "./commands/review"
import { helpCommand, homeCommand, quitCommand, runShellCommand, themesCommand } from "./commands/system"
import { runAgentTurn } from "./services/agent-turn"
import { shortenPath, truncateEnd } from "./format"
import { handleKeyPress } from "./keyboard"
import type { KeyboardContext } from "./keyboard"
import type { CommandDef, Suggestion } from "./commands/registry"
import {
  COMMAND_DEFS,
  HELP_TEXT,
  closestCommand,
  isCloseAutocorrect,
  resolveCommand,
  scoreCommand,
} from "./commands/registry"
import { ATTR, COLORS, THEMES, THEME_DESCRIPTIONS, THEME_LABELS } from "./theme"
import type { ThemeName } from "./theme"
import { QUESTIONS } from "../questions"
import { parsePatch } from "../diffrows"
import type { Row } from "../diffrows"
import { loadHighlights, saveHighlights, resolveHighlights } from "../highlights"
import type { Highlight } from "../highlights"

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

// Terminal cells have no font size, so hierarchy comes from weight and tone:
// bold + bright for what the eye should land on, dim for everything else.

const STATUS_GLYPH: Record<ReviewFile["status"], string> = {
  added: "new",
  modified: "changed",
  deleted: "deleted",
  untracked: "new",
}

function entryFg(kind: EntryKind): string {
  const c = COLORS()
  switch (kind) {
    case "user":
      return c.accent
    case "agent":
      return c.text
    case "system":
      return c.dim
    case "error":
      return c.danger
  }
}

import type { CommandHandler, CommandContext, EntryKind, MainView } from "./commands/context"
/** Commands whose handler lives in a module; the rest are still inline. */
const HANDLERS: Record<string, CommandHandler> = {
  help: helpCommand,
  home: homeCommand,
  run: runShellCommand,
  themes: themesCommand,
  quit: quitCommand,
  refresh: refreshCommand,
  open: openCommand,
  cd: cdCommand,
  projects: projectsCommand,
  forget: forgetCommand,
  cwd: cwdCommand,
  tree: treeCommand,
  review: reviewCommand,
  log: logCommand,
  highlights: highlightsCommand,
  export: exportCommand,
  connect: connectCommand,
  disconnect: disconnectCommand,
  use: useCommand,
  models: modelsCommand,
}

const ACTION_ITEMS = ["Back", "Is it messy?", "Is it safe?", "Next"]

export interface ReviewAppProps {
  /** Repository root to open on mount; the TUI starts at the home screen without one. */
  initialRoot?: string
}

export function ReviewApp(props: ReviewAppProps = {}) {
  const renderer = useRenderer()

  // The CLI passes the root explicitly. Direct mounts (the smoke test) fall
  // back to the process directory once, here, and never again: every later git
  // call takes the root from the cwd() signal.
  const bootstrapRoot = props.initialRoot ?? tryOr(() => resolveProjectRoot(process.cwd()), undefined)

  const [files, setFiles] = createSignal<ReviewFile[] | null>(null)
  const [loadError, setLoadError] = createSignal<string | null>(null)
  const [selected, setSelected] = createSignal(0)
  const [patch, setPatch] = createSignal("")
  const [treeLines, setTreeLines] = createSignal<TreeLine[]>([])
  const [treeIndex, setTreeIndex] = createSignal(0)
  const [view, setView] = createSignal<MainView>("review")
  const [hasProject, setHasProject] = createSignal(bootstrapRoot !== undefined)
  const [reviewSource, setReviewSource] = createSignal<ReviewSource>({ kind: "working" })
  const [branch, setBranch] = createSignal("no commits")
  const [transcript, setTranscript] = createSignal<Array<{ kind: EntryKind; text: string }>>([])
  const [status, setStatus] = createSignal("")
  const [cwd, setCwd] = createSignal(bootstrapRoot ?? "")
  const [connector, setConnector] = createSignal(getActive().connector)
  const [model, setModel] = createSignal<string | undefined>(getActive().model)
  const [inputValue, setInputValue] = createSignal("")
  const [pickerOpen, setPickerOpen] = createSignal(false)
  const [suggestionIndex, setSuggestionIndex] = createSignal(0)

  let previousProject: string | null = null

  // Phase 3 guided review state
  const [action, setAction] = createSignal(3)
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
  const [lastQuestion, setLastQuestion] = createSignal("")
  const [lastAnswer, setLastAnswer] = createSignal("")
  const [answerFile, setAnswerFile] = createSignal("")
  const [answerIsError, setAnswerIsError] = createSignal(false)
  const [focus, setFocus] = createSignal<"files" | "code">("files")
  const [codeCursor, setCodeCursor] = createSignal(0)
  const [reviewed, setReviewed] = createSignal(new Set<string>())
  const [highlights, setHighlights] = createSignal<Highlight[]>([])
  const [resolvedHighlights, setResolvedHighlights] = createSignal(
    new Map<string, { startRow: number; endRow: number; moved: boolean } | null>(),
  )
  const [rangeStart, setRangeStart] = createSignal<number | null>(null)
  const [highlightMenuOpen, setHighlightMenuOpen] = createSignal(false)
  const [highlightMenuIndex, setHighlightMenuIndex] = createSignal(0)
  const [highlightNoteMode, setHighlightNoteMode] = createSignal(false)
  const [highlightNoteText, setHighlightNoteText] = createSignal("")
  const [pendingHighlight, setPendingHighlight] = createSignal<Highlight | null>(null)

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
        return `reviewing: everything on ${currentBranch(cwd())} since ${src.base}`
      case "commit": {
        const subj = truncateEnd(src.subject, 40)
        return `reviewing: commit ${src.sha.slice(0, 7)}: ${subj}`
      }
    }
  })

  const patchCache = new Map<string, string>()
  let patchFor = ""
  let diffScrollRef: ScrollBoxRenderable | undefined
  let inputRef: InputRenderable | undefined
  let codeScrollRef: ScrollBoxRenderable | undefined
  let answerScrollRef: ScrollBoxRenderable | undefined
  let diffRef: any
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

  const isFirstFile = createMemo(() => {
    const q = queue()
    const cur = file()?.path
    if (q.length === 0 || cur === undefined) return true
    return q.indexOf(cur) <= 0
  })

  // Panels that replace the review: menu, all-files list, recent projects.
  const mainVisible = createMemo(
    () => !menuOpen() && !allFilesOpen() && !projectsOpen() && !reviewPickerOpen(),
  )

  function connectorsStatus(): string {
    const lines = [
      "connectors:",
      `  opencode     ${connector() === "opencode" ? "← active" : ""}  local opencode CLI (no key needed)`,
    ]
    for (const provider of PROVIDERS) {
      const source = keySource(provider.id)
      const isActive = connector() === provider.id
      const useModel = isActive ? (model() ?? provider.defaultModel) : provider.defaultModel
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
    return {
      key: def.name,
      label,
      description: def.description,
      insert: `/${def.name}${def.takesArg ? " " : ""}`,
    }
  }

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
      for (const c of listRecentCommits(cwd())) {
        const short = c.sha.slice(0, 7)
        items.push({ key: c.sha, label: short, description: c.subject, insert: `/review commit ${c.sha}` })
      }
    }
    return items
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

  // Persisted review source per project
  function reviewSourcesPath(): string {
    return join(configDir(), "review-sources.json")
  }
  function loadSavedReviewSource(root: string): ReviewSource | null {
    const parsed = readJson<Record<string, ReviewSource>>(reviewSourcesPath())
    const src = parsed?.[root]
    if (!src || typeof src.kind !== "string") return null
    if (src.kind === "commit" && resolveSha(cwd(), src.sha) === null) return null
    return src
  }
  function saveReviewSource(root: string, src: ReviewSource): void {
    const obj = readJson<Record<string, ReviewSource>>(reviewSourcesPath()) ?? {}
    obj[root] = src
    writeJsonAtomic(reviewSourcesPath(), obj)
  }
  function setReviewSourcePersist(src: ReviewSource): void {
    setReviewSource(src)
    bestEffort("persist review source", () => saveReviewSource(cwd(), src))
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
    // Reconciliation is informational: failing it only loses the
    // "reviewed files changed" warning.
    bestEffort("reconcile reviewed files", () => {
      const oldSet = reviewed()
      const newFiles = listChangedFiles(cwd(), reviewSource())
      for (const k of oldSet) {
        const [path, oldHash] = k.split("\u0000")
        const f = newFiles.find((x) => x.path === path)
        if (f) {
          const p = loadPatch(cwd(), f, reviewSource())
          if (String(Bun.hash(p)) !== oldHash) unChecked++
        }
      }
    })
    setQueue([])
    setFileMemory(new Map())
    setAction(3)
    setMenuOpen(false)
    if (unChecked > 0) setStatus(`${unChecked} reviewed files changed and were un-checked`)
    setAllFilesOpen(false)
    setAnswerOpen(false)
    setAnswerFile("")
    setAnswerIsError(false)
    try {
      setHighlights(loadHighlights(cwd()))
      setFiles(listChangedFiles(cwd(), reviewSource()))
      // currentBranch(cwd()) already reports "no commits" for a HEAD-less repo.
      setBranch(tryOr(() => currentBranch(cwd()), "no commits"))
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
      setBranch("no commits")
    }
    selectFile(0)
    const list = files()
    setQueue(list ? list.map((f) => f.path) : [])
    if (view() === "tree") {
      // A failed rebuild leaves the previous tree on screen; refreshing again
      // is one keypress away.
      bestEffort("refresh tree", () => {
        setTreeLines(buildTreeLines(cwd(), changedGlyphs()))
        setTreeIndex(0)
      })
    }
  }

  function selectFile(index: number): void {
    const list = files()
    if (!list || list.length === 0) return
    const i = Math.max(0, Math.min(index, list.length - 1))
    setSelected(i)
    bestEffort("scroll fileScrollRef", () => fileScrollRef?.scrollTo({ x: 0, y: Math.max(0, i - 6) }))
    const current = list[i]
    if (patchFor === current.path) {
      setAction(3)
      return
    }
    const cached = patchCache.get(current.path)
    if (cached !== undefined) {
      setPatch(cached)
      patchFor = current.path
      setAction(3)
      bestEffort("scroll diffScrollRef", () => diffScrollRef?.scrollTo({ x: 0, y: 0 }))
      return
    }
    try {
      const result = loadPatch(cwd(), current, reviewSource())
      patchCache.set(current.path, result)
      setPatch(result)
      patchFor = current.path
    } catch (error) {
      setPatch(
        `Error loading diff for ${current.path}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    setAction(3)
    bestEffort("scroll diffScrollRef", () => diffScrollRef?.scrollTo({ x: 0, y: 0 }))
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
      setTreeLines(buildTreeLines(cwd(), changedGlyphs()))
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
    setAction(3)
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

  if (bootstrapRoot !== undefined) {
    const saved = loadSavedReviewSource(bootstrapRoot)
    if (saved) setReviewSource(saved)
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
        description:
          f.status === "added" || f.status === "untracked"
            ? "new"
            : f.status === "deleted"
              ? "deleted"
              : "changed",
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
        if (persistHighlights([...highlights(), finalHl])) {
          setStatus(`highlighted lines ${hl.start}-${hl.end}`)
        }
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
    setAction(3)
    void askAgent(raw)
  }

  /**
   * Replace the highlight list and persist it. Returns false (with a status
   * message) when the write failed, so the caller does not report success.
   */
  let capWarningShown = false

  function persistHighlights(next: Highlight[]): boolean {
    setHighlights(next)
    try {
      const result = saveHighlights(cwd(), next)
      if (result.overCap && !capWarningShown) {
        capWarningShown = true
        setStatus(`over ${MAX_SAVED_HIGHLIGHTS} highlights: yours are all kept, new AI ones will not be`)
      }
      return true
    } catch (error) {
      setStatus(`could not save highlights: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /** Diff rows for any changed file, not just the one currently on screen. */
  function patchRowsFor(path: string): Row[] | undefined {
    const target = (files() ?? []).find((f) => f.path === path)
    if (target === undefined) return undefined
    // The caller reports the file in its skipped list when this is undefined.
    return tryOr(() => parsePatch(loadPatch(cwd(), target, reviewSource())), undefined)
  }

  async function askAgent(prompt: string): Promise<void> {
    addEntry("user", prompt)
    setLastQuestion(prompt)
    setBusy(true)
    setLastAnswer("")
    setAnswerIsError(false)
    const startedAt = Date.now()
    let statusPrefix = "Thinking… "
    // The prefix changes once a provider is known; the ticker reads it live.
    const tick = () => setStatus(`${statusPrefix}${Math.floor((Date.now() - startedAt) / 1000)}s`)
    tick()
    const interval = setInterval(tick, 1000)
    // There is no cancel affordance yet; request timeouts are the backstop.
    try {
      const turn = await runAgentTurn({
        prompt,
        connectorId: connector(),
        model: model(),
        projectRoot: cwd(),
        changedFiles: (files() ?? []).map((f) => f.path),
        getRows: patchRowsFor,
        existingHighlights: highlights(),
        onPrefixChange: (prefix) => {
          statusPrefix = prefix
          tick()
        },
      })
      if (turn.highlights.length > 0 && persistHighlights([...highlights(), ...turn.highlights])) {
        const skipMsg = turn.skipped.length > 0 ? ` (${turn.skipped.length} skipped: ${turn.skipped[0]})` : ""
        setStatus(`AI added ${turn.highlights.length} highlights${skipMsg}`)
      }
      addEntry(turn.isError ? "error" : "agent", turn.text)
      setLastAnswer(turn.text)
      setAnswerIsError(turn.isError)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      addEntry("error", message)
      setLastAnswer(message)
      setAnswerIsError(true)
    } finally {
      clearInterval(interval)
      setBusy(false)
      const v = view()
      if (v === "review") {
        setAnswerFile(file()?.path ?? "")
        setAnswerOpen(true)
        setAction(3)
        setStatus("")
      } else if (v === "tree") {
        setStatus("answer ready, press a in review")
      } else {
        setStatus("")
      }
    }
  }

  /** Chdir into a project, remember it and load its review. */
  function openProjectAt(path: string): string | undefined {
    const root = openProject(path)
    if (root === undefined) return undefined
    const savedRoot = hasProject() ? cwd() : null
    if (savedRoot !== null && savedRoot !== root) previousProject = savedRoot
    const saved = loadSavedReviewSource(root)
    if (saved) setReviewSource(saved)
    setCwd(root)
    setHasProject(true)
    load()
    setView("review")
    return root
  }

  /** The narrow surface slash-command handlers are allowed to use. */
  function buildCommandContext(args: string): CommandContext {
    return {
      args,
      addEntry,
      setStatus,
      setView,
      setPromptValue,
      openMenu: () => setMenuOpen(true),
      quit: () => {
        renderer.destroy()
        process.exit(0)
      },
      hasProject,
      projectRoot: cwd,
      files: () => files() ?? [],
      openProjectAt,
      previousProjectPath: () => previousProject,
      refresh: load,
      listProjects,
      openTree: loadTree,
      selectFile,
      applyReviewSource: (source) => {
        setReviewSourcePersist(source)
        load()
      },
      restoreSavedReviewSource: (root) => {
        const saved = loadSavedReviewSource(root)
        if (saved) setReviewSource(saved)
      },
      openReviewPicker: () => {
        setReviewPickerOpen(true)
        setReviewPickerIndex(0)
      },
      sourceLabel,
      highlights,
      persistHighlights,
      clearHighlights: () => {
        saveHighlights(cwd(), [])
        setHighlights([])
        setResolvedHighlights(new Map())
      },
      isHighlightOutdated: (id) => resolvedHighlights().get(id) === null,
      connectorId: connector,
      model,
      setConnector: (id, nextModel) => {
        setConnector(id)
        setModel(nextModel)
      },
      activeLabel,
      connectorsStatus,
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

    const handler = HANDLERS[def.name]
    if (handler) {
      handler(buildCommandContext(rest))
      return
    }
    addEntry("error", `unknown command /${name} — try /help`)
    setView("log")
  }

  /** The surface the keyboard handler may use. */
  function keyboardContext(): KeyboardContext {
    return {
      hasInputText: () => (inputRef?.value ?? "") !== "",
      hasSuggestions: () =>
        pickerOpen() ||
        (commandQuery() !== null && filteredCommands().length > 0) ||
        (themeInput() !== null && themeSuggestions().length > 0),
      actionCount: () => ACTION_ITEMS.length,

      reviewPickerOpen,
      setReviewPickerOpen,
      reviewPickerIndex,
      setReviewPickerIndex,
      allReviewTargets,
      scrollReviewPicker: (y) =>
        bestEffort("scroll review picker", () => reviewPickerScrollRef?.scrollTo({ x: 0, y })),

      pickerOpen,
      setPickerOpen,
      suggestionIndex,
      setSuggestionIndex,
      visibleSuggestions,
      acceptSuggestion,
      setPromptValue,
      clearInput,
      submit,
      themeInput,
      themeSuggestions,
      cdMatches,
      runCommand,

      highlightMenuOpen,
      setHighlightMenuOpen,
      highlightMenuIndex,
      setHighlightMenuIndex,
      highlightNoteMode,
      setHighlightNoteMode,
      setHighlightNoteText,
      setPendingHighlight,
      highlightForRowIndex,
      highlights,
      setResolvedHighlights,
      resolvedHighlights,
      persistHighlights,
      markAsked,
      askAgent: (prompt) => {
        void askAgent(prompt)
      },

      menuOpen,
      setMenuOpen,
      menuIndex,
      setMenuIndex,
      menuOptions,
      handleMenuSelection,
      projectsOpen,
      setProjectsOpen,
      projectsIndex,
      setProjectsIndex,
      allFilesOpen,
      setAllFilesOpen,
      allFilesIndex,
      setAllFilesIndex,
      view,
      setStatus,
      hasProject,
      openRecent,
      loadRecent,

      focus,
      setFocus,
      action,
      setAction,
      activateAction,
      navigate,
      rangeStart,
      setRangeStart,
      codeRows,
      codeCursor,
      setCodeCursor,
      codeCursorRow,
      scrollCode: (y) => bestEffort("scroll code", () => codeScrollRef?.scrollTo({ x: 0, y })),
      file,
      files: () => files() ?? [],
      selectFile,
      patch,
      reviewed,
      setReviewed,
      scrollAllFiles: (y) => bestEffort("scroll all files", () => allFilesScrollRef?.scrollTo({ x: 0, y })),

      moveTreeIndex,
      openTreeSelection,
      doneIndex,
      setDoneIndex,
      doneOptions,
      activateDoneRow,
    }
  }

  useKeyboard((key) => handleKeyPress(keyboardContext(), key))

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
        if (hasProject()) {
          load()
          setStatus(`refreshed ${files()?.length ?? 0} files`)
        }
        return
      case 4: // Review something else
        setMenuOpen(false)
        addEntry(
          "system",
          "Type /review working · /review staged · /review branch [name] · /review last · /review commit <ref>",
        )
        setView("log")
        return
      case 5: // Review summary
        setMenuOpen(false)
        const asked = (files() ?? []).filter((f) => fileMemory().get(f.path) === "asked").length
        const hlYours = highlights().filter((h) => h.by === "you").length
        const hlAi = highlights().filter((h) => h.by === "ai").length
        addEntry(
          "system",
          `Reviewed ${reviewedCount()} of ${files()?.length ?? 0} files. Asked about ${asked}. Highlights: ${hlYours} yours, ${hlAi} from the AI.`,
        )
        setView("log")
        return
      case 6: // Next unreviewed file
        setMenuOpen(false)
        {
          const unrev = (files() ?? []).find(
            (f) => !reviewed().has(`${f.path}\u0000${Bun.hash(patchCache.get(f.path) ?? "")}`),
          )
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
    const root = openProject(item.path)
    if (root === undefined) {
      setStatus(`can't open ${displayPath(item.path)}`)
      return
    }
    const savedCwd = hasProject() ? cwd() : null
    if (savedCwd !== null && savedCwd !== root) previousProject = savedCwd
    setProjectsOpen(false)
    setMenuOpen(false)
    const saved = loadSavedReviewSource(root)
    if (saved) setReviewSource(saved)
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
    const total = files()?.length ?? 0
    const opts: SelectOption[] = []
    if (skippedCount > 0)
      opts.push({ name: `Go back over the ${skippedCount} skipped files`, description: "", value: 0 })
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
      if (busy()) {
        setStatus("Still thinking about your last question.")
        return
      }
      markAsked(cur)
      setAction(3)
      void askAgent(QUESTIONS.messy(cur))
      return
    }
    if (i === 2) {
      if (busy()) {
        setStatus("Still thinking about your last question.")
        return
      }
      markAsked(cur)
      setAction(3)
      void askAgent(QUESTIONS.safe(cur))
      return
    }
    if (i === 3) {
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
    if (answerOpen() && answerFile() === (file()?.path ?? ""))
      return "↑↓ file · ←→ action · Enter run · PgUp/PgDn answer · Esc menu"
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
      bestEffort("scroll diffScrollRef", () => diffScrollRef?.scrollTo({ x: 0, y: 0 }))
    }, 50)
  })

  // Resolve highlights for the current file whenever rows or highlights change.
  createEffect(() => {
    const rows = codeRows()
    const hs = highlights().filter((h) => h.path === (file()?.path ?? ""))
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
    bestEffort("scroll diffScrollRef", () => diffScrollRef?.scrollTo({ x: 0, y: 0 }))
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
    const show =
      pickerOpen() ||
      (commandQuery() !== null && list.length > 0) ||
      (themeInput() !== null && list.length > 0)
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
        <text fg={COLORS().dim} attributes={ATTR.dim}>
          {hasProject() && view() === "review" ? sourceLabel() : " "}
        </text>
        <box flexGrow={1} />
        <text fg={COLORS().purpleBright} attributes={ATTR.dim}>
          {`${hasProject() && view() === "review" ? `${stepHeader()}  ` : ""}[ ${activeLabel()} ]`}
        </text>
      </box>
      <box height={1} flexShrink={0} border={["bottom"]} borderColor={COLORS().rule} />
      <Show when={!hasProject()}>
        <box flexShrink={0} flexDirection="column" paddingLeft={2} paddingRight={2}>
          <box height={1} flexShrink={0} />
          <Wordmark />
          <box height={1} flexShrink={0} />
          <text fg={COLORS().dim}>{"review your changes, one file at a time"}</text>
          <box height={1} flexShrink={0} />
        </box>
      </Show>
      <Show when={hasProject() && answerOpen() && answerFile() === (file()?.path ?? "")}>
        <box
          height="35%"
          border={["bottom"]}
          borderColor={COLORS().rule}
          flexDirection="column"
          paddingLeft={1}
        >
          <text
            fg={COLORS().dim}
          >{`You asked: ${truncateEnd(lastQuestion(), 50)}  \u00b7  ${activeLabel()}`}</text>
          <scrollbox
            ref={(el: ScrollBoxRenderable) => (answerScrollRef = el)}
            flexGrow={1}
            backgroundColor={COLORS().bg}
          >
            <text
              wrapMode="word"
              fg={busy() ? COLORS().dim : answerIsError() ? COLORS().danger : COLORS().text}
            >
              {busy() ? status() : lastAnswer()}
            </text>
          </scrollbox>
        </box>
      </Show>
      <box height={1} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1}>
        <text fg={COLORS().purple} attributes={ATTR.bold}>
          {"> "}
        </text>
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
          placeholder={
            hasProject()
              ? "ask a question, or type / for commands"
              : "open a project with /cd <path>, or press Esc"
          }
          placeholderColor={COLORS().dim}
          onInput={(value: string) => setInputValue(value)}
        />
      </box>
      <Show
        when={suggestionWindow().show}
        fallback={<box height={1} flexShrink={0} border={["bottom"]} borderColor={COLORS().rule} />}
      >
        <box
          flexShrink={0}
          flexDirection="column"
          border={["bottom"]}
          borderColor={COLORS().rule}
          paddingLeft={1}
          paddingRight={1}
        >
          <Show when={pickerOpen()}>
            <text fg={COLORS().dim}> commands (Ctrl+P)</text>
          </Show>
          <For each={suggestionWindow().items}>
            {(cmd, i) => {
              const idx = () => suggestionWindow().offset + i()
              const active = () =>
                idx() === Math.min(suggestionIndex(), Math.max(0, visibleSuggestions().length - 1))
              const pal = () => (themeInput() !== null ? THEMES[cmd.key as ThemeName] : null)
              const bg = () =>
                pal()
                  ? active()
                    ? pal()!.selectedBg
                    : pal()!.bg
                  : active()
                    ? COLORS().selectedBg
                    : COLORS().bg
              const labelFg = () =>
                pal()
                  ? active()
                    ? pal()!.bright
                    : pal()!.accent
                  : active()
                    ? COLORS().bright
                    : COLORS().accent
              const descFg = () =>
                pal() ? (active() ? pal()!.text : pal()!.dim) : active() ? COLORS().text : COLORS().dim
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
      <box height={1} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1}>
        <Show
          when={busy()}
          fallback={
            <>
              <text fg={COLORS().dim} attributes={ATTR.dim}>
                {footerHints()}
              </text>
              <box flexGrow={1} />
              <Show when={status() !== ""}>
                <text fg={COLORS().purpleBright} attributes={ATTR.dim}>
                  {status()}
                </text>
              </Show>
            </>
          }
        >
          <text fg={COLORS().purple} attributes={ATTR.dim}>{`${status()} · Ctrl+C quit`}</text>
        </Show>
      </box>
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
            <text fg={COLORS().purple} attributes={ATTR.dim}>
              {"highlight mode · Esc to leave"}
            </text>
          </Show>
        </box>
      </Show>
      <box height={1} flexShrink={0} border={["bottom"]} borderColor={COLORS().rule} />

      <Show
        when={view() === "done"}
        fallback={
          <Show
            when={view() === "log"}
            fallback={
              <Show
                when={view() === "tree"}
                fallback={
                  <Show when={mainVisible()}>
                    <Show
                      when={hasProject()}
                      fallback={<HomeScreen recents={() => loadRecent()} index={() => projectsIndex()} />}
                    >
                      <box flexGrow={1} flexDirection="row">
                        <box
                          width="32%"
                          flexDirection="column"
                          border={["right"]}
                          borderColor={COLORS().rule}
                        >
                          <box height={1} flexShrink={0} paddingLeft={1} paddingRight={1} flexDirection="row">
                            <text
                              fg={focus() === "files" ? COLORS().purple : COLORS().dim}
                              attributes={ATTR.bold}
                            >
                              {`${focus() === "files" ? "\u25B8 " : "  "}Files`}
                            </text>
                            <text
                              fg={COLORS().dim}
                              attributes={ATTR.dim}
                            >{` (${files()?.length ?? 0})`}</text>
                          </box>
                          <scrollbox
                            ref={(el: ScrollBoxRenderable) => {
                              fileScrollRef = el
                            }}
                            flexGrow={1}
                            backgroundColor={COLORS().bg}
                          >
                            <For each={files() ?? []}>
                              {(f, i) => {
                                const active = () => i() === selected()
                                const done = () => reviewed().has(reviewedKeyFor(f))
                                const glyph = () =>
                                  f.status === "deleted"
                                    ? "D"
                                    : f.status === "added" || f.status === "untracked"
                                      ? "A"
                                      : "M"
                                const glyphFg = () =>
                                  f.status === "deleted"
                                    ? COLORS().danger
                                    : f.status === "added" || f.status === "untracked"
                                      ? COLORS().add
                                      : COLORS().purpleBright
                                return (
                                  <box
                                    flexDirection="row"
                                    height={1}
                                    flexShrink={0}
                                    backgroundColor={active() ? COLORS().selectedBg : COLORS().bg}
                                  >
                                    <text fg={active() ? COLORS().purpleBright : COLORS().rule}>
                                      {active() ? "\u25B8 " : "  "}
                                    </text>
                                    <text
                                      fg={done() ? COLORS().add : glyphFg()}
                                      attributes={done() ? ATTR.bold : ATTR.none}
                                    >
                                      {done() ? "\u2713 " : `${glyph()} `}
                                    </text>
                                    <text
                                      fg={active() ? COLORS().bright : COLORS().text}
                                      attributes={active() ? ATTR.bold : ATTR.none}
                                    >
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
                            <text
                              fg={focus() === "code" ? COLORS().bright : COLORS().text}
                              attributes={ATTR.bold}
                            >
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
                              <text fg={COLORS().dim}>
                                {"Nothing to review — the working tree is clean."}
                              </text>
                            </box>
                          </Show>
                          <scrollbox
                            ref={(el: ScrollBoxRenderable) => {
                              codeScrollRef = el
                            }}
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
                                  <box
                                    flexDirection="row"
                                    backgroundColor={
                                      isCursor()
                                        ? COLORS().selectedBg
                                        : row.kind === "add"
                                          ? "#1a2420"
                                          : row.kind === "del"
                                            ? "#2a1a1f"
                                            : COLORS().bg
                                    }
                                  >
                                    <text fg={COLORS().purple}>
                                      {isCursor() && focus() === "code" ? ">" : " "}
                                    </text>
                                    <text fg={h() ? highlightColor(h()!) : COLORS().dim}>
                                      {h() ? "\u258C" : " "}
                                    </text>
                                    <text fg={COLORS().dim}>{String(num).padStart(4)} </text>
                                    <text
                                      fg={
                                        row.kind === "add"
                                          ? COLORS().add
                                          : row.kind === "del"
                                            ? COLORS().danger
                                            : row.kind === "hunk"
                                              ? COLORS().purple
                                              : row.kind === "meta"
                                                ? COLORS().dim
                                                : COLORS().text
                                      }
                                      attributes={row.kind === "meta" ? ATTR.dim : ATTR.none}
                                    >{`${gutter} ${row.text}`}</text>
                                  </box>
                                )
                              }}
                            </For>
                          </scrollbox>
                        </box>
                      </box>
                    </Show>
                  </Show>
                }
              >
                {/* Tree view */}
                <Show
                  when={hasProject()}
                  fallback={
                    <box flexGrow={1} paddingLeft={1}>
                      <text fg={COLORS().dim}>
                        No project open. Type /cd and a project name or folder, for example /cd myapp
                      </text>
                    </box>
                  }
                >
                  <scrollbox
                    ref={(el: ScrollBoxRenderable) => (treeRef = el)}
                    flexGrow={1}
                    backgroundColor={COLORS().bg}
                    paddingLeft={1}
                  >
                    <For each={treeLines()}>
                      {(line, index) => (
                        <text
                          fg={
                            index() === treeIndex()
                              ? COLORS().bright
                              : line.isDir
                                ? COLORS().dim
                                : COLORS().text
                          }
                        >
                          {`${index() === treeIndex() ? "▸ " : "  "}${line.text}`}
                        </text>
                      )}
                    </For>
                  </scrollbox>
                </Show>
              </Show>
            }
          >
            {/* Log view */}
            <scrollbox
              ref={(el: ScrollBoxRenderable) => (logRef = el)}
              flexGrow={1}
              backgroundColor={COLORS().bg}
              paddingLeft={1}
            >
              <For each={transcript()}>
                {(entry) => (
                  <For each={entry.text.split("\n")}>
                    {(line) => <text fg={entryFg(entry.kind)}>{line === "" ? " " : line}</text>}
                  </For>
                )}
              </For>
            </scrollbox>
          </Show>
        }
      >
        {/* Done view */}
        <box flexGrow={1} flexDirection="column" paddingLeft={1}>
          <text fg={COLORS().bright}>All done.</text>
          <text
            fg={COLORS().dim}
          >{` You looked at ${files()?.length ?? 0} files:  asked about ${(files() ?? []).filter((f) => fileMemory().get(f.path) === "asked").length},  skipped ${(files() ?? []).filter((f) => fileMemory().get(f.path) === "passed").length} without asking.`}</text>
          <Show when={(files() ?? []).filter((f) => fileMemory().get(f.path) === "passed").length === 0}>
            <text fg={COLORS().dim}>You asked about every file.</text>
          </Show>
          <box height={1} />
          <text fg={COLORS().purple} attributes={ATTR.bold}>
            {"What next"}
          </text>
          <box height={1} />
          <RowList rows={() => doneOptions().map((o) => ({ label: o.name }))} index={() => doneIndex()} />
          <box flexGrow={1} />
        </box>
      </Show>

      <Overlays
        menuOpen={menuOpen}
        menuIndex={menuIndex}
        menuOptions={menuOptions}
        allFilesOpen={allFilesOpen}
        allFilesIndex={allFilesIndex}
        allFilesOptions={allFilesOptions}
        fileCount={() => files()?.length ?? 0}
        onAllFilesScroll={(el: ScrollBoxRenderable) => {
          allFilesScrollRef = el
        }}
        reviewPickerOpen={reviewPickerOpen}
        reviewPickerIndex={reviewPickerIndex}
        allReviewTargets={allReviewTargets}
        onReviewPickerScroll={(el: ScrollBoxRenderable) => {
          reviewPickerScrollRef = el
        }}
        highlightMenuOpen={highlightMenuOpen}
        highlightMenuIndex={highlightMenuIndex}
        highlightForRowIndex={highlightForRowIndex}
        codeCursorRow={codeCursorRow}
        projectsOpen={projectsOpen}
        projectsIndex={projectsIndex}
        loadRecent={loadRecent}
      />

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
          <text fg={COLORS().purpleBright} attributes={ATTR.dim}>
            {noteStrip()}
          </text>
        </box>
      </Show>
    </box>
  )
}

export async function launch(startDir?: string): Promise<void> {
  // CLI boundary: the only place that reads the process working directory to
  // decide what to open. A failure leaves the home screen up.
  const root = tryOr(() => openProject(startDir ?? process.cwd()), undefined)
  // Syntax highlighting is a nicety; the TUI works without tree-sitter.
  await getTreeSitterClient()
    .initialize()
    .catch(() => {})
  await render(() => <ReviewApp initialRoot={root} />, { exitOnCtrlC: true })
}
