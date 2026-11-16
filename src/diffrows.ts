// Pure parser for unified diff patches into display rows.
// No I/O, no git calls. Used by the two-pane code view.

export type RowKind = "hunk" | "context" | "add" | "del" | "meta"

export interface Row {
  kind: RowKind
  oldNo?: number
  newNo?: number
  text: string
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export function parsePatch(patch: string): Row[] {
  const rows: Row[] = []
  if (patch === "") return rows

  const lines = patch.split("\n")
  let oldNo = 0
  let newNo = 0
  let inHunk = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (i === lines.length - 1 && line === "") continue

    if (line.startsWith("\\")) {
      rows.push({ kind: "meta", text: line })
      continue
    }

    if (
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("---") ||
      line.startsWith("+++") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("similarity") ||
      line.startsWith("rename") ||
      line.startsWith("copy") ||
      line.startsWith("Binary files") ||
      line.startsWith("GIT binary")
    ) {
      rows.push({ kind: "meta", text: line })
      continue
    }

    const hunkMatch = HUNK_RE.exec(line)
    if (hunkMatch) {
      inHunk = true
      oldNo = parseInt(hunkMatch[1], 10)
      newNo = parseInt(hunkMatch[3], 10)
      const oldCount = hunkMatch[2] === undefined ? 1 : parseInt(hunkMatch[2], 10)
      const newCount = hunkMatch[4] === undefined ? 1 : parseInt(hunkMatch[4], 10)
      if (oldCount === 0) oldNo += 1
      if (newCount === 0) newNo += 1
      rows.push({ kind: "hunk", text: line, oldNo, newNo })
      continue
    }

    if (!inHunk) {
      if (line === "") continue
      rows.push({ kind: "meta", text: line })
      continue
    }

    if (line.startsWith("+")) {
      rows.push({ kind: "add", newNo, text: line.slice(1) })
      newNo += 1
      continue
    }
    if (line.startsWith("-")) {
      rows.push({ kind: "del", oldNo, text: line.slice(1) })
      oldNo += 1
      continue
    }
    if (line.startsWith(" ")) {
      rows.push({ kind: "context", oldNo, newNo, text: line.slice(1) })
      oldNo += 1
      newNo += 1
      continue
    }
    if (line === "") continue
    rows.push({ kind: "meta", text: line })
  }

  return rows
}
