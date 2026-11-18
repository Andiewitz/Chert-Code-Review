#!/usr/bin/env bun

import { VERSION } from "./version"
import { tryOr } from "./best-effort"
import { COMMAND_DEFS } from "./tui/commands/registry"

function printHelp(): void {
  console.log(`chert v${VERSION}

Review the local changes in a git repository — no network needed.

Usage: chert [path]

  path            a project folder or any subfolder of it (default: the current folder)

Commands:
  (default)       open the review TUI
  tui [path]      same thing, spelled out

Keys inside the TUI: ↑↓ files · ←→ action · Enter run · Space reviewed ·
  h highlight · Esc menu · Ctrl+C quit. Type / for commands.

Slash commands:
${COMMAND_DEFS.map((def) => `  ${def.usage.padEnd(58)}${def.description}`).join("\n")}`)
}

async function launchTui(startDir?: string): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error("chert needs an interactive terminal (TTY) to open the review UI.")
    process.exit(1)
  }
  // Register the Solid TSX transform for runtime loading (replaces bunfig preload,
  // which is not compatible with compiled executables).
  const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin")
  ensureSolidTransformPlugin()
  const { launch } = await import("./tui/app.tsx")
  await launch(startDir)
}

function isFlagOrKnownCommand(arg: string): boolean {
  return arg === "tui" || arg === "-h" || arg === "--help" || arg === "-v" || arg === "--version"
}

const args = Bun.argv.slice(2)
const [command, ...rest] = args

switch (command) {
  case undefined: {
    await launchTui()
    break
  }
  case "tui": {
    await launchTui(rest[0])
    break
  }
  case "-h":
  case "--help": {
    printHelp()
    break
  }
  case "-v":
  case "--version": {
    console.log(VERSION)
    break
  }
  default: {
    if (!isFlagOrKnownCommand(command)) {
      const { statSync } = await import("node:fs")
      const { expandPath } = await import("./projects.ts")
      const isFolder = tryOr(() => statSync(expandPath(command)).isDirectory(), false)
      if (isFolder) {
        await launchTui(command)
        break
      }
    }
    console.error(`no such folder or command: ${command}`)
    printHelp()
    process.exit(1)
  }
}
