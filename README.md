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
bun dev --help     # CLI help
```

Keys inside the TUI:

- `up` / `down` — pick a file (the diff pane loads lazily per file)
- `r` — re-scan the working tree and reload all diffs
- `q` or `Esc` — quit (`Ctrl+C` also works)

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
