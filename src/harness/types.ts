// The harness interface: what chert needs from a coding CLI in order to fork
// the developer's session and ask structured questions through the protocol.
// Every adapter owns exactly one CLI, so there is one place that spawns it.

/**
 * No harness has a prompt flag for "open a fork", so the fork starts with a
 * trivial request. One wording for both adapters keeps them comparable.
 */
export const OPENING_PROMPT = "Reply with the single word: ready."

export interface SessionInfo {
  id: string
  title: string
  /** Unix milliseconds of the last update. */
  updatedAt: number
}

export interface HarnessDetection {
  available: boolean
  /** The CLI's version string, when it printed one. */
  version: string | null
  /** Why it is unavailable, in words the TUI can show. Absent when available. */
  reason?: string
}

export type HarnessMode = "author-context" | "fresh"

export interface StartOptions {
  projectRoot: string
  /** Session to fork. Without one the review starts a fresh session. */
  baseSessionId?: string
  /** Title for a session chert creates. */
  title?: string
}

/** A live conversation chert can keep asking. */
export interface ReviewSession {
  /** The id every later call resumes. Never the developer's original session. */
  id: string
  mode: HarnessMode
  /** Send one protocol request; resolves with the harness's text answer. */
  ask(request: string, schema?: Record<string, unknown>): Promise<string>
  /** Stop any process this session owns. Safe to call twice. */
  close(): void
}

export interface HarnessAdapter {
  id: string
  label: string
  /**
   * Whether the harness can be used right now. The opencode adapter also needs
   * its server, so this can be a network probe and is not cached forever.
   */
  detect(): Promise<HarnessDetection>
  /** Recent sessions for this project, newest first. Empty when unsupported. */
  listSessions(projectRoot: string): SessionInfo[]
  /** Fork `baseSessionId`, or start fresh, and return the session to resume. */
  start(options: StartOptions): Promise<ReviewSession>
  /** A single request that keeps no session, for plain prompts. */
  askOnce(projectRoot: string, request: string): Promise<string>
}
