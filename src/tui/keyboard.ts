// Keyboard handling. No modes in the sense of a global mode variable: an empty
// prompt means the screen has the keys, text in the prompt means editing.
//
// PRECEDENCE (do not reorder without checking every overlay):
//   1. review-source picker (it owns Esc/Enter/arrows while open)
//   2. Ctrl+P command picker toggle
//   3. highlight menu (arrows / Enter / Esc)
//   4. Esc, in this order: picker, menu, projects, all-files, review picker,
//      note editing, range selection, prompt text, code focus, open the menu
//   5. suggestion navigation and Tab completion
//   6. Enter: suggestion accept, theme accept, prompt submit, tree open,
//      done row, home recents, menu, projects, all-files, review actions,
//      highlight range/cursor
//   7. empty prompt: done, home recents, review screen (arrows, h, Space),
//      tree, menu, projects, all-files
// Anything not handled here falls through to the renderer.

import type { SelectOption } from "@opentui/core"
import { basename } from "node:path"
import type { Row } from "../diffrows"
import type { ReviewFile } from "../git"
import type { Highlight } from "../highlights"
import { forgetProject } from "../projects"
import type { Suggestion } from "./commands/registry"
import type { MainView } from "./commands/context"

/** The key object handed to useKeyboard (typed structurally). */
export interface KeyPress {
  name: string
  ctrl?: boolean
  preventDefault(): void
}

type ResolvedHighlightMap = Map<string, { startRow: number; endRow: number; moved: boolean } | null>

export interface KeyboardContext {
  // Predicates computed from prompt + suggestion state
  hasInputText(): boolean
  hasSuggestions(): boolean
  actionCount(): number

  // Review-source picker
  reviewPickerOpen(): boolean
  setReviewPickerOpen(open: boolean): void
  reviewPickerIndex(): number
  setReviewPickerIndex(update: number | ((index: number) => number)): void
  allReviewTargets(): Suggestion[]
  scrollReviewPicker(y: number): void

  // Prompt + suggestions
  pickerOpen(): boolean
  setPickerOpen(open: boolean): void
  suggestionIndex(): number
  setSuggestionIndex(update: number | ((index: number) => number)): void
  visibleSuggestions(): Suggestion[]
  acceptSuggestion(suggestion: Suggestion): void
  setPromptValue(value: string): void
  clearInput(): void
  submit(): void
  themeInput(): string | null
  themeSuggestions(): Suggestion[]
  cdMatches(): string[] | null
  runCommand(line: string): void

  // Highlight menu + mode
  highlightMenuOpen(): boolean
  setHighlightMenuOpen(open: boolean): void
  highlightMenuIndex(): number
  setHighlightMenuIndex(update: number | ((index: number) => number)): void
  highlightNoteMode(): boolean
  setHighlightNoteMode(active: boolean): void
  setHighlightNoteText(text: string): void
  setPendingHighlight(highlight: Highlight | null): void
  highlightForRowIndex(index: number): Highlight | undefined
  highlights(): Highlight[]
  setResolvedHighlights(map: ResolvedHighlightMap): void
  resolvedHighlights(): ResolvedHighlightMap
  persistHighlights(next: Highlight[]): boolean
  markAsked(path: string): void
  askAgent(prompt: string): void

  // Overlays and views
  menuOpen(): boolean
  setMenuOpen(open: boolean): void
  menuIndex(): number
  setMenuIndex(update: number | ((index: number) => number)): void
  menuOptions(): SelectOption[]
  handleMenuSelection(index: number): void
  projectsOpen(): boolean
  setProjectsOpen(open: boolean): void
  projectsIndex(): number
  setProjectsIndex(update: number | ((index: number) => number)): void
  allFilesOpen(): boolean
  setAllFilesOpen(open: boolean): void
  allFilesIndex(): number
  setAllFilesIndex(update: number | ((index: number) => number)): void
  view(): MainView
  setStatus(text: string): void
  hasProject(): boolean
  openRecent(index: number): void
  loadRecent(): Array<{ path: string }>

  // Review screen
  focus(): "files" | "code"
  setFocus(focus: "files" | "code"): void
  action(): number
  setAction(update: number | ((index: number) => number)): void
  activateAction(index: number): void
  navigate(delta: number): void
  rangeStart(): number | null
  setRangeStart(row: number | null): void
  codeRows(): Row[]
  codeCursor(): number
  setCodeCursor(update: number | ((row: number) => number)): void
  codeCursorRow(): number
  scrollCode(y: number): void
  file(): ReviewFile | undefined
  files(): ReviewFile[]
  selectFile(index: number): void
  patch(): string
  /** Whether the current file is approved for its current patch. */
  approved(): boolean
  /** Space: approve or un-approve the current file, then move on. */
  toggleApproval(): void
  scrollAllFiles(y: number): void

  // Tree + done
  moveTreeIndex(delta: number): void
  openTreeSelection(): void
  doneIndex(): number
  setDoneIndex(update: number | ((index: number) => number)): void
  doneOptions(): SelectOption[]
  activateDoneRow(index: number): void
}

/** One key press, in the precedence order documented above. */
export function handleKeyPress(ctx: KeyboardContext, key: KeyPress): void {
  const hasText = ctx.hasInputText()
  const showList = ctx.hasSuggestions()

  // Review source picker (opened by /review)
  if (ctx.reviewPickerOpen()) {
    if (key.name === "up" || key.name === "down") {
      key.preventDefault()
      const items = ctx.allReviewTargets()
      const dir = key.name === "up" ? -1 : 1
      ctx.setReviewPickerIndex((i) => {
        const next = Math.max(0, Math.min(i + dir, Math.max(0, items.length - 1)))
        ctx.scrollReviewPicker(Math.max(0, next - 6))
        return next
      })
      return
    }
    if (key.name === "return" || key.name === "enter") {
      key.preventDefault()
      const items = ctx.allReviewTargets()
      const item = items[ctx.reviewPickerIndex()]
      if (item) {
        ctx.setReviewPickerOpen(false)
        ctx.runCommand(item.insert.slice(1))
      }
      return
    }
    if (key.name === "escape") {
      key.preventDefault()
      ctx.setReviewPickerOpen(false)
      return
    }
    return
  }

  // Ctrl+P command picker
  if (key.ctrl && key.name === "p") {
    key.preventDefault()
    if (ctx.pickerOpen()) ctx.setPickerOpen(false)
    else {
      ctx.setPickerOpen(true)
      ctx.setSuggestionIndex(0)
    }
    return
  }

  // Highlight menu overlay
  if (ctx.highlightMenuOpen()) {
    if (key.name === "up" || key.name === "down") {
      key.preventDefault()
      const dir = key.name === "up" ? -1 : 1
      ctx.setHighlightMenuIndex((i) => Math.max(0, Math.min(i + dir, 3)))
      return
    }
    if (key.name === "return" || key.name === "enter") {
      key.preventDefault()
      const idx = ctx.highlightMenuIndex()
      const cur = ctx.codeCursorRow()
      const h = ctx.highlightForRowIndex(cur)
      if (!h) {
        ctx.setHighlightMenuOpen(false)
        return
      }
      if (idx === 0) {
        // Ask the AI about these lines
        ctx.setHighlightMenuOpen(false)
        const q = `Look at lines ${h.start}-${h.end} in ${h.path}. ${h.note ? h.note + " " : ""}The lines are:\n${h.text.map((t) => `  ${t}`).join("\n")}\nExplain in plain words, with the exact lines.`
        ctx.markAsked(h.path)
        void ctx.askAgent(q)
        return
      }
      if (idx === 1) {
        // Edit note
        ctx.setHighlightMenuOpen(false)
        ctx.setHighlightNoteMode(true)
        ctx.setHighlightNoteText(h.note)
        ctx.setPendingHighlight(h)
        ctx.setPromptValue(h.note)
        ctx.setStatus("edit note (Enter saves, Esc cancels)")
        return
      }
      if (idx === 2) {
        // Dismiss (AI) or Remove (mine)
        const saved = ctx.persistHighlights(ctx.highlights().filter((x) => x.id !== h.id))
        ctx.setResolvedHighlights(new Map(ctx.resolvedHighlights()))
        ctx.setHighlightMenuOpen(false)
        if (saved) ctx.setStatus(h.by === "ai" ? "dismissed AI highlight" : "removed highlight")
        return
      }
      // Close
      ctx.setHighlightMenuOpen(false)
      return
    }
    if (key.name === "escape") {
      key.preventDefault()
      ctx.setHighlightMenuOpen(false)
      return
    }
    return
  }

  // Esc
  if (key.name === "escape") {
    if (ctx.pickerOpen()) {
      key.preventDefault()
      ctx.setPickerOpen(false)
      return
    }
    if (ctx.menuOpen()) {
      ctx.setMenuOpen(false)
      ctx.setAllFilesOpen(false)
      return
    }
    if (ctx.projectsOpen()) {
      ctx.setProjectsOpen(false)
      return
    }
    if (ctx.allFilesOpen()) {
      ctx.setAllFilesOpen(false)
      return
    }
    if (ctx.reviewPickerOpen()) {
      ctx.setReviewPickerOpen(false)
      return
    }
    if (ctx.highlightNoteMode()) {
      ctx.setHighlightNoteMode(false)
      ctx.setPendingHighlight(null)
      ctx.clearInput()
      ctx.setStatus("")
      return
    }
    if (ctx.rangeStart() !== null) {
      ctx.setRangeStart(null)
      ctx.setStatus("")
      return
    }
    if (hasText) {
      ctx.clearInput()
      return
    }
    if (ctx.view() === "review" && ctx.focus() === "code") {
      ctx.setFocus("files")
      ctx.setStatus("")
      return
    }
    if (ctx.view() === "review") {
      ctx.setMenuOpen(true)
      return
    }
    return
  }

  // Suggestion list navigation
  if ((key.name === "up" || key.name === "down") && showList) {
    key.preventDefault()
    const list = ctx.visibleSuggestions()
    if (list.length === 0) return
    const dir = key.name === "up" ? -1 : 1
    ctx.setSuggestionIndex((i) => Math.max(0, Math.min(i + dir, list.length - 1)))
    return
  }

  if (key.name === "tab") {
    const matches = ctx.cdMatches()
    if (matches !== null && matches.length > 0) {
      key.preventDefault()
      const first = matches[0]
      const recents = ctx.loadRecent()
      const rec = recents.find((r) => basename(r.path) === first)
      const name = rec ? basename(rec.path) : first
      const completed = name.includes(" ") ? `"${name}"` : name
      ctx.setPromptValue(`/cd ${completed} `)
      return
    }
    const list = ctx.visibleSuggestions()
    if (list.length > 0) {
      key.preventDefault()
      ctx.setSuggestionIndex((i) => (i + 1) % list.length)
      return
    }
    return
  }

  if (key.name === "return" || key.name === "enter") {
    key.preventDefault()
    if (ctx.pickerOpen() && ctx.visibleSuggestions().length > 0) {
      ctx.acceptSuggestion(
        ctx.visibleSuggestions()[Math.min(ctx.suggestionIndex(), ctx.visibleSuggestions().length - 1)],
      )
      return
    }
    if (ctx.themeInput() !== null && ctx.visibleSuggestions().length > 0) {
      ctx.acceptSuggestion(
        ctx.visibleSuggestions()[Math.min(ctx.suggestionIndex(), ctx.visibleSuggestions().length - 1)],
      )
      ctx.submit()
      return
    }
    if (hasText) {
      ctx.submit()
      return
    }
    if (ctx.view() === "tree") {
      ctx.openTreeSelection()
      return
    }
    if (ctx.view() === "done") {
      ctx.activateDoneRow(ctx.doneIndex())
      return
    }
    if (ctx.view() === "review" && !ctx.hasProject()) {
      ctx.openRecent(ctx.projectsIndex())
      return
    }

    if (ctx.menuOpen()) {
      ctx.handleMenuSelection(ctx.menuIndex())
      return
    }
    if (ctx.projectsOpen()) {
      const recents = ctx.loadRecent()
      const item = recents[ctx.projectsIndex()]
      if (item) {
        ctx.setProjectsOpen(false)
        ctx.setMenuOpen(false)
        ctx.openRecent(ctx.projectsIndex())
      }
      return
    }
    if (ctx.allFilesOpen()) {
      const af = (ctx.files() ?? [])[ctx.allFilesIndex()]
      if (af) {
        ctx.setAllFilesOpen(false)
        ctx.setMenuOpen(false)
        ctx.selectFile(ctx.files()!.indexOf(af))
        ctx.setFocus("files")
      }
      return
    }
    if (ctx.view() === "review") {
      if (ctx.focus() === "files") {
        ctx.activateAction(ctx.action())
        return
      }
      // code ctx.focus: Enter
      const cur = ctx.codeCursorRow()
      const rows = ctx.codeRows()
      const row = rows[cur]
      const isCodeRow =
        row !== undefined && (row.kind === "context" || row.kind === "add" || row.kind === "del")
      const h = ctx.highlightForRowIndex(cur)
      if (h) {
        ctx.setHighlightMenuOpen(true)
        ctx.setHighlightMenuIndex(0)
        return
      }
      if (!isCodeRow) {
        ctx.setStatus("Move to a code line to highlight.")
        return
      }
      if (ctx.rangeStart() === null) {
        ctx.setRangeStart(cur)
        ctx.setStatus(
          `Highlighting from line ${cur + 1}. Move to the last line and press Enter. Esc cancels.`,
        )
        return
      }
      // complete range
      const rs = ctx.rangeStart()!
      const start = Math.min(rs, cur)
      const end = Math.max(rs, cur)
      // validate: cannot cross hunk header or mix sides
      const allRows = ctx.codeRows()
      const sides = new Set<string>()
      let crossesHunk = false
      let lastHunk = -1
      for (let i = start; i <= end; i++) {
        const r = allRows[i]
        if (!r) {
          crossesHunk = true
          break
        }
        if (r.kind === "hunk") {
          crossesHunk = true
          break
        }
        if (r.kind === "meta") {
          crossesHunk = true
          break
        }
        const side = r.kind === "del" ? "old" : "new"
        sides.add(side)
      }
      if (crossesHunk) {
        ctx.setStatus("Highlight range cannot cross a hunk header.")
        ctx.setRangeStart(null)
        return
      }
      if (sides.size > 1) {
        ctx.setStatus("Highlight range cannot mix old and new sides.")
        ctx.setRangeStart(null)
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
        path: ctx.file()?.path ?? "",
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
      ctx.setHighlightNoteMode(true)
      ctx.setHighlightNoteText("")
      // store pending highlight temporarily? Use a temp signal. We'll save on note ctx.submit.
      // Store in a temp variable via a signal.
      ctx.setPendingHighlight(hl)
      ctx.setRangeStart(null)
      ctx.setStatus(
        "note for these lines (Enter saves, Enter with nothing saves without a note, Esc cancels)",
      )
      return
    }
    return
  }

  // Empty box: screen keys
  if (!hasText) {
    if (ctx.view() === "done") {
      if (key.name === "up" || key.name === "down") {
        key.preventDefault()
        const dir = key.name === "up" ? -1 : 1
        ctx.setDoneIndex((i) => Math.max(0, Math.min(i + dir, Math.max(0, ctx.doneOptions().length - 1))))
        return
      }
      return
    }
    if (ctx.view() === "review" && !ctx.hasProject()) {
      if (key.name === "up" || key.name === "down") {
        key.preventDefault()
        const dir = key.name === "up" ? -1 : 1
        const count = ctx.loadRecent().length
        ctx.setProjectsIndex((i) => Math.max(0, Math.min(i + dir, Math.max(0, count - 1))))
        return
      }
      if (key.name === "delete") {
        key.preventDefault()
        const item = ctx.loadRecent()[ctx.projectsIndex()]
        if (item) {
          forgetProject(item.path)
          ctx.setProjectsIndex((i) => Math.max(0, Math.min(i, Math.max(0, ctx.loadRecent().length - 1))))
          ctx.setStatus(`forgot ${basename(item.path)}`)
        }
        return
      }
      return
    }
    if (ctx.view() === "review") {
      if (key.name === "left" || key.name === "right") {
        key.preventDefault()
        const dir = key.name === "left" ? -1 : 1
        ctx.setAction((i) => Math.max(0, Math.min(i + dir, ctx.actionCount() - 1)))
        return
      }
      if (key.name === "h") {
        key.preventDefault()
        const entering = ctx.focus() !== "code"
        ctx.setFocus(entering ? "code" : "files")
        ctx.setRangeStart(null)
        ctx.setStatus("")
        if (entering) {
          const first = ctx.codeRows().findIndex((r) => r.kind !== "meta")
          const row = first === -1 ? 0 : first
          ctx.setCodeCursor(row)
          ctx.scrollCode(Math.max(0, row - 3))
        }
        return
      }
      if (key.name === " " || key.name === "space") {
        key.preventDefault()
        ctx.toggleApproval()
        return
      }
      if (ctx.focus() === "files") {
        if (key.name === "up" || key.name === "down") {
          key.preventDefault()
          ctx.navigate(key.name === "up" ? -1 : 1)
          return
        }
      } else if (ctx.focus() === "code") {
        if (key.name === "up" || key.name === "down") {
          key.preventDefault()
          const rows = ctx.codeRows()
          if (rows.length === 0) return
          const dir = key.name === "up" ? -1 : 1
          ctx.setCodeCursor((c) => Math.max(0, Math.min(c + dir, rows.length - 1)))
          // auto-scroll
          ctx.scrollCode(Math.max(0, ctx.codeCursor() - 5))
          return
        }
        if (key.name === "pageup" || key.name === "pagedown") {
          key.preventDefault()
          const delta = key.name === "pageup" ? -10 : 10
          const rows = ctx.codeRows()
          ctx.setCodeCursor((c) => Math.max(0, Math.min(c + delta, rows.length - 1)))
          ctx.scrollCode(Math.max(0, ctx.codeCursor() - 5))
          return
        }
      }
      return
    }
    if (ctx.view() === "tree") {
      if (key.name === "up" || key.name === "down") {
        key.preventDefault()
        ctx.moveTreeIndex(key.name === "up" ? -1 : 1)
        return
      }
      return
    }

    if (ctx.menuOpen()) {
      if (key.name === "up" || key.name === "down") {
        key.preventDefault()
        const dir = key.name === "up" ? -1 : 1
        ctx.setMenuIndex((i) => {
          const next = Math.max(0, Math.min(i + dir, ctx.menuOptions().length - 1))
          return next
        })
        return
      }
      return
    }
    if (ctx.projectsOpen()) {
      if (key.name === "up" || key.name === "down") {
        key.preventDefault()
        const dir = key.name === "up" ? -1 : 1
        const recents = ctx.loadRecent()
        ctx.setProjectsIndex((i) => {
          const next = Math.max(0, Math.min(i + dir, Math.max(0, recents.length - 1)))
          return next
        })
        return
      }
      if (key.name === "delete") {
        key.preventDefault()
        const item = ctx.loadRecent()[ctx.projectsIndex()]
        if (item) {
          forgetProject(item.path)
          ctx.setProjectsIndex((i) => Math.max(0, Math.min(i, Math.max(0, ctx.loadRecent().length - 1))))
          ctx.setStatus(`forgot ${basename(item.path)}`)
        }
        return
      }
      return
    }
    if (ctx.allFilesOpen()) {
      if (key.name === "up" || key.name === "down") {
        key.preventDefault()
        const dir = key.name === "up" ? -1 : 1
        ctx.setAllFilesIndex((i) => {
          const next = Math.max(0, Math.min(i + dir, (ctx.files()?.length ?? 1) - 1))
          ctx.scrollAllFiles(Math.max(0, next - 6))
          return next
        })
        return
      }
      return
    }
  }
}
