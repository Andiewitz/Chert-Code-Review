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
bun run check      # typecheck + unit tests + headless TUI smoke test
```

You can also run `chert [path]` to open the TUI directly in a specific project (or a subfolder inside a git repo; chert opens the repo root).

Keys inside the TUI:

No modes: if the prompt box is empty, keys control the screen; if it has text,
typing and Enter go to the text.

Review screen (the files and diff fill the top; the agent's five-line answer band, the prompt and the action bar sit at the bottom):

| key              | action                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `Up` / `Down`    | previous / next file                                                                      |
| `Left` / `Right` | move across the action bar: Back · Next                                                   |
| `Enter`          | run the highlighted action                                                                |
| `Space`          | mark the file reviewed                                                                    |
| drag (mouse)     | highlight the lines you drag over; click a highlighted line to edit, ask or dismiss       |
| `PgUp` / `PgDn`  | scroll the answer pane (when open) or the diff                                            |
| `Esc`            | open the menu (or close it)                                                               |
| `Ctrl+C`         | quit                                                                                      |

Home screen / recent projects (the start screen when you launch outside a git repo,
and Esc → Recent projects): the purple `chert` wordmark, then your recent projects.
The highlighted row is bold and accented; `Up`/`Down` moves it, `Enter` opens it.

| key           | action                                                  |
| ------------- | ------------------------------------------------------- |
| `Up` / `Down` | choose a project                                        |
| `Enter`       | open the highlighted project (or a typed path)          |
| `Delete`      | remove a recent project from the list (files untouched) |
| `Esc`         | go back (only if a project is already open)             |
| `Ctrl+C`      | quit                                                    |

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
<!-- commands:start -->
| command                                                       | what it does                                 |
| --------------------------------------------------------------| ---------------------------------------------|
| /help                                                         | show this list                               |
| /home                                                         | open the menu                                |
| /refresh                                                      | re-scan the working tree                     |
| /open <query>                                                 | jump to a file (path match)                  |
| /run <command>                                                | run a shell command in the current project   |
| /cd <name or path>                                            | switch project directory                     |
| /projects                                                     | list saved projects                          |
| /forget <name or path>                                        | remove a saved project                       |
| /cwd                                                          | show the current project                     |
| /tree                                                         | show the whole project tree                  |
| /log                                                          | show chat history                            |
| /highlights [clear [yes]]                                     | list or clear highlights                     |
| /export                                                       | export review notes to markdown              |
| /review [working\|staged\|branch [base]\|last\|commit <ref>]  | what to review                               |
| /walk [session-id\|fresh]                                     | guided review: an agent walks you through each file|
| /connect [provider [key]]                                     | connector status / save a provider key       |
| /disconnect <provider>                                        | remove a saved provider key                  |
| /use <connector> [model]                                      | route plain-text prompts (opencode or a provider)|
| /models [provider]                                            | list a provider's models                     |
| /themes [name]                                                | list or switch color theme                   |
| /quit                                                         | exit chert (Ctrl+C also works)               |
<!-- commands:end -->
```

## Where state lives

chert never writes to the repository it reviews; everything it saves is outside
the working tree:

| path                             | contents                                      |
| -------------------------------- | --------------------------------------------- |
| `~/.chert/projects.json`         | recent projects                               |
| `~/.chert/theme.json`            | the last theme you picked                     |
| `~/.chert/review-sources.json`   | last review source per project                |
| `~/.chert/connectors.json`       | active connector and saved keys (mode `0600`) |
| `<gitdir>/chert/highlights.json` | highlights per commit                         |

All of them honour `CHERT_CONFIG_DIR` for the `~/.chert` directory, which is how
the tests stay hermetic.

Writes are atomic (temp file + rename), so a crash cannot leave a truncated file.

## Connectors (bring your own model)

Plain-text prompts go to the opencode agent by default. `/connect` adds direct
provider support — all four use OpenAI-compatible APIs:

| provider      | id                     | key env var          | default model                 |
| ------------- | ---------------------- | -------------------- | ----------------------------- |
| OpenRouter    | `openrouter`           | `OPENROUTER_API_KEY` | `openai/gpt-4o-mini`          |
| Google Gemini | `gemini`               | `GEMINI_API_KEY`     | `gemini-2.5-flash`            |
| Groq          | `groq`                 | `GROQ_API_KEY`       | `llama-3.3-70b-versatile`     |
| NVIDIA NIM    | `nim` (alias `nvidia`) | `NVIDIA_API_KEY`     | `meta/llama-3.3-70b-instruct` |

- `/connect` — status of every connector (key source, model, active)
- `/connect <id> <key>` — save a key to `~/.chert/connectors.json` (chmod 600),
  or just export the env var
- `/use <id> [model]` — route plain-text prompts to a provider; `/use opencode`
  switches back to the local CLI
- `/models <id>` — list a provider's models
- `/themes [name]` — list or switch color theme (default, dark-contrast, whiteout, github)
- `/home` — open the menu
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
- `tsconfig.json` sets `jsxImportSource: "@opentui/solid"`

## Testing

```sh
bun run smoke      # headless end-to-end test: seeds a temp git repo, mounts the
                   # TUI, drives it with mock keys, asserts rendered frames
bun test           # unit tests (git layer, highlights, config, dial rows, projects)
bun run typecheck  # tsc --noEmit
```

Formatting is Prettier (`bun run format`); `.git-blame-ignore-revs` keeps the
formatting commit out of `git blame`.
