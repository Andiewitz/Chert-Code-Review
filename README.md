# chert

A code review CLI tool with a terminal UI, built with [Bun](https://bun.sh) and
[OpenTUI](https://opentui.com) (the same TUI stack [OpenCode](https://opencode.ai) uses:
a Zig-native renderer + SolidJS components).

## What it reviews

Local git state in the current directory — no network needed:

- working-tree changes vs `HEAD` (staged + unstaged, combined): added / modified / deleted
- untracked files (respects `.gitignore`), shown as synthesized all-added diffs

## Development

```sh
bun install        # install deps
bun dev            # open the review TUI (needs a real terminal)
bun dev [path]     # open the review TUI for a path/repo
bun dev --help     # CLI help
```

You can also run `chert [path]` to open the TUI directly in a specific project (or a subfolder inside a git repo; chert opens the repo root).

Keys inside the TUI:

The app starts in **prompt mode** (`>` row). Press `Esc` with an empty prompt to
enter **browse mode** (`· ` row); press `i` to return to prompt mode.

Prompt mode:

| key | action |
|---|---|
| `↑` / `↓` (empty prompt) | pick a file (review), move rows (tree), move (picker) |
| `Tab` | cycle review → tree → log (picker: back if a project is open) |
| `Enter` | submit prompt / open tree file / open picker project |
| `Esc` | clear input, or switch to browse mode when empty |
| `Ctrl+P` | command picker (all commands) |
| `/` | command suggestions (type to filter) |
| `Ctrl+C` | quit |

Browse mode:

| key | action |
|---|---|
| `j` / `↓` | next file / row |
| `k` / `↑` | previous file / row |
| `Space` / `PgDn` / `Ctrl+D` | scroll down (diff or answer pane) |
| `b` / `PgUp` / `Ctrl+U` | scroll up |
| `g` / `G` | top / bottom |
| `]` / `[` | next / previous diff hunk |
| `Tab` | cycle views |
| `Enter` | open file (tree) / open project (picker) / prompt mode (review) |
| `i` | prompt mode |
| `/` | prompt mode with `/` prefilled |
| `r` | refresh |
| `o` | open project picker |
| `a` / `A` | toggle answer pane / switch scroll target |
| `?` | help |
| `q` | quit |
| `Ctrl+C` | quit |

Other:
- `Enter` in the tree — open the selected file's diff in the review view
- `Enter` in the project picker — open the selected project
- `x` in the project picker — forget a selected recent project
- `Esc` in the project picker — go back to the previous view (if a project is open)

## The prompt

The `>` row at the bottom is the universal entry point (Claude Code-style):
`/` runs commands, plain text talks to the [opencode](https://opencode.ai) agent
in the current project directory (opencode must be installed; no API keys needed).

```
/help              command list
/refresh           re-scan the working tree
/open <query>      jump to a file
/run <command>     run a shell command in the current project
/cd <dir>          switch project directory (opens repo root)
/project           open the project picker
/project <path>    switch to a project (like /cd)
/cwd               show the current project
/tree              whole project tree (folders, nested files, M/D/?? marks)
```

## Connectors (bring your own model)

Plain-text prompts go to the opencode agent by default. `/connect` adds direct
provider support — all four use OpenAI-compatible APIs:

| provider | id | key env var | default model |
|---|---|---|---|
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | `openai/gpt-4o-mini` |
| Google Gemini | `gemini` | `GEMINI_API_KEY` | `gemini-2.5-flash` |
| Groq | `groq` | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |
| NVIDIA NIM | `nim` (alias `nvidia`) | `NVIDIA_API_KEY` | `meta/llama-3.3-70b-instruct` |

- `/connect` — status of every connector (key source, model, active)
- `/connect <id> <key>` — save a key to `~/.chert/connectors.json` (chmod 600),
  or just export the env var
- `/use <id> [model]` — route plain-text prompts to a provider; `/use opencode`
  switches back to the local CLI
- `/models <id>` — list a provider's models
- `/disconnect <id>` — remove a saved key

## Build a standalone executable

```sh
bun run build      # -> dist/chert (dist/chert.exe on Windows)
```

The build uses `@opentui/solid/bun-plugin` to transform Solid TSX (see `scripts/build.ts`).

## Install globally for testing

```sh
bun link           # exposes `chert` on your PATH
```

## Stack notes

- `@opentui/core` 0.9 — renderer, `<select>`, `<diff>`, `<code>`, `<scrollbox>` …
- `@opentui/solid` 0.9 + `solid-js` 1.9 — component layer
- `web-tree-sitter` 0.25.10 — required peer dep for syntax highlighting
- `typescript` pinned to 5.8.3: newer TS (5.9.x) stack-overflows on this JSX
  type graph
- `src/git.ts` (the data layer) is synchronous (`Bun.spawnSync`): git calls are
  fast, and sync state updates render deterministically regardless of the
  renderer's event loop
- `bunfig.toml` was removed on purpose: compiled executables break on bunfig
  preloads, so the Solid TSX transform is registered programmatically in
  `src/index.ts` instead (`ensureSolidTransformPlugin()`)
- `tsconfig.json` sets `jsxImportSource: "@opentui/solid"` and excludes
  `MCode/` (an unrelated Rust/Tauri project in this folder)

## Testing

```sh
bun run smoke      # headless end-to-end test: seeds a temp git repo, mounts the
                   # TUI, drives it with mock keys, asserts rendered frames
```
