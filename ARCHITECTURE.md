# Architecture

chert is a terminal code-review tool: it reads a local git diff, walks it file by
file, and lets you ask questions about it. It never writes to the repository it
reviews.

```
src/index.ts            CLI entry: argv, --help/--version, registers the Solid
                        TSX loader, then hands control to the TUI
src/tui/app.tsx         ReviewApp: the composition root — signals, effects,
                        command dispatch wiring, and the review screen JSX
src/tui/keyboard.ts     handleKeyPress(ctx, key): every keybinding, in a single
                        documented precedence order
src/tui/commands/       one module per command family + the command registry
src/tui/components/     presentational views (props are getters, never
                        destructured, so Solid reactivity survives)
src/tui/services/       the agent turn: prompt -> answer, plus its rendering
                        helpers
src/tui/theme.ts        colour palettes, attribute constants, theme persistence
src/tui/format.ts       string formatting shared by the views
```

Data layer (no renderer imports, unit-testable):

```
src/git.ts              every git invocation goes through run(), which enforces
                        the read-only allowlist; diff source resolution
src/diffrows.ts         patch text -> Row[] (hunks, line numbers, sides)
src/tree.ts             flat file list -> nested tree lines
src/highlights.ts       highlight model, resolution against a diff, caps,
                        persistence to <gitdir>/chert/highlights.json
src/projects.ts         recent projects, project roots, path display
src/connectors.ts       OpenAI-compatible providers, key resolution
src/config.ts           ~/.chert paths + atomic JSON read/write
src/limits.ts           every numeric cap in one place
src/text.ts             tailLines
src/best-effort.ts      bestEffort(label, fn): logged, non-fatal side effects
src/paths.ts            path helpers
src/version.ts          version read from package.json
```

## Invariants

- **Read-only git.** `git.ts run()` accepts a fixed allowlist of subcommands;
  nothing in the app may add a write-capable one. `chert` is a viewer.
- **No writes inside the reviewed repository.** Highlights live in the git
  directory (`<gitdir>/chert/`), everything else under `~/.chert/`
  (`CHERT_CONFIG_DIR` overrides it for tests).
- **Atomic persistence.** JSON goes through `writeJsonAtomic` (temp file +
  rename), so a crash never leaves a truncated file; key files are created with
  mode `0600`.
- **Behavior-preserving edits.** Keybindings, slash-command names, UI text and
  on-disk file names/formats are part of the interface.

## TUI conventions

- No mode variable: an empty prompt means keys drive the screen; text in the
  prompt means they edit the text.
- Overlay precedence is defined once, at the top of `src/tui/keyboard.ts`.
  Adding a key means placing it in that order, not at the end.
- Solid rules: signals and effects live inside the component (or a `createX`
  factory); props are read as `props.foo()`; `createEffect` dependencies and
  `onCleanup` are never dropped by a refactor.
- OpenTUI's renderer rejects whitespace-only JSX text between siblings, so
  component fragments keep their children on consecutive lines (no blank lines
  or `{/* */}` comments between them).

## Checks

`bun run typecheck`, `bun test`, `bun run smoke` (headless end-to-end TUI test
against a seeded temp repository), `bun run build` (single-file executable).
CI runs all four.
