// The highlight tool is the mouse: dragging over the diff marks the lines under
// the pointer. This module turns a finished drag into diff rows and then into a
// savable highlight, so the geometry and the rules stay testable without a TUI.

import type { Row } from "../diffrows"
import type { Highlight, HighlightSide } from "../highlights"

export interface ScreenBox {
  x: number
  y: number
  width: number
  height: number
}

export interface ScreenPoint {
  x: number
  y: number
}

export interface RowRange {
  start: number
  end: number
}

export interface DragInput {
  box: ScreenBox
  /** Rows hidden above the viewport. */
  scrollTop: number
  rowCount: number
  anchor: ScreenPoint
  focus: ScreenPoint
}

/**
 * The rows a drag covers. Null when the drag did not start in the diff, so a
 * selection in the file list never turns into a highlight. A drag that runs
 * past the bottom of the box stops at its last visible row.
 */
export function rowsUnderDrag(input: DragInput): RowRange | null {
  const { box, scrollTop, rowCount, anchor, focus } = input
  if (rowCount === 0) return null
  if (anchor.x < box.x || anchor.x >= box.x + box.width) return null
  if (anchor.y < box.y || anchor.y >= box.y + box.height) return null
  const first = anchor.y - box.y + scrollTop
  if (first < 0 || first >= rowCount) return null
  const focusY = Math.max(box.y, Math.min(focus.y, box.y + box.height - 1))
  const last = Math.min(focusY - box.y + scrollTop, rowCount - 1)
  return { start: Math.min(first, last), end: Math.max(first, last) }
}

export type HighlightFromRows =
  | { ok: true; highlight: Highlight }
  | { ok: false; reason: string }

/** A highlight for rows `start`..`end`, or the reason the range cannot be one. */
export function highlightFromRows(
  rows: Row[],
  start: number,
  end: number,
  path: string,
): HighlightFromRows {
  const first = rows[start]
  if (!first || first.kind === "hunk" || first.kind === "meta") {
    return { ok: false, reason: "Move to a code line to highlight." }
  }
  const sides = new Set<HighlightSide>()
  for (let i = start; i <= end; i++) {
    const row = rows[i]
    if (!row || row.kind === "hunk" || row.kind === "meta") {
      return { ok: false, reason: "Highlight range cannot cross a hunk header." }
    }
    sides.add(row.kind === "del" ? "old" : "new")
  }
  if (sides.size > 1) {
    return { ok: false, reason: "Highlight range cannot mix old and new sides." }
  }
  const side: HighlightSide = sides.has("old") ? "old" : "new"
  const lineNo = (row: Row) => (side === "new" ? (row.newNo ?? 0) : (row.oldNo ?? 0))
  return {
    ok: true,
    highlight: {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      path,
      side,
      start: lineNo(rows[start]),
      end: lineNo(rows[end]),
      text: rows.slice(start, end + 1).map((row) => row.text),
      before: rows.slice(Math.max(0, start - 2), start).map((row) => row.text),
      after: rows.slice(end + 1, end + 3).map((row) => row.text),
      by: "you",
      level: "note",
      note: "",
      createdAt: Date.now(),
    },
  }
}
