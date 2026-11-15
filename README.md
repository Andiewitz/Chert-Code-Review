# chert

A code review CLI tool with a terminal UI, built with [Bun](https://bun.sh) and
[OpenTUI](https://opentui.com) (the same TUI stack [OpenCode](https://opencode.ai) uses:
a Zig-native renderer + SolidJS components).

## Development

```sh
bun install        # install deps
bun dev            # open the review TUI (needs a real terminal)
bun dev --help     # CLI help
```

Inside the TUI: `up/down` to pick a file, `q` or `Esc` to quit, `Ctrl+C` also quits.

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
- `bunfig.toml` was removed on purpose: compiled executables break on bunfig
  preloads, so the Solid TSX transform is registered programmatically in
  `src/index.ts` instead (`ensureSolidTransformPlugin()`)
- `tsconfig.json` sets `jsxImportSource: "@opentui/solid"`

## Testing

```sh
bun run smoke      # headless render test: mounts the TUI, asserts the frame
```
