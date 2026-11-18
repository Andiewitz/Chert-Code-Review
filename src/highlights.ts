// Highlights: per-line annotations stored in the git folder.
// Pure helpers (resolveHighlights) plus storage (load/save) that writes only
// to <gitDir>/chert/highlights.json.

import { copyFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { writeJsonAtomic } from "./config"
import { MAX_SAVED_HIGHLIGHTS } from "./limits"
import { gitDir } from "./git"
import { bestEffort, tryOr } from "./best-effort"

export type HighlightSide = "new" | "old"
export type HighlightBy = "you" | "ai"
export type HighlightLevel = "note" | "high" | "medium" | "low"

export interface Highlight {
  id: string
  path: string
  side: HighlightSide
  start: number
  end: number
  text: string[]
  before: string[]
  after: string[]
  by: HighlightBy
  level: HighlightLevel
  note: string
  createdAt: number
}

export interface ResolvedHighlight {
  startRow: number
  endRow: number
  moved: boolean
}

export interface HighlightsFile {
  version: 1
  highlights: Highlight[]
}

function highlightsPath(): string {
  return join(gitDir(), "chert", "highlights.json")
}

export function loadHighlights(): Highlight[] {
  const path = highlightsPath()
  try {
    if (!existsSync(path)) return []
    const raw = readFileSync(path, "utf8")
    const parsed = JSON.parse(raw) as HighlightsFile
    if (!parsed || !Array.isArray(parsed.highlights)) throw new Error("bad shape")
    return parsed.highlights.filter((h) => h && typeof h.id === "string")
  } catch (e) {
    // corrupt: back up
    bestEffort("back up a corrupt highlights file", () => {
      if (existsSync(path)) copyFileSync(path, path + ".bak")
    })
    return []
  }
}

export interface SaveHighlightsResult {
  /** AI highlights dropped to stay under the cap. */
  droppedAi: number
  /** True when user highlights alone already exceed the cap (nothing dropped). */
  overCap: boolean
}

export interface CappedHighlights extends SaveHighlightsResult {
  list: Highlight[]
}

/**
 * Apply the save cap. User highlights are the user's data and are never
 * dropped; only the oldest AI highlights give way to keep the file at or under
 * `max`. When user highlights alone exceed the cap, everything is kept and
 * `overCap` says so, so the caller can say it once.
 */
export function capHighlights(highlights: Highlight[], max = MAX_SAVED_HIGHLIGHTS): CappedHighlights {
  const userCount = highlights.filter((h) => h.by === "you").length
  // The user's own highlights already fill the file: dropping AI ones would not
  // bring it under the cap, so keep everything and report the overflow instead.
  if (userCount >= max) return { list: highlights, droppedAi: 0, overCap: true }
  const budget = max - userCount
  const aiByAge = highlights.filter((h) => h.by === "ai").sort((a, b) => a.createdAt - b.createdAt)
  const keptAi = new Set(aiByAge.slice(Math.max(0, aiByAge.length - budget)).map((h) => h.id))
  const list = highlights.filter((h) => h.by === "you" || keptAi.has(h.id))
  return { list, droppedAi: highlights.length - list.length, overCap: false }
}

/** Persist highlights through {@link capHighlights}. */
export function saveHighlights(highlights: Highlight[]): SaveHighlightsResult {
  const { list, droppedAi, overCap } = capHighlights(highlights)
  const data: HighlightsFile = { version: 1, highlights: list }
  writeJsonAtomic(highlightsPath(), data)
  return { droppedAi, overCap }
}

// Pure resolver: given diff rows and highlights for a file, return Map id -> resolved or null.
export function resolveHighlights(
  rows: { kind: string; oldNo?: number; newNo?: number; text: string }[],
  side: HighlightSide,
  highlights: Highlight[],
): Map<string, ResolvedHighlight | null> {
  const result = new Map<string, ResolvedHighlight | null>()
  const sideRows = rows
    .map((r, idx) => ({ r, idx }))
    .filter(({ r }) => {
      if (side === "new") return r.kind === "context" || r.kind === "add"
      return r.kind === "context" || r.kind === "del"
    })

  const lineNoOf = (r: { oldNo?: number; newNo?: number }) =>
    side === "new" ? (r.newNo ?? 0) : (r.oldNo ?? 0)

  for (const h of highlights) {
    if (h.side !== side) {
      result.set(h.id, null)
      continue
    }
    // exact match at stored line numbers
    const storedStart = h.start
    const storedText = h.text
    // find start row index where rows match stored text on this side
    let best: { idx: number; score: number; moved: boolean } | null = null

    // candidate starting positions: every index in sideRows where consecutive text matches
    const candidates: number[] = []
    for (let i = 0; i < sideRows.length; i++) {
      // check if storedText matches starting at i
      let match = true
      if (storedText.length === 0) {
        match = false
      }
      for (let k = 0; k < storedText.length; k++) {
        const row = sideRows[i + k]
        if (!row) {
          match = false
          break
        }
        if (row.r.text !== storedText[k]) {
          // try trimmed
          if (row.r.text.trim() !== storedText[k].trim()) {
            match = false
            break
          }
        }
      }
      if (match) candidates.push(i)
    }

    if (candidates.length === 0) {
      result.set(h.id, null)
      continue
    }

    // Score candidates by context match and closeness to stored start
    for (const ci of candidates) {
      const row = sideRows[ci]
      const rowLineNo = lineNoOf(row.r)
      let score = 0
      // context before
      for (let k = 0; k < h.before.length; k++) {
        const ctxRow = sideRows[ci - (h.before.length - k)]
        if (ctxRow && ctxRow.r.text === h.before[k]) score += 2
        else if (ctxRow && ctxRow.r.text.trim() === h.before[k].trim()) score += 1
      }
      // context after
      for (let k = 0; k < h.after.length; k++) {
        const ctxRow = sideRows[ci + storedText.length + k]
        if (ctxRow && ctxRow.r.text === h.after[k]) score += 2
        else if (ctxRow && ctxRow.r.text.trim() === h.after[k].trim()) score += 1
      }
      // closeness to stored start
      score -= Math.abs(rowLineNo - storedStart) * 0.1
      const moved = rowLineNo !== storedStart
      if (best === null || score > best.score) {
        best = { idx: ci, score, moved }
      }
    }

    if (best === null) {
      result.set(h.id, null)
      continue
    }

    const startIdx = sideRows[best.idx].idx
    const endIdx = sideRows[best.idx + storedText.length - 1].idx
    result.set(h.id, { startRow: startIdx, endRow: endIdx, moved: best.moved })
  }

  return result
}

export interface ParsedAgentHighlight {
  file: string
  side: HighlightSide
  start: number
  end: number
  level: "high" | "medium" | "low"
  note: string
}

export interface AgentParseResult {
  highlights: Highlight[]
  skipped: string[]
  cleanText: string
}

const AGENT_BLOCK_RE = /```chert-highlights\s*\n([\s\S]*?)```/

/** An answer may add at most this many highlights; extras are reported as skipped. */
const MAX_AI_HIGHLIGHTS_PER_ANSWER = 8
/** Longest span (in lines) a single AI highlight may cover. */
const MAX_AI_HIGHLIGHT_RANGE = 30
/** AI notes are trimmed to this many characters. */
const MAX_AI_HIGHLIGHT_NOTE = 200

type DiffRow = { kind: string; oldNo?: number; newNo?: number; text: string }

/** A candidate that already satisfied every check, with its captured lines. */
interface HighlightCandidate extends ParsedAgentHighlight {
  text: string[]
  before: string[]
  after: string[]
}

export function parseAgentHighlights(
  answerText: string,
  changedFiles: string[],
  getRows: (file: string) => DiffRow[] | undefined,
  existing: Highlight[],
): AgentParseResult {
  const skipped: string[] = []
  const cleaned = answerText.replace(AGENT_BLOCK_RE, "").trim()
  const match = AGENT_BLOCK_RE.exec(answerText)
  if (!match) {
    return { highlights: [], skipped, cleanText: answerText }
  }
  const parse = tryOr<{ value: unknown } | undefined>(() => ({ value: JSON.parse(match[1]) }), undefined)
  if (parse === undefined) {
    return { highlights: [], skipped: ["malformed JSON in highlight block"], cleanText: cleaned }
  }
  const parsed: unknown = parse.value
  if (!Array.isArray(parsed)) {
    return { highlights: [], skipped: ["highlight block is not an array"], cleanText: cleaned }
  }
  const entries: unknown[] = parsed

  const existingKeys = new Set(existing.map((h) => `${h.path}:${h.side}:${h.start}-${h.end}`))
  const candidates: HighlightCandidate[] = []
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") {
      skipped.push("invalid entry")
      continue
    }
    const item = entry as Record<string, unknown>
    const file = typeof item.file === "string" ? item.file : ""
    if (!changedFiles.includes(file)) {
      skipped.push(`unknown file: ${file}`)
      continue
    }
    const side: HighlightSide = item.side === "old" ? "old" : "new"
    const start = typeof item.start === "number" ? item.start : NaN
    const end = typeof item.end === "number" ? item.end : start
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      skipped.push("invalid line numbers")
      continue
    }
    if (end < start) {
      skipped.push("end before start")
      continue
    }
    if (end - start + 1 > MAX_AI_HIGHLIGHT_RANGE) {
      skipped.push("range too large")
      continue
    }
    const level = item.level === "high" || item.level === "medium" || item.level === "low" ? item.level : null
    if (level === null) {
      skipped.push("invalid level")
      continue
    }
    const note = typeof item.note === "string" ? item.note.trim().slice(0, MAX_AI_HIGHLIGHT_NOTE) : ""
    if (note === "") {
      skipped.push("empty note")
      continue
    }

    const rows = getRows(file)
    if (!rows) {
      skipped.push(`no rows for ${file}`)
      continue
    }
    const sideRows = rows.filter((r) =>
      side === "new" ? r.kind === "context" || r.kind === "add" : r.kind === "context" || r.kind === "del",
    )
    const lineNoOf = (r: DiffRow) => (side === "new" ? (r.newNo ?? 0) : (r.oldNo ?? 0))
    // validate start/end are real line numbers
    const startRowIdx = sideRows.findIndex((r) => lineNoOf(r) === start)
    const endRowIdx = sideRows.findIndex((r) => lineNoOf(r) === end)
    if (startRowIdx === -1 || endRowIdx === -1 || endRowIdx < startRowIdx) {
      skipped.push(`line out of range: ${file}:${start}-${end}`)
      continue
    }
    // check consecutive
    let ok = true
    for (let k = 0; k <= endRowIdx - startRowIdx; k++) {
      if (lineNoOf(sideRows[startRowIdx + k]) !== start + k) {
        ok = false
        break
      }
    }
    if (!ok) {
      skipped.push(`non-consecutive lines: ${file}:${start}-${end}`)
      continue
    }

    const key = `${file}:${side}:${start}-${end}`
    if (existingKeys.has(key)) {
      skipped.push(`duplicate: ${file}:${start}-${end}`)
      continue
    }

    candidates.push({
      file,
      side,
      start,
      end,
      level,
      note,
      text: sideRows.slice(startRowIdx, endRowIdx + 1).map((r) => r.text),
      before: sideRows.slice(Math.max(0, startRowIdx - 2), startRowIdx).map((r) => r.text),
      after: sideRows.slice(endRowIdx + 1, endRowIdx + 3).map((r) => r.text),
    })
  }

  const levelRank = { high: 0, medium: 1, low: 2 }
  candidates.sort((a, b) => levelRank[a.level] - levelRank[b.level])
  const chosen = candidates.slice(0, MAX_AI_HIGHLIGHTS_PER_ANSWER)
  if (candidates.length > MAX_AI_HIGHLIGHTS_PER_ANSWER) {
    skipped.push(`${candidates.length - MAX_AI_HIGHLIGHTS_PER_ANSWER} over cap`)
  }

  // A UUID rather than a timestamp+index: two answers in the same millisecond
  // used to produce colliding ids.
  const createdAt = Date.now()
  const highlights: Highlight[] = chosen.map((candidate) => ({
    id: `ai-${crypto.randomUUID()}`,
    path: candidate.file,
    side: candidate.side,
    start: candidate.start,
    end: candidate.end,
    text: candidate.text,
    before: candidate.before,
    after: candidate.after,
    by: "ai",
    level: candidate.level,
    note: candidate.note,
    createdAt,
  }))

  return { highlights, skipped, cleanText: cleaned }
}
