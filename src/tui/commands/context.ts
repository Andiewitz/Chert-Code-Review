// Everything a slash-command handler is allowed to touch, spelled out. The TUI
// builds this object from its own closures, so a handler can never reach into an
// unrelated signal.

import type { ReviewFile, ReviewSource } from "../../git"
import type { Highlight } from "../../highlights"

export type MainView = "review" | "tree" | "log" | "done"
export type EntryKind = "user" | "agent" | "system" | "error"

/** A handler runs one command; `args` is the text after the command name. */
export type CommandHandler = (ctx: CommandContext) => void

export interface CommandContext {
  /** Everything after the command name, trimmed ("" when none). */
  args: string

  // Transcript and view
  addEntry(kind: EntryKind, text: string): void
  setStatus(text: string): void
  setView(view: MainView): void
  setPromptValue(value: string): void
  openMenu(): void
  quit(): void

  // Project
  hasProject(): boolean
  projectRoot(): string
  files(): ReviewFile[]
  openProjectAt(path: string): string | undefined
  previousProjectPath(): string | null
  refresh(): void
  listProjects(): void
  openTree(): void
  selectFile(index: number): void

  // Review source
  /** Persist the source for this project, then reload the file list. */
  applyReviewSource(source: ReviewSource): void
  /** Use the saved source for `root` (no reload). */
  restoreSavedReviewSource(root: string): void
  openReviewPicker(): void
  sourceLabel(): string

  // Highlights
  highlights(): Highlight[]
  persistHighlights(next: Highlight[]): boolean
  clearHighlights(): void
  isHighlightOutdated(id: string): boolean

  // Connectors
  connectorId(): string
  model(): string | undefined
  setConnector(id: string, model: string | undefined): void
  activeLabel(): string
  connectorsStatus(): string
}
