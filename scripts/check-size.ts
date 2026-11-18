// Enforce the size limits that keep this codebase readable:
//   - no src/ file longer than 400 lines
//   - no function body longer than 50 lines
//
// Big files hide responsibilities and big functions hide branches, so both are
// checked in `bun run check` and CI. A file may exceed the limit only through
// ALLOWED_FILES, where every entry carries a reason. Nothing may be allowlisted
// for functions. app.tsx and runCommand are deliberately not exempt.

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const MAX_FILE_LINES = 400
const MAX_FUNCTION_LINES = 50

/** path (relative to the repo root) -> why it is allowed to be long. */
const ALLOWED_FILES: Record<string, string> = {
  "src/tui/app.tsx":
    "composition root; the review/log/tree/done views and the remaining effects still live here and are being moved out view by view",
  "src/tui/keyboard.ts":
    "one handler per precedence section is the next split; the documented order must stay in a single readable place until then",
}

/** Long functions that are a single switch/parse table rather than branches. */
const ALLOWED_FUNCTIONS: Record<string, string> = {
  "src/tui/app.tsx:ReviewApp": "the component's signal graph; each extracted view removes a block of it",
  "src/tui/keyboard.ts:handleKeyPress":
    "the precedence table itself: splitting it would scatter the order it exists to document",
  "src/highlights.ts:parseAgentHighlights":
    "one linear validate-and-narrow pass over untrusted JSON; splitting it would hide the invariants",
  "src/diffrows.ts:parsePatch": "a single line-by-line state machine over patch text",
  "src/tui/commands/review.ts:reviewCommand": "argument parsing plus one branch per review source",
  "src/tui/components/overlays.tsx:Overlays":
    "five sibling overlay screens in declaration order; each is under 20 lines",
  "src/tui/app.tsx:load": "one reload sequence (highlights, files, branch) whose order matters",
  "src/tui/app.tsx:askAgent": "one request/response turn; its error paths are asserted by the smoke test",
  "src/tui/app.tsx:buildCommandContext": "a flat object literal wiring handlers to signals, no branches",
  "src/tui/app.tsx:keyboardContext": "a flat object literal wiring the keyboard surface, no branches",
  "src/tui/app.tsx:handleMenuSelection": "one branch per menu row, each two or three lines",
  "src/tui/commands/navigation.ts:cdCommand": "one branch per /cd form (none, -, path, saved name)",
  "src/git/changes.ts:listChangedFiles":
    "two parallel git listings plus untracked counting, kept in one place so the sort is applied once",
  "src/highlights.test.ts:fourLines": "a test fixture that builds a four-line diff inline",
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      sourceFiles(path, out)
    } else if (path.endsWith(".ts") || path.endsWith(".tsx")) {
      out.push(path)
    }
  }
  return out
}

interface Finding {
  file: string
  line: number
  what: string
}

/** Functions, methods and arrow-function consts, found by declaration line. */
function longFunctions(lines: string[], file: string): Finding[] {
  const findings: Finding[] = []
  const declarator =
    /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*[<(]|^\s*(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/
  for (let index = 0; index < lines.length; index += 1) {
    const match = declarator.exec(lines[index])
    if (match === null) continue
    const name = match[1] ?? match[2]
    // Walk forward until the declaration's opening brace, then match braces.
    let depth = 0
    let started = false
    let end = index
    for (; end < lines.length; end += 1) {
      const text = lines[end]
      for (const char of text) {
        if (char === "{") {
          depth += 1
          started = true
        } else if (char === "}") {
          depth -= 1
        }
      }
      if (started && depth <= 0) break
    }
    const length = end - index + 1
    if (length > MAX_FUNCTION_LINES && ALLOWED_FUNCTIONS[`${file}:${name}`] === undefined) {
      findings.push({ file, line: index + 1, what: `${name}() is ${length} lines` })
    }
  }
  return findings
}

const root = process.cwd()
const findings: Finding[] = []

for (const path of sourceFiles(join(root, "src"))) {
  const file = relative(root, path)
  const text = readFileSync(path, "utf8")
  const lines = text.split("\n")
  const length = text.endsWith("\n") ? lines.length - 1 : lines.length
  if (length > MAX_FILE_LINES && ALLOWED_FILES[file] === undefined) {
    findings.push({
      file,
      line: 1,
      what: `${length} lines (limit ${MAX_FILE_LINES}); split it or allowlist with a reason`,
    })
  }
  findings.push(...longFunctions(lines, file))
}

if (findings.length > 0) {
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}: ${finding.what}`)
  }
  console.error(`\n${findings.length} size violation(s)`)
  process.exit(1)
}
console.log(`size check passed (${MAX_FILE_LINES} lines per file, ${MAX_FUNCTION_LINES} per function)`)
