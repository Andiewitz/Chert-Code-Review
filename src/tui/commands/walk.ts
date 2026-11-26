// /walk starts the guided review: fork the author's harness session and let the
// agent narrate each changed file. The command only forwards the argument; the
// TUI decides which harness to use and the walk controller does the rest.

import type { CommandContext } from "./context"

/** What a /walk argument asks for. The harness is opencode unless named. */
export interface WalkRequest {
  /** An explicit harness. Only opencode takes a model on the command line. */
  harness?: "opencode"
  /** Use this model for this walk instead of opencode's saved pin. */
  model?: string
  /** Fork this session instead of the project's newest. */
  sessionId?: string
  /** Start without author context. */
  fresh?: boolean
}

/**
 * `/walk` with no argument forks the newest session; `fresh` starts clean;
 * `opencode [model]` names the harness and optionally overrides the model for
 * this walk; anything else is a session id. The override is not saved.
 */
export function parseWalkArg(arg: string): WalkRequest {
  const trimmed = arg.trim()
  if (trimmed === "") return {}
  const [first, ...rest] = trimmed.split(/\s+/)
  if (first === "opencode") {
    const model = rest.join(" ").trim()
    return model === "" ? { harness: "opencode" } : { harness: "opencode", model }
  }
  if (first === "fresh") return { fresh: true }
  return { sessionId: trimmed }
}

export function walkCommand(ctx: CommandContext): void {
  if (!ctx.hasProject()) {
    ctx.showError("Open a project first: /cd <name or path>")
    return
  }
  ctx.startWalk(ctx.args)
}
