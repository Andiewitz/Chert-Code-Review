// Generate the README command table from the same COMMAND_DEFS the TUI uses, so
// the CLI help, /help and the README cannot drift apart.
//
//   bun run scripts/gen-readme-commands.ts           rewrite the table
//   bun run scripts/gen-readme-commands.ts --check    fail if it is out of date

import { COMMAND_DEFS } from "../src/tui/commands/registry"

const START = "<!-- commands:start -->"
const END = "<!-- commands:end -->"
const README = "README.md"

/** README tables are generated here, so prettier must not re-align them. */
function escape(text: string): string {
  return text.replace(/\|/g, "\\|")
}

function table(): string {
  const usage = COMMAND_DEFS.map((def) => escape(def.usage))
  const width = Math.max(...usage.map((text) => text.length)) + 2
  const rows = COMMAND_DEFS.map(
    (def) => `| ${escape(def.usage).padEnd(width)}| ${def.description.padEnd(45)}|`,
  )
  const header = `| ${"command".padEnd(width)}| ${"what it does".padEnd(45)}|`
  const rule = `| ${"-".repeat(width)}| ${"-".repeat(45)}|`
  return [START, header, rule, ...rows, END].join("\n")
}

const readme = await Bun.file(README).text()
const start = readme.indexOf(START)
const end = readme.indexOf(END)
if (start === -1 || end === -1) {
  console.error(`README.md is missing ${START} / ${END}`)
  process.exit(1)
}
const expected = table()
const updated = readme.slice(0, start) + expected + readme.slice(end + END.length)

if (process.argv.includes("--check")) {
  if (updated !== readme) {
    console.error("README.md command table is out of date; run: bun run gen:readme")
    process.exit(1)
  }
  console.log("README command table is up to date")
} else {
  await Bun.write(README, updated)
  console.log("README command table updated")
}
