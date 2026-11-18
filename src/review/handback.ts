// The hand-back: after a walk in which the human flagged something, write their
// notes with file and line references so the original author session can pick
// them up. chert writes this file and stops; it never writes into a session.

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { gitDir } from "../git"
import type { Highlight } from "../highlights"

export function handbackPath(root: string): string {
  return join(gitDir(root), "chert", "handback.md")
}

/** Only notes the human wrote or kept; an empty note carries no information. */
export function notesForHandback(highlights: Highlight[]): Highlight[] {
  return highlights.filter((highlight) => highlight.note.trim() !== "")
}

export function handbackMarkdown(notes: Highlight[], forkedSessionId?: string): string {
  const lines = ["# Review notes", ""]
  if (forkedSessionId !== undefined && forkedSessionId !== "") {
    lines.push(`From review session \`${forkedSessionId}\`.`, "")
  }
  const byPath = new Map<string, Highlight[]>()
  for (const note of notes) {
    const list = byPath.get(note.path) ?? []
    list.push(note)
    byPath.set(note.path, list)
  }
  for (const [path, list] of [...byPath.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`## ${path}`, "")
    for (const note of list.sort((a, b) => a.start - b.start)) {
      const where = note.start === note.end ? `line ${note.start}` : `lines ${note.start}-${note.end}`
      const side = note.side === "old" ? " (old side)" : ""
      lines.push(`- ${where}${side}: ${note.note.trim()}`)
    }
    lines.push("")
  }
  return lines.join("\n")
}

/** Write the file and return its path, or null when there is nothing to hand back. */
export function writeHandback(root: string, highlights: Highlight[], forkedSessionId?: string): string | null {
  const notes = notesForHandback(highlights)
  if (notes.length === 0) return null
  const path = handbackPath(root)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, handbackMarkdown(notes, forkedSessionId))
  return path
}
