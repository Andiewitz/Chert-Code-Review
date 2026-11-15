#!/usr/bin/env bun

const VERSION = "0.1.0";

function printHelp(): void {
  console.log(`chert v${VERSION}

Usage: chert [command] [options]

Commands:
  (default)       Open the review TUI
  greet [name]    Say hello (example command, replace me)

Options:
  -h, --help      Show this help message
  -v, --version   Show version`);
}

async function launchTui(): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error("chert needs an interactive terminal (TTY) to open the review UI.");
    process.exit(1);
  }
  // Register the Solid TSX transform for runtime loading (replaces bunfig preload,
  // which is not compatible with compiled executables).
  const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin");
  ensureSolidTransformPlugin();
  const { launch } = await import("./tui/app.tsx");
  await launch();
}

const args = Bun.argv.slice(2);
const [command, ...rest] = args;

switch (command) {
  case undefined:
  case "tui": {
    await launchTui();
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
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }
}
