// /walk starts the guided review: fork the author's harness session and let the
// agent narrate each changed file. The command only forwards the argument; the
// TUI decides which harness to use and the walk controller does the rest.

import type { CommandContext } from "./context"

export function walkCommand(ctx: CommandContext): void {
  if (!ctx.hasProject()) {
    ctx.showError("Open a project first: /cd <name or path>")
    return
  }
  ctx.startWalk(ctx.args)
}
