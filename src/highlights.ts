// Highlights: per-line annotations stored in the git folder.
// Pure helpers (resolveHighlights) plus storage (load/save) that writes only
// to <gitDir>/chert/highlights.json.

import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { gitDir, run } from "./git";

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

function ensureDir(): void {
  try {
    mkdirSync(dirname(highlightsPath()), { recursive: true })
  } catch {
    // ignore
  }
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
    try {
      if (existsSync(path)) copyFileSync(path, path + ".bak")
    } catch {
      // ignore
    }
    return []
  }
}

export function saveHighlights(highlights: Highlight[]): void {
  ensureDir()
  const path = highlightsPath()
  // cap 500: drop oldest AI first
  let list = [...highlights]
  if (list.length > 500) {
    const ai = list.filter((h) => h.by === "ai").sort((a, b) => a.createdAt - b.createdAt)
    const toDrop = list.length - 500
    const dropIds = new Set(ai.slice(0, toDrop).map((h) => h.id))
    list = list.filter((h) => !dropIds.has(h.id))
  }
  const tmp = path + ".tmp"
  const data: HighlightsFile = { version: 1, highlights: list }
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, path)
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
      if (storedText.length === 0) { match = false }
      for (let k = 0; k < storedText.length; k++) {
        const row = sideRows[i + k]
        if (!row) { match = false; break }
        if (row.r.text !== storedText[k]) {
          // try trimmed
          if (row.r.text.trim() !== storedText[k].trim()) { match = false; break }
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
