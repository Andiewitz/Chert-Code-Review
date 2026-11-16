#!/usr/bin/env bun

const VERSION = "0.4.0";

function printHelp(): void {
  console.log(`chert v${VERSION}

Usage: chert [path] [command] [options]

Commands:
  (default)       Open the review TUI (optionally in [path])
  tui [path]      Open the review TUI (optionally in [path])
  greet [name]    Say hello (example command, replace me)

Options:
  -h, --help      Show this help message
  -v, --version   Show version`);
}

async function launchTui(startDir?: string): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error("chert needs an interactive terminal (TTY) to open the review UI.");
    process.exit(1);
  }
  // Register the Solid TSX transform for runtime loading (replaces bunfig preload,
  // which is not compatible with compiled executables).
  const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin");
  ensureSolidTransformPlugin();
  const { launch } = await import("./tui/app.tsx");
  await launch(startDir);
}

function isFlagOrKnownCommand(arg: string): boolean {
  return (
    arg === "tui" ||
    arg === "greet" ||
    arg === "-h" ||
    arg === "--help" ||
    arg === "-v" ||
    arg === "--version"
  );
}

const args = Bun.argv.slice(2);
const [command, ...rest] = args;

switch (command) {
  case undefined: {
    await launchTui();
    break;
  }
  case "tui": {
    await launchTui(rest[0]);
    break;
  }
  case "-h":
  case "--help": {
    printHelp();
    break;
  }
  case "-v":
  case "--version": {
    console.log(VERSION);
    break;
  }
  case "greet": {
    const name = rest[0] ?? "world";
    console.log(`Hello, ${name}!`);
    break;
  }
  default: {
    if (!isFlagOrKnownCommand(command)) {
      try {
        const { statSync } = await import("node:fs");
        const { expandPath } = await import("./projects.ts");
        const p = expandPath(command);
        if (statSync(p).isDirectory()) {
          await launchTui(command);
          break;
        }
      } catch {
        // fall through to error
      }
    }
    console.error(`no such folder or command: ${command}`);
    printHelp();
    process.exit(1);
  }
}
