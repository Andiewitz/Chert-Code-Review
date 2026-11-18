// The walk controller: everything between the TUI and a harness session.
// It owns the fitness decisions — plan order, one repair retry, anchor
// verification, the response cache, serialized calls and the tree guard — so
// the TUI only renders what comes back and records what the human decides.

import type { Row } from "../diffrows"
import { parsePatch } from "../diffrows"
import type { ReviewFile, ReviewSource } from "../git"
import { loadPatch } from "../git"
import type { Highlight } from "../highlights"
import type { HarnessAdapter, ReviewSession } from "../harness/types"
import { MAX_NOTE_CHARS } from "../limits"
import { highlightFromAnchor, verifyAnchor } from "./anchors"
import { compareTrees, snapshotTree } from "./guard"
import type { GuardReport } from "./guard"
import { askRequest, fileRequest, planRequest, repairRequest } from "./prompts"
import { jsonSchemaFor, parseModelJson, validateAsk, validateFile, validatePlan } from "./protocol"
import type { Anchor, AskResponse, FileAnalysis, PlanResponse, Validated } from "./protocol"
import { getCachedAnalysis, patchHash, putCachedAnalysis, saveWalk } from "./state"
import type { ReviewState, WalkMode } from "./state"

export interface WalkFileResult {
  analysis: FileAnalysis
  highlights: Highlight[]
  /** Notes whose anchor did not match the diff, so they were not shown. */
  dropped: number
}

export interface WalkCallbacks {
  /** A one-line progress note, or "" to clear it. */
  status(text: string): void
  plan(plan: PlanResponse): void
  file(result: WalkFileResult): void
  ask(answer: AskResponse, highlights: Highlight[]): void
  /** A failure the human must see; the walk stays usable. */
  error(message: string): void
}

export interface WalkOptions {
  harness: HarnessAdapter
  projectRoot: string
  files: ReviewFile[]
  source: ReviewSource
  sourceLabel: string
  /** Key the plan and position are stored under (see sourceKey). */
  walkKey: string
  baseSessionId?: string
  /** Shared with the TUI, which also writes approvals into it. */
  state: ReviewState
  persist: () => void
  callbacks: WalkCallbacks
}

export interface Walk {
  sessionId(): string | null
  mode(): WalkMode | null
  /** Fork once, ask for the reading order, report it. */
  start(): Promise<void>
  /** Fetch (or reuse) one file's analysis, with verified highlights. */
  analyze(path: string): Promise<WalkFileResult | null>
  ask(question: string, path?: string, selection?: string): Promise<AskResponse | null>
  /** Warm the next file while the human reads. Never blocks an ask. */
  prefetch(path: string): void
  close(): void
}

/** One note, before its anchor has been checked against the diff. */
interface NoteEntry {
  anchor: Anchor
  level: Highlight["level"]
  note: string
}

function notesOf(analysis: FileAnalysis): NoteEntry[] {
  return [
    ...analysis.walkthrough.map((item) => ({ anchor: item.anchor, level: "note" as const, note: item.explanation })),
    ...analysis.concerns.map((concern) => ({ anchor: concern.anchor, level: concern.level, note: concern.note })),
  ]
}

/** Place every note on a verified row; count the ones that had nowhere to go. */
export function buildHighlights(
  rows: Row[],
  path: string,
  analysis: FileAnalysis,
): { highlights: Highlight[]; dropped: number } {
  const highlights: Highlight[] = []
  let dropped = 0
  for (const entry of notesOf(analysis)) {
    const verified = verifyAnchor(rows, entry.anchor)
    if (verified === null) {
      dropped += 1
      continue
    }
    highlights.push(highlightFromAnchor(rows, path, entry.anchor, verified, entry.level, entry.note))
  }
  return { highlights, dropped }
}

/** Highlights for loose anchors, such as the lines an answer refers to. */
function highlightsForAnchors(rows: Row[], path: string, anchors: Anchor[], note: string): Highlight[] {
  const clipped = note.length > MAX_NOTE_CHARS ? note.slice(0, MAX_NOTE_CHARS) : note
  const highlights: Highlight[] = []
  for (const anchor of anchors) {
    const verified = verifyAnchor(rows, anchor)
    if (verified !== null) highlights.push(highlightFromAnchor(rows, path, anchor, verified, "note", clipped))
  }
  return highlights
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Ask, validate, and on failure feed the errors back exactly once. */
async function askValidated<T>(
  session: ReviewSession,
  request: string,
  type: "plan" | "file" | "ask",
  validate: (raw: unknown) => Validated<T>,
): Promise<{ value: T | null; errors: string[] }> {
  const first = await session.ask(request, jsonSchemaFor(type))
  const firstParsed = parseModelJson(first)
  const firstCheck = firstParsed.ok ? validate(firstParsed.value) : firstParsed
  if (firstCheck.ok) return { value: firstCheck.value, errors: [] }

  const second = await session.ask(repairRequest(firstCheck.errors, first), jsonSchemaFor(type))
  const secondParsed = parseModelJson(second)
  const secondCheck = secondParsed.ok ? validate(secondParsed.value) : secondParsed
  if (secondCheck.ok) return { value: secondCheck.value, errors: [] }
  return { value: null, errors: secondCheck.errors }
}

function describeGuard(report: GuardReport): string {
  const where = report.paths.length === 0 ? "a file's contents" : report.paths.join(", ")
  return (
    `chert stopped the agent: the working tree changed during a call (${where}). ` +
    "The review can continue without it; nothing was approved."
  )
}

/** Everything the walk's functions share; one object instead of many closures. */
interface Context {
  options: WalkOptions
  byPath: Map<string, ReviewFile>
  session: ReviewSession | null
  guardTripped: string | null
  prefetching: string | null
  /** Each call waits for the previous one: a session is one conversation. */
  chain: Promise<unknown>
}

function serial<T>(context: Context, call: () => Promise<T>): Promise<T> {
  const next = context.chain.then(call, call)
  context.chain = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

function requireSession(context: Context): ReviewSession {
  if (context.guardTripped !== null) throw new Error(context.guardTripped)
  if (context.session === null) throw new Error("the walk has not started")
  return context.session
}

/** Run one call with a snapshot on each side; a change stops the walk. */
async function guarded<T>(context: Context, call: (session: ReviewSession) => Promise<T>): Promise<T> {
  const live = requireSession(context)
  const root = context.options.projectRoot
  const before = snapshotTree(root)
  const result = await call(live)
  const report = compareTrees(before, snapshotTree(root))
  if (report.changed) {
    context.guardTripped = describeGuard(report)
    context.options.callbacks.error(context.guardTripped)
  }
  return result
}

function rowsFor(context: Context, file: ReviewFile): { rows: Row[]; patch: string } {
  const patch = loadPatch(context.options.projectRoot, file, context.options.source)
  return { rows: parsePatch(patch), patch }
}

function cachedResult(context: Context, file: ReviewFile, rows: Row[], patch: string): WalkFileResult | null {
  if (context.session === null) return null
  const cached = getCachedAnalysis(context.options.state, context.session.id, file.path, patchHash(patch))
  if (cached === undefined) return null
  return { analysis: cached, ...buildHighlights(rows, file.path, cached) }
}

function saveProgress(context: Context, plan: PlanResponse | null): void {
  if (context.session === null) return
  saveWalk(context.options.state, context.options.walkKey, {
    harnessId: context.options.harness.id,
    forkedSessionId: context.session.id,
    mode: context.session.mode,
    plan: plan?.order ?? [],
    position: 0,
  })
  context.options.persist()
}

/** The agent keeps its own order; files it forgot are appended, never dropped. */
function planOrder(order: PlanResponse["order"], files: ReviewFile[]): PlanResponse["order"] {
  const known = new Set(files.map((file) => file.path))
  const kept = order.filter((entry) => known.has(entry.path))
  const asked = new Set(kept.map((entry) => entry.path))
  for (const file of files) {
    if (!asked.has(file.path)) kept.push({ path: file.path, reason: "not in the agent's plan" })
  }
  return kept
}

async function startWalk(context: Context): Promise<void> {
  const { harness, projectRoot, files, sourceLabel, callbacks } = context.options
  try {
    callbacks.status(`Opening ${harness.label}…`)
    // The fork itself is a call too, so it is guarded like every other one.
    const before = snapshotTree(projectRoot)
    context.session = await harness.start({
      projectRoot,
      baseSessionId: context.options.baseSessionId,
      title: `Review: ${sourceLabel}`,
    })
    const report = compareTrees(before, snapshotTree(projectRoot))
    if (report.changed) {
      context.guardTripped = describeGuard(report)
      callbacks.status("")
      callbacks.error(context.guardTripped)
      return
    }
    saveProgress(context, null)
    callbacks.status("Asking the agent for a reading order…")
    const listed = files.map((file) => ({
      path: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    }))
    const result = await guarded(context, (live) =>
      askValidated(live, planRequest({ projectRoot, sourceLabel, files: listed }), "plan", validatePlan),
    )
    callbacks.status("")
    if (context.guardTripped !== null) return
    if (result.value === null) {
      callbacks.error(`The plan was not usable: ${result.errors.join("; ")}`)
      return
    }
    const plan: PlanResponse = { overview: result.value.overview, order: planOrder(result.value.order, files) }
    callbacks.plan(plan)
    saveProgress(context, plan)
  } catch (error) {
    callbacks.status("")
    callbacks.error(messageOf(error))
  }
}

async function analyzeInner(context: Context, path: string): Promise<WalkFileResult | null> {
  const { callbacks } = context.options
  const file = context.byPath.get(path)
  if (file === undefined) {
    callbacks.error(`not part of this review: ${path}`)
    return null
  }
  const { rows, patch } = rowsFor(context, file)
  const cached = cachedResult(context, file, rows, patch)
  if (cached !== null) return cached

  callbacks.status(`Reading ${path}…`)
  const result = await guarded(context, (live) =>
    askValidated(
      live,
      fileRequest({
        path: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        rows,
      }),
      "file",
      validateFile,
    ),
  )
  callbacks.status("")
  if (context.guardTripped !== null) return null
  if (result.value === null) {
    callbacks.error(`${path}: ${result.errors.join("; ")}`)
    return null
  }
  // The requested path is authoritative; a model that echoes another name
  // must not move the notes onto a different file.
  const analysis: FileAnalysis = { ...result.value, path: file.path }
  if (context.session !== null) {
    putCachedAnalysis(context.options.state, context.session.id, file.path, patchHash(patch), analysis)
    context.options.persist()
  }
  return { analysis, ...buildHighlights(rows, file.path, analysis) }
}

async function analyzeFile(context: Context, path: string): Promise<WalkFileResult | null> {
  try {
    const result = await serial(context, () => analyzeInner(context, path))
    if (result !== null) context.options.callbacks.file(result)
    return result
  } catch (error) {
    context.options.callbacks.status("")
    context.options.callbacks.error(messageOf(error))
    return null
  }
}

function prefetchFile(context: Context, path: string): void {
  if (context.prefetching !== null || context.guardTripped !== null || context.session === null) return
  const file = context.byPath.get(path)
  if (file === undefined) return
  const { rows, patch } = rowsFor(context, file)
  if (cachedResult(context, file, rows, patch) !== null) return
  context.prefetching = path
  void serial(context, () => analyzeInner(context, path))
    .catch(() => null)
    .finally(() => {
      context.prefetching = null
    })
}

async function askWalk(context: Context, question: string, path?: string, selection?: string): Promise<AskResponse | null> {
  const { callbacks } = context.options
  try {
    const file = path === undefined ? undefined : context.byPath.get(path)
    const rows = file === undefined ? undefined : rowsFor(context, file).rows
    const result = await serial(context, () =>
      guarded(context, (live) => askValidated(live, askRequest({ question, path, rows, selection }), "ask", validateAsk)),
    )
    if (context.guardTripped !== null) return null
    if (result.value === null) {
      callbacks.error(`The answer was not usable: ${result.errors.join("; ")}`)
      return null
    }
    const anchors = rows === undefined ? [] : highlightsForAnchors(rows, path ?? "", result.value.anchors, result.value.text)
    callbacks.ask(result.value, anchors)
    return result.value
  } catch (error) {
    callbacks.error(messageOf(error))
    return null
  }
}

export function createWalk(options: WalkOptions): Walk {
  const context: Context = {
    options,
    byPath: new Map(options.files.map((file) => [file.path, file])),
    session: null,
    guardTripped: null,
    prefetching: null,
    chain: Promise.resolve(),
  }
  return {
    sessionId: () => context.session?.id ?? null,
    mode: () => context.session?.mode ?? null,
    start: () => startWalk(context),
    analyze: (path) => analyzeFile(context, path),
    ask: (question, path, selection) => askWalk(context, question, path, selection),
    prefetch: (path) => prefetchFile(context, path),
    close: () => context.session?.close(),
  }
}
