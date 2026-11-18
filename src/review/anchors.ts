// Anchor verification: a protocol anchor names a line range and quotes the
// first line. A note on the wrong line is worse than no note, so every anchor is
// checked against the parsed diff before it becomes a highlight.

import type { Row } from "../diffrows"
import type { Highlight } from "../highlights"
import type { Anchor, AnchorSide } from "./protocol"

export interface VerifiedAnchor {
  startRow: number
  endRow: number
  /** The quote was found at a different line than the one the agent named. */
  relocated: boolean
}

/** The rows an anchor on `side` may refer to, in display order. */
export function sideRows(rows: Row[], side: AnchorSide): { row: Row; index: number }[] {
  return rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) =>
      side === "new" ? row.kind === "context" || row.kind === "add" : row.kind === "context" || row.kind === "del",
    )
}

function lineNoOf(row: Row, side: AnchorSide): number {
  return side === "new" ? (row.newNo ?? 0) : (row.oldNo ?? 0)
}

/** Compare the way the diff view does: exact first, then ignoring indentation. */
function sameLine(actual: string, quote: string): boolean {
  return actual === quote || actual.trim() === quote.trim()
}

/**
 * Resolve an anchor to display rows, or null when it cannot be placed.
 *
 * - the named line exists and its text matches -> use it
 * - the quote matches exactly one line on that side -> relocate to it
 * - anything else (missing, ambiguous, crossing a hunk) -> drop
 */
export function verifyAnchor(rows: Row[], anchor: Anchor): VerifiedAnchor | null {
  const candidates = sideRows(rows, anchor.side)
  if (candidates.length === 0) return null
  const span = anchor.end - anchor.start

  const startIndex = candidates.findIndex(({ row }) => lineNoOf(row, anchor.side) === anchor.start)
  if (startIndex !== -1 && sameLine(candidates[startIndex].row.text, anchor.quote)) {
    const endIndex = startIndex + span
    const last = candidates[endIndex]
    // A range that runs off the end of its hunk would point at unrelated lines.
    if (last !== undefined && lineNoOf(last.row, anchor.side) === anchor.start + span) {
      return { startRow: candidates[startIndex].index, endRow: last.index, relocated: false }
    }
  }

  const matches = candidates.filter(({ row }) => sameLine(row.text, anchor.quote))
  if (matches.length !== 1) return null
  const relocatedStart = candidates.findIndex((entry) => entry === matches[0])
  const relocatedEnd = candidates[relocatedStart + span]
  const endRow =
    relocatedEnd !== undefined && lineNoOf(relocatedEnd.row, anchor.side) === anchor.start + span
      ? relocatedEnd.index
      : matches[0].index
  return { startRow: matches[0].index, endRow, relocated: true }
}

export interface AnchorOutcome {
  anchor: Anchor
  verified: VerifiedAnchor
}

export interface AnchorReport {
  kept: AnchorOutcome[]
  dropped: Anchor[]
}

/** Verify a batch, keeping the order the agent gave. */
export function verifyAnchors(rows: Row[], anchors: Anchor[]): AnchorReport {
  const kept: AnchorOutcome[] = []
  const dropped: Anchor[] = []
  for (const anchor of anchors) {
    const verified = verifyAnchor(rows, anchor)
    if (verified === null) dropped.push(anchor)
    else kept.push({ anchor, verified })
  }
  return { kept, dropped }
}

/**
 * Build the highlight for a verified anchor, capturing its lines and two lines
 * of context on each side. Line numbers come from the rows actually resolved,
 * so a relocated anchor is stored where it was found.
 */
export function highlightFromAnchor(
  rows: Row[],
  path: string,
  anchor: Anchor,
  verified: VerifiedAnchor,
  level: Highlight["level"],
  note: string,
): Highlight {
  const first = rows[verified.startRow]
  const last = rows[verified.endRow] ?? first
  const start = lineNoOf(first, anchor.side) || anchor.start
  const end = Math.max(start, lineNoOf(last, anchor.side) || start)
  return {
    id: `ai-${crypto.randomUUID()}`,
    path,
    side: anchor.side,
    start,
    end,
    text: rows.slice(verified.startRow, verified.endRow + 1).map((row) => row.text),
    before: rows.slice(Math.max(0, verified.startRow - 2), verified.startRow).map((row) => row.text),
    after: rows.slice(verified.endRow + 1, verified.endRow + 3).map((row) => row.text),
    by: "ai",
    level,
    note,
    createdAt: Date.now(),
  }
}
