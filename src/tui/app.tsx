import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { render, useKeyboard, useRenderer, useSelectionHandler, useTerminalDimensions } from "@opentui/solid"
import { getTreeSitterClient } from "@opentui/core"
import type {
  BoxRenderable,
  InputRenderable,
  ScrollBoxRenderable,
  SelectOption,
  TextRenderable,
} from "@opentui/core"
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
import { SuggestionBox } from "./components/suggestion-box"
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
import { shortenPath, truncateEnd, truncateMiddle } from "./format"
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
import { parsePatch } from "../diffrows"
import type { Row } from "../diffrows"
import { loadHighlights, saveHighlights, resolveHighlights } from "../highlights"
import type { Highlight } from "../highlights"
import { highlightFromRows, rowsUnderDrag } from "./selection"
import { analysisText } from "../review/format"
import { writeHandback } from "../review/handback"
import {
  clearApproval,
  emptyState,
  isApproved,
  loadReviewState,
  patchHash,
  pruneApprovals,
  saveReviewState,
  setApproval,
  sourceKey,
} from "../review/state"
import type { ReviewState } from "../review/state"
import { createWalk } from "../review/walk"
import type { Walk, WalkFileResult } from "../review/walk"
import type { AskResponse, PlanResponse } from "../review/protocol"
import type { HarnessAdapter } from "../harness/types"
import { createClaudeHarness } from "../harness/claude"
import { createOpencodeHarness } from "../harness/opencode"
import { walkCommand } from "./commands/walk"

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
  walk: walkCommand,
  connect: connectCommand,
  disconnect: disconnectCommand,
  use: useCommand,
  models: modelsCommand,
}

/** A failure or note shown over the current screen, never instead of it. */
interface Alert {
  kind: "error" | "notice"
  text: string
}

export interface ReviewAppProps {
  /** Repository root to open on mount; the TUI starts at the home screen without one. */
  initialRoot?: string
}

export function ReviewApp(props: ReviewAppProps = {}) {
  const renderer = useRenderer()
  const dims = useTerminalDimensions()

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
  const [alert, setAlert] = createSignal<Alert | null>(null)
  const [cwd, setCwd] = createSignal(bootstrapRoot ?? "")
  const [connector, setConnector] = createSignal(getActive().connector)
  const [model, setModel] = createSignal<string | undefined>(getActive().model)
  const [inputValue, setInputValue] = createSignal("")
  const [pickerOpen, setPickerOpen] = createSignal(false)
  const [suggestionIndex, setSuggestionIndex] = createSignal(0)

  let previousProject: string | null = null

  // Phase 3 guided review state
  const [action, setAction] = createSignal(1)
  const [queue, setQueue] = createSignal<string[]>([])
  const [fileMemory, setFileMemory] = createSignal(new Map<string, "asked" | "passed">())
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [menuIndex, setMenuIndex] = createSignal(0)
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
  // Approvals live in review-state.json; the counter makes their reads reactive.
  const [approvalsVersion, setApprovalsVersion] = createSignal(0)
  let reviewState: ReviewState = emptyState()
  let patchHashes = new Map<string, string>()
  const [walkIntent, setWalkIntent] = createSignal("")
  const [walkSession, setWalkSession] = createSignal<string | null>(null)
  const [walkActive, setWalkActive] = createSignal(false)
  const [walkReading, setWalkReading] = createSignal<string | null>(null)
  const [walkReasons, setWalkReasons] = createSignal(new Map<string, string>())
  const [pendingAskPath, setPendingAskPath] = createSignal<string | null>(null)
  // One entry per file the agent has explained, and one per question, so moving
  // back and forth restores that file's words without asking again.
  let walkReports = new Map<string, WalkFileResult>()
  let walkAnswers = new Map<string, { question: string; text: string; isError: boolean }>()
  // Bumped whenever the walk is stopped or replaced; late callbacks are ignored.
  let walkToken = 0
  let walk: Walk | null = null
  const [highlights, setHighlights] = createSignal<Highlight[]>([])
  const [resolvedHighlights, setResolvedHighlights] = createSignal(
    new Map<string, { startRow: number; endRow: number; moved: boolean } | null>(),
  )
  // The agent band's height in rows, changed by dragging its top edge.
  const [agentHeight, setAgentHeight] = createSignal(5)

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
  let logRef: ScrollBoxRenderable | undefined
  let treeRef: ScrollBoxRenderable | undefined
  let fileScrollRef: ScrollBoxRenderable | undefined

  const file = createMemo(() => {
    const list = files()
    if (!list || list.length === 0) return undefined
    return list[Math.min(selected(), list.length - 1)]
  })

  /** The answer band is only tall when it has something to show for this file. */
  const answerShowing = createMemo(() => {
    const path = file()?.path ?? ""
    const asking = busy() && (pendingAskPath() === null || pendingAskPath() === path)
    return asking || walkReading() === path || (answerOpen() && answerFile() === path)
  })

  const isFirstFile = createMemo(() => {
    const q = queue()
    const cur = file()?.path
    if (q.length === 0 || cur === undefined) return true
    return q.indexOf(cur) <= 0
  })

  const isLastFile = createMemo(() => {
    const q = queue()
    const cur = file()?.path
    if (q.length === 0 || cur === undefined) return (files()?.length ?? 0) <= 1
    return q.indexOf(cur) === q.length - 1
  })

  const actionLabels = createMemo(() => ["Back", isLastFile() ? "Finish" : "Next"])

  const bandLabel = createMemo(() => {
    const path = file()?.path ?? ""
    const asking = busy() && (pendingAskPath() === null || pendingAskPath() === path)
    if (asking) return `You asked: ${truncateEnd(lastQuestion(), 50)}  \u00b7  ${activeLabel()}`
    if (walkReading() === path) {
      const reason = walkReasons().get(path)
      return `Walk${reason ? ` \u00b7 ${truncateEnd(reason, 60)}` : " \u00b7 reading\u2026"}`
    }
    if (answerOpen() && answerFile() === path) {
      if (lastQuestion() !== "") {
        return `You asked: ${truncateEnd(lastQuestion(), 50)}  \u00b7  ${activeLabel()}`
      }
      if (walkActive()) {
        const reason = walkReasons().get(path)
        if (reason !== undefined && reason !== "") return `Walk \u00b7 ${truncateEnd(reason, 60)}`
        return `Walk \u00b7 ${truncateEnd(walkIntent() || "agent notes", 60)}`
      }
      return `Answer  \u00b7  ${activeLabel()}`
    }
    return walkActive()
      ? "Ask about this file — the agent has the author's context."
      : "Ask about this file."
  })

  const bandBusy = createMemo(() => {
    const path = file()?.path ?? ""
    return (busy() && (pendingAskPath() === null || pendingAskPath() === path)) || walkReading() === path
  })

  const bandBody = createMemo(() => {
    const path = file()?.path ?? ""
    if (busy() && (pendingAskPath() === null || pendingAskPath() === path)) return status()
    if (walkReading() === path) return "Reading the diff and the agent's notes\u2026"
    return lastAnswer()
  })

  // Panels float over the review; they never replace it.

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

  /** Report a failure where the user is, not on the transcript screen. */
  function showError(text: string): void {
    addEntry("error", text)
    setAlert({ kind: "error", text })
    setStatus("")
  }

  /** Report a passing note where the user is. */
  function showNotice(text: string): void {
    addEntry("system", text)
    setAlert({ kind: "notice", text })
    setStatus("")
  }

  // Notes are transient: a theme switch or a cleared highlight should not leave
  // a panel in front of the review. Errors stay until the user dismisses them.
  createEffect(() => {
    const current = alert()
    if (current?.kind !== "notice") return
    const timer = setTimeout(() => {
      if (alert() === current) setAlert(null)
    }, 4000)
    onCleanup(() => clearTimeout(timer))
  })

  function dismissAlert(): void {
    setAlert(null)
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
    const wasWalking = walk !== null
    if (wasWalking) stopWalk()
    setFiles(null)
    setLoadError(null)
    setPatch("")
    patchCache.clear()
    patchFor = ""
    setSelected(0)
    reviewState = loadReviewState(cwd())
    setQueue([])
    setFileMemory(new Map())
    setAction(1)
    setMenuOpen(false)
    setAnswerOpen(false)
    setAnswerFile("")
    setAnswerIsError(false)
    try {
      setHighlights(loadHighlights(cwd()))
      const changed = listChangedFiles(cwd(), reviewSource())
      setFiles(changed)
      patchHashes = new Map(
        changed.map((f) => [f.path, patchHash(tryOr(() => loadPatch(cwd(), f, reviewSource()), ""))]),
      )
      // A changed patch silently stops being approved; report how many.
      const dropped = pruneApprovals(reviewState, patchHashes)
      if (dropped > 0) {
        bestEffort("save pruned approvals", () => saveReviewState(cwd(), reviewState))
        setStatus(`${dropped} approved files changed and need a fresh Space`)
      }
      setApprovalsVersion((v) => v + 1)
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
    if (wasWalking) showNotice("The review changed, so the walk ended. Run /walk again to keep going.")
  }

  function selectFile(index: number): void {
    const list = files()
    if (!list || list.length === 0) return
    const i = Math.max(0, Math.min(index, list.length - 1))
    setSelected(i)
    bestEffort("scroll fileScrollRef", () => fileScrollRef?.scrollTo({ x: 0, y: Math.max(0, i - 6) }))
    const current = list[i]
    if (patchFor === current.path) {
      setAction(1)
      restoreWalkResponse(current.path)
      return
    }
    const cached = patchCache.get(current.path)
    if (cached !== undefined) {
      setPatch(cached)
      patchFor = current.path
      setAction(1)
      bestEffort("scroll diffScrollRef", () => diffScrollRef?.scrollTo({ x: 0, y: 0 }))
      restoreWalkResponse(current.path)
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
    setAction(1)
    bestEffort("scroll diffScrollRef", () => diffScrollRef?.scrollTo({ x: 0, y: 0 }))
    restoreWalkResponse(current.path)
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
      showError(`tree failed: ${error instanceof Error ? error.message : String(error)}`)
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
    setAction(1)
    if (answerFile() !== path) setAnswerOpen(false)
  }

  function nextFile(): void {
    const cur = file()?.path
    if (cur && !isFileApproved(cur)) {
      // Passing an approved file does not turn a decision into a skip.
      const mem = new Map(fileMemory())
      if (!mem.has(cur)) mem.set(cur, "passed")
      setFileMemory(mem)
    }
    const q = queue()
    const i = q.indexOf(cur ?? "")
    if (i === -1 || i === q.length - 1) {
      finishReview()
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

  function approvalHash(path: string): string {
    return patchHashes.get(path) ?? ""
  }

  function isFileApproved(path: string): boolean {
    return isApproved(reviewState, path, approvalHash(path))
  }

  function persistReviewState(): void {
    try {
      saveReviewState(cwd(), reviewState)
    } catch (error) {
      showError(`could not save review state: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Space: approve or un-approve, then move to the next unapproved file. */
  function toggleApproval(): void {
    const f = file()
    if (f === undefined) return
    const hash = approvalHash(f.path)
    const wasApproved = isApproved(reviewState, f.path, hash)
    if (wasApproved) clearApproval(reviewState, f.path)
    else {
      setApproval(reviewState, f.path, hash)
      // A decision replaces an earlier "passed without asking".
      const mem = new Map(fileMemory())
      mem.delete(f.path)
      setFileMemory(mem)
    }
    persistReviewState()
    setApprovalsVersion((v) => v + 1)
    setStatus(wasApproved ? `un-approved ${f.path}` : `approved ${f.path}`)
    if (!wasApproved) nextUnapproved()
  }

  /** The next file without a matching approval, or the end of the review. */
  function nextUnapproved(): void {
    const list = files() ?? []
    for (let step = 1; step <= list.length; step++) {
      const index = (selected() + step) % list.length
      if (!isFileApproved(list[index].path)) {
        selectFile(index)
        return
      }
    }
    finishReview()
  }

  function finishReview(): void {
    const path = tryOr(() => writeHandback(cwd(), highlights(), walk?.sessionId() ?? undefined), null)
    // A plan or theme notice belongs to the review, not the done screen.
    if (alert()?.kind === "notice") setAlert(null)
    setDoneIndex(0)
    setView("done")
    if (path !== null) setStatus(`notes written to ${path}`)
  }

  /** Leave the done screen without ending the walk or losing its notes. */
  function backToReview(): void {
    if (!hasProject()) return
    setView("review")
    const path = file()?.path
    if (path !== undefined) goToFile(path)
    else selectFile(0)
  }

  function approvedCount(): number {
    approvalsVersion()
    let n = 0
    for (const f of files() ?? []) if (isFileApproved(f.path)) n++
    return n
  }

  /**
   * The first harness that can be used now, and why none could when the
   * answer is null. opencode counts as usable only with its server running.
   */
  async function chooseHarness(): Promise<{ harness: HarnessAdapter | null; reason: string }> {
    const opencode = createOpencodeHarness()
    const found = await opencode.detect()
    if (found.available) return { harness: opencode, reason: "" }
    const claude = createClaudeHarness()
    const claudeFound = await claude.detect()
    if (claudeFound.available) return { harness: claude, reason: "" }
    return {
      harness: null,
      reason: `${found.reason ?? "No harness found."} Claude Code was not found either.`,
    }
  }

  /** Forget everything the current walk produced; the session itself is closed separately. */
  function resetWalkOutput(): void {
    walkReports = new Map()
    walkAnswers = new Map()
    setWalkActive(false)
    setWalkSession(null)
    setWalkReading(null)
    setWalkReasons(new Map())
    setWalkIntent("")
    setPendingAskPath(null)
    setAnswerOpen(false)
    setAnswerFile("")
    setLastQuestion("")
    setLastAnswer("")
    setAnswerIsError(false)
  }

  function stopWalk(): void {
    // Invalidate first: closing aborts a pending call, and its callback must not
    // put an error or an answer on the next walk's screen.
    walkToken += 1
    walk?.close()
    walk = null
    resetWalkOutput()
    setBusy(false)
    setStatus("")
  }

  function showWalkReport(path: string): boolean {
    const report = walkReports.get(path)
    if (report === undefined) return false
    setLastQuestion("")
    setLastAnswer(analysisText(report))
    setAnswerFile(path)
    setAnswerIsError(false)
    setAnswerOpen(true)
    setWalkIntent(report.analysis.intent)
    return true
  }

  function showWalkAnswer(path: string): boolean {
    const answer = walkAnswers.get(path)
    if (answer === undefined) return false
    setLastQuestion(answer.question)
    setLastAnswer(answer.text)
    setAnswerFile(path)
    setAnswerIsError(answer.isError)
    setAnswerOpen(true)
    return true
  }

  /** Restore this file's last words, or ask the agent for them now. */
  function restoreWalkResponse(path: string): void {
    if (walk === null) return
    if (showWalkAnswer(path) || showWalkReport(path)) return
    if (walkReading() === path) return
    setWalkReading(path)
    setLastQuestion("")
    setLastAnswer("")
    setAnswerIsError(false)
    void walk.analyze(path).finally(() => {
      if (walkReading() === path) setWalkReading(null)
    })
  }

  function walkOnPlan(plan: PlanResponse): void {
    setWalkIntent(plan.overview)
    setWalkReasons(new Map(plan.order.map((entry) => [entry.path, entry.reason])))
    // The plan becomes the review order: the file list, the arrows and the
    // Back/Next actions all agree, so the next file is never a surprise.
    const byPath = new Map((files() ?? []).map((f) => [f.path, f]))
    const ordered = plan.order.flatMap((entry) => {
      const file = byPath.get(entry.path)
      return file === undefined ? [] : [file]
    })
    const seen = new Set(ordered.map((f) => f.path))
    for (const file of files() ?? []) if (!seen.has(file.path)) ordered.push(file)
    if (ordered.length > 0) setFiles(ordered)
    setQueue(ordered.map((f) => f.path))
    showNotice(`Walk: ${plan.overview}`)
    setView("review")
    const first = ordered[0]?.path
    if (first !== undefined) goToFile(first)
  }

  function walkOnFile(result: WalkFileResult): void {
    const path = result.analysis.path
    walkReports.set(path, result)
    walkAnswers.delete(path)
    // Re-analysis of one file replaces its earlier agent highlights.
    const kept = highlights().filter((h) => !(h.by === "ai" && h.path === path))
    persistHighlights([...kept, ...result.highlights])
    addEntry("agent", analysisText(result))
    if (file()?.path === path) showWalkReport(path)
    const order = queue()
    const next = order.slice(order.indexOf(path) + 1).find((p) => !isFileApproved(p))
    if (next !== undefined) walk?.prefetch(next)
  }

  function walkOnAnswer(
    answer: AskResponse,
    anchors: Highlight[],
    question: string,
    path: string | undefined,
  ): void {
    if (anchors.length > 0) persistHighlights([...highlights(), ...anchors])
    addEntry("agent", answer.text)
    if (path !== undefined) {
      walkAnswers.set(path, { question, text: answer.text, isError: false })
      if (file()?.path === path) showWalkAnswer(path)
      return
    }
    setLastQuestion(question)
    setLastAnswer(answer.text)
    setAnswerFile("")
    setAnswerIsError(false)
    setAnswerOpen(true)
  }

  /** An explicit session id, `fresh` for none, else the project's newest. */
  function walkBaseSession(harness: HarnessAdapter, arg: string): string | undefined {
    if (arg === "fresh") return undefined
    if (arg !== "") return arg
    return harness.listSessions(cwd())[0]?.id
  }

  function walkKeyFor(): string {
    const src = reviewSource()
    const detail =
      src.kind === "commit" ? src.sha : src.kind === "branch" ? `${src.base}...${src.mergeBase}` : ""
    return sourceKey(src.kind, detail)
  }

  function beginWalk(harness: HarnessAdapter, list: ReviewFile[], baseSessionId: string | undefined): Walk {
    const token = ++walkToken
    const stale = () => token !== walkToken
    return createWalk({
      harness,
      projectRoot: cwd(),
      files: list,
      source: reviewSource(),
      sourceLabel: sourceLabel(),
      walkKey: walkKeyFor(),
      baseSessionId,
      state: reviewState,
      persist: persistReviewState,
      callbacks: {
        status: (text) => {
          if (!stale()) setStatus(text)
        },
        error: (message) => {
          if (!stale()) showError(message)
        },
        plan: (plan) => {
          if (!stale()) walkOnPlan(plan)
        },
        file: (result) => {
          if (!stale()) walkOnFile(result)
        },
        ask: (answer, anchors, question, path) => {
          if (!stale()) walkOnAnswer(answer, anchors, question, path)
        },
      },
    })
  }

  /**
   * /walk: fork a harness session and let it narrate each changed file. With
   * no argument the newest session for this project is used, `fresh` starts
   * without author context, and anything else is a session id.
   */
  async function startWalk(arg: string): Promise<void> {
    const list = files() ?? []
    if (list.length === 0) {
      showError("Nothing to walk through: no changed files in this review.")
      return
    }
    const choice = await chooseHarness()
    if (choice.harness === null) {
      showError(`${choice.reason} Then run /walk again.`)
      return
    }
    const harness = choice.harness
    const baseSessionId = walkBaseSession(harness, arg)
    stopWalk()
    addEntry(
      "system",
      baseSessionId === undefined
        ? `No author session to fork; starting a fresh ${harness.label} session.`
        : `Forking ${harness.label} session ${baseSessionId}.`,
    )
    setView("review")
    walk = beginWalk(harness, list, baseSessionId)
    setWalkActive(true)
    await walk.start()
    const session = walk.sessionId()
    if (session === null) {
      // The fork failed: leave the review usable without a walk.
      stopWalk()
      return
    }
    setWalkSession(session)
  }

  /** A question for the forked session, shown in the same answer pane. */
  async function askWalkAgent(prompt: string): Promise<void> {
    if (walk === null) return
    const path = file()?.path
    addEntry("user", prompt)
    setLastQuestion(prompt)
    setLastAnswer("")
    setAnswerIsError(false)
    setPendingAskPath(path ?? null)
    setBusy(true)
    const startedAt = Date.now()
    const tick = () => setStatus(`Thinking… ${Math.floor((Date.now() - startedAt) / 1000)}s`)
    tick()
    const interval = setInterval(tick, 1000)
    try {
      const answer = await walk.ask(prompt, path)
      if (answer === null) {
        if (path === undefined || !showWalkReport(path)) {
          setLastQuestion("")
          setAnswerOpen(false)
        }
      }
    } finally {
      clearInterval(interval)
      setBusy(false)
      setPendingAskPath(null)
      setStatus("")
    }
  }

  function askCurrent(prompt: string): void {
    if (walk !== null) void askWalkAgent(prompt)
    else void askAgent(prompt)
  }

  function stepHeader(): string {
    const q = queue()
    const cur = file()?.path ?? ""
    const i = Math.max(0, q.indexOf(cur))
    const total = q.length === 0 ? (files()?.length ?? 0) : q.length
    const pos = total === 0 ? 0 : i + 1
    return `${pos} of ${total} files · ${approvedTotal()} approved`
  }

  if (bootstrapRoot !== undefined) {
    const saved = loadSavedReviewSource(bootstrapRoot)
    if (saved) setReviewSource(saved)
    load()
  }

  // Menu options
  const menuOptions = createMemo<SelectOption[]>(() => [
    { name: "Walk through with agent", description: "fork the author's session", value: 0 },
    { name: "Browse files", description: "every file in the project", value: 1 },
    { name: "Chat history", description: "past questions and answers", value: 2 },
    { name: "Recent projects", description: "switch to another project", value: 3 },
    { name: "Refresh changes", description: "re-scan the working tree", value: 4 },
    { name: "Change review source", description: "staged, branch, or a commit", value: 5 },
    { name: "Review summary", description: "approved, asked, highlighted", value: 6 },
    { name: "Next unapproved file", description: "jump to the next one", value: 7 },
    { name: "Help", description: "keys and commands", value: 8 },
    { name: "Quit", description: "exit chert", value: 9 },
  ])

  function listProjects(): void {
    if (loadRecent().length === 0) {
      showNotice("No saved projects yet. Type /cd and a folder path.")
      return
    }
    // With no project open the home screen already lists them; selecting is the
    // same keys. With a project open, the list drops up over the review.
    setProjectsIndex(0)
    if (!hasProject()) {
      setStatus("Pick a project below, or /cd <path>")
      return
    }
    setProjectsOpen(true)
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
    setAlert(null)
    if (raw.startsWith("/")) {
      runCommand(raw.slice(1).trim())
      return
    }
    if (busy()) {
      setStatus("Still thinking about your last question.")
      return
    }
    // The answer band lives on the review screen; a follow-up asked from the
    // done screen goes back there so the answer is visible.
    if (view() === "done") setView("review")
    const cur = file()?.path
    if (cur) markAsked(cur)
    setAction(1)
    askCurrent(raw)
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
        showNotice(`over ${MAX_SAVED_HIGHLIGHTS} highlights: yours are all kept, new AI ones will not be`)
      }
      return true
    } catch (error) {
      showError(`could not save highlights: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
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
    // Request timeouts are the backstop for a stalled provider or agent.
    try {
      const turn = await runAgentTurn({
        prompt,
        connectorId: connector(),
        model: model(),
        projectRoot: cwd(),
        changedFiles: (files() ?? []).map((f) => f.path),
        onPrefixChange: (prefix) => {
          statusPrefix = prefix
          tick()
        },
      })
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
        setAction(1)
        setStatus("")
      } else if (v === "tree") {
        setStatus("answer ready, press a in review")
      } else {
        setStatus("")
      }
    }
  }

  /** Open a project, remember it and load its review. */
  function openProjectAt(path: string): string | undefined {
    const root = openProject(path)
    if (root === undefined) return undefined
    const savedRoot = hasProject() ? cwd() : null
    if (savedRoot !== null && savedRoot !== root) previousProject = savedRoot
    // A walk belongs to one project; leaving it ends the conversation.
    walk?.close()
    walk = null
    setWalkSession(null)
    setWalkIntent("")
    setProjectsOpen(false)
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
      showError,
      showNotice,
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
      startWalk: (arg) => {
        void startWalk(arg)
      },
    }
  }

  function runCommand(line: string): void {
    setAlert(null)
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
          showError(`unknown command /${name} — did you mean /${close.name}?`)
          return
        } else {
          showError(`unknown command /${name} — try /help`)
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
    showError(`unknown command /${name} — try /help`)
  }

  /** The surface the keyboard handler may use. */
  function keyboardContext(): KeyboardContext {
    return {
      hasInputText: () => (inputRef?.value ?? "") !== "",
      hasSuggestions: () =>
        pickerOpen() ||
        (commandQuery() !== null && filteredCommands().length > 0) ||
        (themeInput() !== null && themeSuggestions().length > 0),
      actionCount: () => actionLabels().length,

      reviewPickerOpen,
      setReviewPickerOpen,
      reviewPickerIndex,
      setReviewPickerIndex,
      allReviewTargets,

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

      scrollAnswer,

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
      view,
      setStatus,
      backToReview,
      alertOpen: () => alert() !== null,
      dismissAlert,
      hasProject,
      openRecent,
      loadRecent,

      action,
      setAction,
      activateAction,
      navigate,
      codeRows,
      file,
      files: () => files() ?? [],
      selectFile,
      patch,
      approved: () => {
        const f = file()
        return f !== undefined && isFileApproved(f.path)
      },
      toggleApproval,

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
      case 0: // Walk through with agent
        setMenuOpen(false)
        void startWalk("")
        return
      case 1: // Browse files
        setMenuOpen(false)
        if (hasProject()) loadTree()
        else setView("tree")
        return
      case 2: // Chat history
        setMenuOpen(false)
        setView("log")
        return
      case 3: // Recent projects
        setMenuOpen(false)
        setProjectsOpen(true)
        setProjectsIndex(0)
        return
      case 4: // Refresh changes
        setMenuOpen(false)
        if (hasProject()) {
          load()
          setStatus(`refreshed ${files()?.length ?? 0} files`)
        }
        return
      case 5: // Change review source
        setMenuOpen(false)
        setReviewPickerOpen(true)
        setReviewPickerIndex(0)
        return
      case 6: // Review summary
        setMenuOpen(false)
        {
          const asked = (files() ?? []).filter((f) => fileMemory().get(f.path) === "asked").length
          const hlYours = highlights().filter((h) => h.by === "you").length
          const hlAi = highlights().filter((h) => h.by === "ai").length
          showNotice(
            `Approved ${approvedTotal()} of ${files()?.length ?? 0} files. Asked about ${asked}. Highlights: ${hlYours} yours, ${hlAi} from the AI.`,
          )
        }
        return
      case 7: // Next unapproved file
        setMenuOpen(false)
        {
          const next = (files() ?? []).find((f) => !isFileApproved(f.path))
          if (next) {
            selectFile((files() ?? []).indexOf(next))
          }
        }
        return
      case 8: // Help
        addEntry("system", HELP_TEXT)
        setView("log")
        setMenuOpen(false)
        return
      case 9: // Quit
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
      showError(`can't open ${displayPath(item.path)}`)
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
    const passed = (files() ?? []).filter((f) => fileMemory().get(f.path) === "passed").map((f) => f.path)
    // options: 4 back to files, 0 pass-overs, 1 refresh, 2 pick another, 3 quit
    if (i === 4) {
      backToReview()
      return
    }
    if (i === 0) {
      if (passed.length === 0) return
      setView("review")
      goToFile(passed[0])
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
    const passedCount = (files() ?? []).filter((f) => fileMemory().get(f.path) === "passed").length
    const opts: SelectOption[] = [{ name: "Back to the files", description: "", value: 4 }]
    if (passedCount > 0)
      opts.push({ name: `Go back over the ${passedCount} passed files`, description: "", value: 0 })
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
      nextFile()
      return
    }
  }

  /** Approval state as the footer needs it, with the version read kept reactive. */
  function currentApproved(): boolean {
    approvalsVersion()
    const f = file()
    return f !== undefined && isFileApproved(f.path)
  }

  function footerHints(): string {
    const hasText = inputValue() !== ""
    const verb = currentApproved() ? "unapprove" : "approve"
    if (suggestionWindow().show) {
      return pickerOpen()
        ? "↑↓ choose · Enter run · Esc close · Ctrl+C quit"
        : "↑↓ choose · Enter run · Esc clear · Ctrl+C quit"
    }
    if (hasText) return "Enter send · Esc clear · Ctrl+C quit"
    if (alert() !== null) {
      return view() === "review" && hasProject()
        ? `Space ${verb} · Esc dismiss · Ctrl+C quit`
        : "Esc dismiss · Ctrl+C quit"
    }
    if (menuOpen()) return "↑↓ choose · Enter go · Esc close · Ctrl+C quit"
    if (reviewPickerOpen()) return "↑↓ choose · Enter review · Esc close · Ctrl+C quit"
    if (projectsOpen()) return "↑↓ choose · Enter open · Esc close · Ctrl+C quit"
    if (view() === "tree") return "↑↓ move · Enter open · Esc menu · Ctrl+C quit"
    if (view() === "log") return "Esc menu · Ctrl+C quit"
    if (view() === "done") return "↑↓ choose · Enter go · Esc files · Ctrl+C quit"
    if (!hasProject()) return "↑↓ choose · Enter open · /cd <path> · Esc menu · Ctrl+C quit"
    if (file() === undefined) return "Esc menu · Ctrl+C quit"
    const scroll = answerShowing() ? " · PgUp/PgDn answer" : ""
    return `↑↓ file · Space ${verb}${scroll} · Esc menu · Ctrl+C quit`
  }

  const showActionBar = createMemo(
    () =>
      hasProject() &&
      view() === "review" &&
      !menuOpen() &&
      !projectsOpen() &&
      !reviewPickerOpen(),
  )

  /** Width the hints may use before the status and the action buttons. */
  const footerHintsBudget = createMemo(() => {
    const actions = showActionBar() ? actionLabels().reduce((n, label) => n + label.length + 2, 0) : 0
    const statusWidth = !busy() && status() !== "" ? Math.min(status().length + 3, 41) : 0
    return Math.max(16, dims().width - 2 - actions - statusWidth)
  })

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

  const codeRows = createMemo<Row[]>(() => parsePatch(patch()))

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

  /** Put text on the clipboard; false when the terminal refused it. */
  function copyToClipboard(text: string): boolean {
    const osc52 = `\u001b]52;c;${Buffer.from(text).toString("base64")}\u0007`
    try {
      if (renderer.copyToClipboardOSC52(text)) return true
    } catch {
      // fall through to the raw sequence
    }
    // A real terminal takes the sequence even when capability detection is
    // unsure; a piped stdout (tests) never does.
    if (!process.stdout.isTTY) return false
    try {
      process.stdout.write(osc52)
      return true
    } catch {
      return false
    }
  }

  /** Copy a highlight in the form an agent can read back: path, lines, text. */
  function copyHighlight(h: Highlight): void {
    const where = h.start === h.end ? `line ${h.start}` : `lines ${h.start}-${h.end}`
    const text = [`${h.path} ${where}`, ...h.text.map((line) => `  ${line}`)].join("\n")
    setStatus(
      copyToClipboard(text)
        ? "Copied to your clipboard — paste it for your agent"
        : "Could not copy — highlight saved",
    )
  }

  /** PageUp/PageDown in the agent band. */
  function scrollAnswer(direction: -1 | 1): void {
    const box = answerScrollRef
    if (!box) return
    const page = Math.max(1, box.height - 2)
    bestEffort("scroll the answer", () =>
      box.scrollTo({ x: 0, y: Math.max(0, box.scrollTop + direction * page) }),
    )
  }

  // The highlight tool is the mouse: a drag over the diff copies the rows under
  // the pointer, so the user can paste them into the prompt for the agent.
  // Arrow keys stay on the file list.
  useSelectionHandler((selection) => {
    if (view() !== "review" || !hasProject() || menuOpen() || projectsOpen()) return
    const box = codeScrollRef
    if (!box) return
    const rows = codeRows()
    const range = rowsUnderDrag({
      box: { x: box.screenX, y: box.screenY, width: box.width, height: box.height },
      scrollTop: box.scrollTop,
      rowCount: rows.length,
      anchor: selection.anchor,
      focus: selection.focus,
    })
    if (!range) return
    const built = highlightFromRows(rows, range.start, range.end, file()?.path ?? "")
    if (!built.ok) {
      setStatus(built.reason)
      return
    }
    // Dragging the same lines again copies them again without piling up
    // duplicate highlights.
    const saved = highlights().find(
      (h) =>
        h.path === built.highlight.path &&
        h.side === built.highlight.side &&
        h.start === built.highlight.start &&
        h.end === built.highlight.end,
    )
    if (saved === undefined) persistHighlights([...highlights(), built.highlight])
    copyHighlight(saved ?? built.highlight)
    // The click took the focus off the prompt; bring it back for the paste.
    bestEffort("focus the prompt", () => inputRef?.focus())
  })

  // Dragging the band's top edge changes how much of the answer is visible.
  let bandDrag: { startY: number; startHeight: number } | null = null

  function beginBandResize(event: { y: number }): void {
    bandDrag = { startY: event.y, startHeight: agentHeight() }
  }

  function resizeBand(event: { y: number }): void {
    if (bandDrag === null) return
    const requested = bandDrag.startHeight + (bandDrag.startY - event.y)
    const max = Math.max(3, Math.floor(dims().height * 0.6))
    setAgentHeight(Math.max(3, Math.min(requested, max)))
  }

  const approvedTotal = createMemo(approvedCount)

  const reviewTally = createMemo(() => {
    const list = files() ?? []
    return {
      total: list.length,
      approved: approvedTotal(),
      asked: list.filter((f) => fileMemory().get(f.path) === "asked").length,
      passed: list.filter((f) => fileMemory().get(f.path) === "passed").length,
    }
  })

  const overlayRows = createMemo(() => Math.max(3, Math.min(10, dims().height - 14)))

  /** Three lines at most; the transcript keeps the full message. */
  const alertText = createMemo(() =>
    truncateMiddle(
      (alert()?.text ?? "").replace(/\s*\n\s*/g, " · "),
      Math.max(40, (dims().width - 6) * 3),
    ),
  )

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
          {hasProject() && (view() === "review" || view() === "done")
            ? `${sourceLabel()}${walkActive() ? " · walk" : ""}`
            : " "}
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
      <Show
        when={view() === "done"}
        fallback={
          <Show
            when={view() === "log"}
            fallback={
              <Show
                when={view() === "tree"}
                fallback={
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
                            <text fg={COLORS().purple} attributes={ATTR.bold}>
                              {"\u25B8 Files"}
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
                                const done = () => {
                                  approvalsVersion()
                                  return isFileApproved(f.path)
                                }
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
                            <text fg={COLORS().text} attributes={ATTR.bold}>
                              {file()?.path ?? ""}
                            </text>
                            <box flexGrow={1} />
                            <text fg={COLORS().dim} attributes={ATTR.dim}>
                              {`${file() ? (file()!.status === "added" || file()!.status === "untracked" ? "new" : file()!.status === "deleted" ? "deleted" : "changed") : ""}  ${file() ? `+${file()!.additions} -${file()!.deletions}` : ""}`}
                            </text>
                          </box>
                          <box height={1} flexShrink={0} border={["bottom"]} borderColor={COLORS().rule} />
                          <Show when={(files()?.length ?? 0) === 0}>
                            <box flexShrink={0} flexDirection="column" paddingTop={1} paddingLeft={1}>
                              <text
                                wrapMode="word"
                                fg={loadError() !== null ? COLORS().danger : COLORS().dim}
                              >
                                {loadError() ?? "Nothing to review — the working tree is clean."}
                              </text>
                              <text fg={COLORS().dim} attributes={ATTR.dim}>
                                {"Change a file, or /review branch to review a branch."}
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
                                const gutter = row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "
                                const num = row.kind === "del" ? (row.oldNo ?? "") : (row.newNo ?? "")
                                const h = () => highlightForRowIndex(i())
                                return (
                                  <box
                                    flexDirection="row"
                                    backgroundColor={
                                      row.kind === "add"
                                        ? "#1a2420"
                                        : row.kind === "del"
                                          ? "#2a1a1f"
                                          : COLORS().bg
                                    }
                                  >
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
          <text fg={COLORS().dim}>
            {` ${reviewTally().approved} of ${reviewTally().total} approved · ${reviewTally().asked} asked about · ${reviewTally().passed} passed`}
          </text>
          <Show when={walkSession() !== null}>
            <text fg={COLORS().dim}>
              {`Review session ${walkSession()}. Your notes are yours; chert never writes into the original session.`}
            </text>
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

      {/* The agent's band: its top edge is a drag handle that sets the height.
          With no answer it collapses to the label, leaving the diff the room. */}
      <Show when={hasProject() && view() === "review"}>
        <box height={answerShowing() ? agentHeight() : 2} flexShrink={0} flexDirection="column" paddingLeft={1}>
          {/* A drawn rule rather than a border: borders are not hit-tested, and
              this row has to receive the press that starts a resize. */}
          <box
            height={1}
            flexShrink={0}
            ref={(el: BoxRenderable) => {
              el.onMouseDown = (event) => beginBandResize(event)
              el.onMouseDrag = (event) => resizeBand(event)
              el.onMouseUp = () => {
                bandDrag = null
              }
            }}
          >
            <text
              fg={COLORS().rule}
              wrapMode="none"
              ref={(el: TextRenderable) => {
                // A selectable row would start a text selection instead of
                // handing the drag to the band.
                el.selectable = false
              }}
            >
              {"─".repeat(Math.max(0, dims().width - 2))}
            </text>
          </box>
          <text height={1} flexShrink={0} fg={COLORS().dim}>
            {bandLabel()}
          </text>
          <Show when={answerShowing()}>
            <scrollbox
              ref={(el: ScrollBoxRenderable) => (answerScrollRef = el)}
              flexGrow={1}
              backgroundColor={COLORS().bg}
            >
              <text
                wrapMode="word"
                fg={bandBusy() ? COLORS().dim : answerIsError() ? COLORS().danger : COLORS().text}
              >
                {bandBody()}
              </text>
            </scrollbox>
          </Show>
        </box>
      </Show>
      {/* Failures and notes sit in the flow above the prompt, so they never
          cover what you are typing. */}
      <Show when={alert() !== null}>
        <box
          flexShrink={0}
          marginLeft={1}
          marginRight={1}
          flexDirection="row"
          backgroundColor={COLORS().panel}
          paddingLeft={1}
          paddingRight={1}
        >
          <text
            fg={alert()!.kind === "error" ? COLORS().danger : COLORS().purpleBright}
            attributes={ATTR.bold}
          >
            {alert()!.kind === "error" ? "✗ " : "· "}
          </text>
          <text
            wrapMode="word"
            flexGrow={1}
            fg={alert()!.kind === "error" ? COLORS().danger : COLORS().text}
          >
            {alertText()}
          </text>
        </box>
      </Show>
      {/* A rule above the prompt separates the agent's words from yours. */}
      <box height={1} flexShrink={0} border={["bottom"]} borderColor={COLORS().rule} />
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
            !hasProject()
              ? "open a project with /cd <path>, or press Esc"
              : view() === "done"
                ? "ask a follow-up about this review, or choose what next"
                : "ask a question, or type / for commands"
          }
          placeholderColor={COLORS().dim}
          onInput={(value: string) => setInputValue(value)}
        />
      </box>
      <box height={1} flexShrink={0} border={["bottom"]} borderColor={COLORS().rule} />
      {/* One line of hints, with the action buttons on its right. */}
      <box height={1} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1}>
        <text fg={COLORS().dim} attributes={ATTR.dim}>
          {truncateEnd(footerHints(), footerHintsBudget())}
        </text>
        <box flexGrow={1} />
        <Show when={!busy() && status() !== ""}>
          <text fg={COLORS().purpleBright} attributes={ATTR.dim}>
            {`· ${truncateEnd(status(), 40)} `}
          </text>
        </Show>
        <Show when={showActionBar()}>
          <For each={actionLabels()}>
            {(label, i) => (
              <text
                fg={i() === action() ? COLORS().bg : COLORS().dim}
                bg={i() === action() ? COLORS().purple : undefined}
                attributes={i() === action() ? ATTR.bold : ATTR.none}
              >{` ${label} `}</text>
            )}
          </For>
        </Show>
      </box>

      <Overlays
        menuOpen={menuOpen}
        menuIndex={menuIndex}
        menuOptions={menuOptions}
        reviewPickerOpen={reviewPickerOpen}
        reviewPickerIndex={reviewPickerIndex}
        allReviewTargets={allReviewTargets}
        projectsOpen={projectsOpen}
        projectsIndex={projectsIndex}
        hasProject={hasProject}
        loadRecent={loadRecent}
        maxRows={overlayRows()}
      />

      <Show when={suggestionWindow().show}>
        <SuggestionBox
          items={suggestionWindow().items}
          offset={suggestionWindow().offset}
          index={suggestionIndex()}
          pickerOpen={pickerOpen()}
          themePreview={themeInput() !== null}
        />
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
