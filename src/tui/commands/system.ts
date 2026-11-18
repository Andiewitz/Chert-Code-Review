// System commands: help, the menu, shell escapes, theme switching and quit.

import { MAX_COMMAND_OUTPUT_LINES } from "../../limits"
import { tailLines } from "../../text"
import { THEME_LABELS, setTheme } from "../theme"
import type { ThemeName } from "../theme"
import type { CommandContext } from "./context"
import { HELP_TEXT } from "./registry"

const THEME_ALIASES: Record<string, ThemeName> = {
  default: "default",
  dark: "dark-contrast",
  "dark-contrast": "dark-contrast",
  contrast: "dark-contrast",
  white: "whiteout",
  whiteout: "whiteout",
  light: "whiteout",
  github: "github",
  gh: "github",
}

export function helpCommand(ctx: CommandContext): void {
  ctx.addEntry("system", HELP_TEXT)
  ctx.setView("log")
}

export function homeCommand(ctx: CommandContext): void {
  ctx.openMenu()
}

/** /run <command>: run a shell command in the current project. */
export function runShellCommand(ctx: CommandContext): void {
  const command = ctx.args
  if (command === "") {
    ctx.addEntry("error", "usage: /run <command>")
    ctx.setView("log")
    return
  }
  ctx.setView("log")
  ctx.addEntry("user", `/run ${command}`)
  try {
    const argv = process.platform === "win32" ? ["cmd.exe", "/c", command] : ["sh", "-c", command]
    const proc = Bun.spawnSync(argv, { cwd: ctx.projectRoot(), stdout: "pipe", stderr: "pipe" })
    const stdout = proc.stdout.toString().trimEnd()
    const stderr = proc.stderr.toString().trimEnd()
    const combined = `${stdout}${stderr !== "" ? `\n${stderr}` : ""}`.trim()
    ctx.addEntry(
      proc.exitCode === 0 ? "system" : "error",
      combined === "" ? "(no output)" : tailLines(combined, MAX_COMMAND_OUTPUT_LINES),
    )
    ctx.setStatus(proc.exitCode === 0 ? `✓ /run ${command}` : `✗ /run exited with ${proc.exitCode}`)
  } catch (error) {
    ctx.addEntry("error", error instanceof Error ? error.message : String(error))
  }
}

/** /themes: with no argument, drop the list under the prompt; else switch. */
export function themesCommand(ctx: CommandContext): void {
  const arg = ctx.args.trim().toLowerCase()
  if (arg === "") {
    ctx.setPromptValue("/themes ")
    return
  }
  const resolved = THEME_ALIASES[arg]
  if (!resolved) {
    ctx.addEntry("error", `unknown theme "${ctx.args}" — try: default, dark-contrast, whiteout, github`)
    return
  }
  setTheme(resolved)
  ctx.addEntry("system", `theme: ${THEME_LABELS[resolved]}`)
  ctx.setStatus(`theme: ${THEME_LABELS[resolved]}`)
}

export function quitCommand(ctx: CommandContext): void {
  ctx.quit()
}
