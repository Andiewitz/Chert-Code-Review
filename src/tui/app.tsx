import { createMemo, createSignal, Show } from "solid-js"
import { render, useKeyboard, useRenderer } from "@opentui/solid"
import { extToFiletype, getTreeSitterClient } from "@opentui/core"
import type { SelectOption, SelectRenderable } from "@opentui/core"
import { listChangedFiles, loadPatch } from "../git"
import type { ReviewFile } from "../git"

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

// Black, monochrome, git-native: plain terminal look, no decorative chrome.
const COLORS = {
  bg: "#000000",
  rule: "#333333",
  dim: "#6b6b6b",
  text: "#b8b8b8",
  bright: "#ffffff",
  selectedBg: "#1a1a1a",
  danger: "#cc6666",
}

// git status --short style markers.
const STATUS_GLYPH: Record<ReviewFile["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  untracked: "??",
}

export function ReviewApp() {
  const renderer = useRenderer()
  const [files, setFiles] = createSignal<ReviewFile[] | null>(null)
  const [loadError, setLoadError] = createSignal<string | null>(null)
  const [selected, setSelected] = createSignal(0)
  const [patch, setPatch] = createSignal("")

  const patchCache = new Map<string, string>()
  let selectRef: SelectRenderable | undefined
  const file = createMemo(() => {
    const list = files()
    if (!list || list.length === 0) return undefined
    return list[Math.min(selected(), list.length - 1)]
  })

  // Synchronous loads: git is fast, and sync state updates render
  // deterministically regardless of the host renderer's event loop.
  function load(): void {
    setFiles(null)
    setLoadError(null)
    setPatch("")
    patchCache.clear()
    setSelected(0)
    try {
      setFiles(listChangedFiles())
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
    selectFile(selected())
  }

  load()

  function selectFile(index: number): void {
    setSelected(index)
    const current = file()
    if (!current) return
    const cached = patchCache.get(current.path)
    if (cached !== undefined) {
      setPatch(cached)
      return
    }
    try {
      const result = loadPatch(current)
      patchCache.set(current.path, result)
      setPatch(result)
    } catch (error) {
      setPatch(`Error loading diff for ${current.path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  useKeyboard((key) => {
    if (key.name === "q" || key.name === "escape") {
      renderer.destroy()
      process.exit(0)
    }
    if (key.name === "r") {
      load()
      selectFile(selected())
    }
  })

  const options = createMemo<SelectOption[]>(() =>
    (files() ?? []).map((f, index) => ({
      name: `${STATUS_GLYPH[f.status].padEnd(2)} ${f.path}`,
      description: `+${f.additions} -${f.deletions}`,
      value: index,
    })),
  )

  const headerInfo = createMemo(() => {
    const list = files()
    if (list === null) return "loading…"
    if (loadError()) return "error"
    return `${list.length} files`
  })

  const filetype = createMemo(() => {
    const path = file()?.path ?? ""
    return path === "" ? "" : extToFiletype(path.includes(".") ? path.slice(path.lastIndexOf(".")) : path)
  })

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={COLORS.bg}>
      <box height={1} flexShrink={0} flexDirection="row" paddingLeft={1}>
        <text fg={COLORS.bright}>chert</text>
        <text fg={COLORS.dim}>{` review  ${headerInfo()}`}</text>
      </box>

      <box height={1} flexShrink={0} border={["bottom"]} borderColor={COLORS.rule} />

      <box flexGrow={1} flexDirection="row">
        <select
          ref={(el: SelectRenderable) => {
            selectRef = el
            // `focused` JSX prop is not wired up in OpenTUI; focus the
            // renderable directly so it receives keyboard input. The ref
            // callback runs synchronously at element creation, which also
            // works under headless test renderers where effects are starved.
            el.focus()
          }}
          width="38%"
          height="100%"
          options={options()}
          showDescription={true}
          showScrollIndicator={true}
          onChange={(index) => selectFile(index)}
          backgroundColor={COLORS.bg}
          focusedBackgroundColor={COLORS.bg}
          textColor={COLORS.text}
          focusedTextColor={COLORS.bright}
          selectedBackgroundColor={COLORS.selectedBg}
          selectedTextColor={COLORS.bright}
          descriptionColor={COLORS.dim}
          selectedDescriptionColor={COLORS.dim}
        />

        <box flexGrow={1} height="100%" paddingLeft={1}>
          <Show
            when={!loadError()}
            fallback={<text fg={COLORS.danger}>{` ${loadError()}`}</text>}
          >
            <Show
              when={file()}
              fallback={<text fg={COLORS.dim}>{` ${files() === null ? "Loading changes…" : "No local changes"}`}</text>}
            >
              <diff
                width="100%"
                height="100%"
                diff={patch()}
                view="unified"
                filetype={filetype()}
                showLineNumbers={true}
              />
            </Show>
          </Show>
        </box>
      </box>

      <box height={1} flexShrink={0} paddingLeft={1}>
        <text fg={COLORS.dim}>{` up/down select  ·  r refresh  ·  q quit`}</text>
      </box>
    </box>
  )
}

export async function launch(): Promise<void> {
  // Initialize the tree-sitter client up front (before the render loop takes
  // over) so the diff pane can highlight. Failure is non-fatal: renderables
  // fall back to plain text.
  await getTreeSitterClient().initialize().catch(() => {})
  await render(() => <ReviewApp />, { exitOnCtrlC: true })
}
