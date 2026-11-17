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

No modes: if the prompt box is empty, keys control the screen; if it has text,
typing and Enter go to the text.

Review screen (the action bar at the bottom is always visible):

| key | action |
|---|---|
| `Up` / `Down` | previous / next file |
| `Left` / `Right` | move across the action bar: Back · Is it slow? · Is it messy? · Is it safe? · Next |
| `Enter` | run the highlighted action |
| `Space` | mark the file reviewed |
| `h` | highlight mode: `↑↓` moves the line cursor, `Enter` selects a line or range, `Esc` leaves |
| `PgUp` / `PgDn` | scroll the answer pane (when open) or the diff |
| `Esc` | open the menu (or close it) |
| `Ctrl+C` | quit |

Home screen / recent projects (the start screen when you launch outside a git repo,
and Esc → Recent projects): the purple `chert` wordmark, then your recent projects.
The highlighted row is bold and accented; `Up`/`Down` moves it, `Enter` opens it.

| key | action |
|---|---|
| `Up` / `Down` | choose a project |
| `Enter` | open the highlighted project (or a typed path) |
| `Delete` | remove a recent project from the list (files untouched) |
| `Esc` | go back (only if a project is already open) |
| `Ctrl+C` | quit |

Done screen and menus: `Up`/`Down` choose, `Enter` go, `Esc` close.

Other:
- `Enter` in the tree — open the selected file's diff in the review view
- `/cd <name or path>` — switch to a saved or new project
- `/cd` — list saved projects
- `/cd -` — return to the previous project
- `/projects` — list saved projects
- `/forget <name or path>` — remove a saved project (files untouched)
- `Ctrl+C` — quit (`/quit` also works)

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
/cd <name or path> switch to a saved or new project
/projects          list saved projects
/forget <name>     remove a saved project
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
