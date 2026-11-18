// The slash-command registry: names, aliases, usage text, help output and the
// fuzzy/prefix matching used by the suggestion list and autocorrect. Pure, so it
// is unit-testable without a renderer.

export interface CommandDef {
  name: string
  aliases?: string[]
  usage: string
  description: string
  /** Commands that take an argument insert a trailing space when accepted. */
  takesArg?: boolean
}

/** One row in the suggestion list under the prompt. */
export interface Suggestion {
  key: string
  label: string
  description: string
  insert: string
}

export const COMMAND_DEFS: CommandDef[] = [
  { name: "help", usage: "/help", description: "show this list" },
  { name: "home", usage: "/home", description: "open the menu" },
  { name: "refresh", usage: "/refresh", description: "re-scan the working tree" },
  { name: "open", usage: "/open <query>", description: "jump to a file (path match)", takesArg: true },
  {
    name: "run",
    usage: "/run <command>",
    description: "run a shell command in the current project",
    takesArg: true,
  },
  { name: "cd", usage: "/cd <name or path>", description: "switch project directory", takesArg: true },
  { name: "projects", usage: "/projects", description: "list saved projects" },
  { name: "forget", usage: "/forget <name or path>", description: "remove a saved project", takesArg: true },
  { name: "cwd", usage: "/cwd", description: "show the current project" },
  { name: "tree", usage: "/tree", description: "show the whole project tree" },
  { name: "log", usage: "/log", description: "show chat history" },
  {
    name: "highlights",
    usage: "/highlights [clear [yes]]",
    description: "list or clear highlights",
    takesArg: true,
  },
  { name: "export", usage: "/export", description: "export review notes to markdown" },
  {
    name: "review",
    usage: "/review [working|staged|branch [base]|last|commit <ref>]",
    description: "what to review",
    takesArg: true,
  },
  {
    name: "walk",
    usage: "/walk [session-id|fresh]",
    description: "guided review: an agent walks you through each file",
    takesArg: true,
  },
  {
    name: "connect",
    usage: "/connect [provider [key]]",
    description: "connector status / save a provider key",
    takesArg: true,
  },
  {
    name: "disconnect",
    usage: "/disconnect <provider>",
    description: "remove a saved provider key",
    takesArg: true,
  },
  {
    name: "use",
    usage: "/use <connector> [model]",
    description: "route plain-text prompts (opencode or a provider)",
    takesArg: true,
  },
  { name: "models", usage: "/models [provider]", description: "list a provider's models", takesArg: true },
  { name: "themes", usage: "/themes [name]", description: "list or switch color theme", takesArg: true },
  { name: "quit", aliases: ["exit", "q"], usage: "/quit", description: "exit chert (Ctrl+C also works)" },
]

function buildHelpText(): string {
  const pad = Math.max(...COMMAND_DEFS.map((c) => c.usage.length)) + 2
  return [
    "keys:",
    "  Up/Down     previous / next file",
    "  Left/Right  pick an action: Back · Next",
    "  Space       approve this file and move to the next unapproved one",
    "  Enter       run the picked action",
    "  Space       mark the file reviewed",
    "  h           highlight lines (↑↓ move, Enter select, Esc done)",
    "  PgUp/PgDn   scroll the diff, or the answer when it is open",
    "  Esc         menu · Ctrl+C quit",
    "  type a question and press Enter to ask",
    "",
    "commands:",
    ...COMMAND_DEFS.map((c) => `  ${c.usage.padEnd(pad)}${c.description}`),
    "connectors: opencode (default) · openrouter · gemini · groq · nim",
    "plain text (no /) goes to the active connector.",
  ].join("\n")
}

export const HELP_TEXT = buildHelpText()

export function resolveCommand(token: string): CommandDef | undefined {
  const t = token.toLowerCase()
  return COMMAND_DEFS.find((d) => d.name === t || d.aliases?.includes(t))
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i)
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0]
    dp[0] = j
    for (let i = 1; i <= a.length; i++) {
      const tmp = dp[i]
      dp[i] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[i], dp[i - 1])
      prev = tmp
    }
  }
  return dp[a.length]
}

export function closestCommand(token: string): CommandDef | undefined {
  const t = token.toLowerCase()
  let best: { def: CommandDef; d: number } | undefined
  for (const def of COMMAND_DEFS) {
    for (const cand of [def.name, ...(def.aliases ?? [])]) {
      const d = levenshtein(t, cand)
      if (best === undefined || d < best.d) best = { def, d }
    }
  }
  return best?.def
}

export function isCloseAutocorrect(token: string, def: CommandDef): boolean {
  const t = token.toLowerCase()
  const names = [def.name, ...(def.aliases ?? [])]
  const d = Math.min(...names.map((n) => levenshtein(t, n)))
  return d <= 1 || (d <= 2 && t.length >= 4 && names.some((n) => n.length >= 4))
}

export function scoreCommand(def: CommandDef, query: string): number {
  const q = query.toLowerCase()
  if (q === "") return 1
  let best = 0
  for (const name of [def.name, ...(def.aliases ?? [])]) {
    if (name === q) best = Math.max(best, 100)
    else if (name.startsWith(q)) best = Math.max(best, 80)
    else if (name.includes(q)) best = Math.max(best, 50)
  }
  return best
}

/** Map a command definition to its suggestion row. */
export function commandToSuggestion(def: CommandDef): Suggestion {
  const label = `/${def.name}${def.aliases?.length ? ` (${def.aliases.join(", ")})` : ""}`
  return {
    key: def.name,
    label,
    description: def.description,
    insert: `/${def.name}${def.takesArg ? " " : ""}`,
  }
}
