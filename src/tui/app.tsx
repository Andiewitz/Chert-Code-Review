import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { render, useKeyboard, useRenderer } from "@opentui/solid"
import { extToFiletype, getTreeSitterClient } from "@opentui/core"
import type { InputRenderable, ScrollBoxRenderable, SelectOption, SelectRenderable } from "@opentui/core"
import { listChangedFiles, loadPatch } from "../git"
import type { ReviewFile } from "../git"
import { buildTreeLines } from "../tree"
import type { TreeLine } from "../tree"
import { opencodeAvailable, runAgent, tailLines } from "../agent"
import {
  PROVIDERS,
  chatCompletion,
  clearProviderKey,
  findProvider,
  getActive,
  keySource,
  listModels,
  resolveKey,
  saveProviderKey,
  setActive,
} from "../connectors"

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

// Claude Code-style frame: soft dark gray, hairline rules, a `>` prompt row
// and a dim hint footer. The prompt is the universal entry point: `/` runs
// commands, plain text goes to the opencode agent.
const COLORS = {
  bg: "#1e1e1e",
  rule: "#3a3a3a",
  dim: "#7a7a7a",
  text: "#d6d6d6",
  bright: "#ffffff",
  selectedBg: "#2e2e2e",
  accent: "#7aa2f7",
  danger: "#cc6666",
}

// git status --short style markers.
const STATUS_GLYPH: Record<ReviewFile["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  untracked: "??",
}

type EntryKind = "user" | "agent" | "system" | "error"

const ENTRY_FG: Record<EntryKind, string> = {
  user: COLORS.accent,
  agent: COLORS.text,
  system: COLORS.dim,
  error: COLORS.danger,
}

const HELP_TEXT = [
  "commands:",
  "  /help                        show this list",
  "  /refresh                     re-scan the working tree",
  "  /open <query>                jump to a file (path match)",
  "  /run <command>               run a shell command in the current project",
  "  /cd <dir>                    switch project directory",
  "  /cwd                         show the current project",
  "  /tree                        show the whole project tree",
  "  /connect [provider [key]]    connector status / save a provider key",
  "  /disconnect <provider>       remove a saved provider key",
  "  /use <connector> [model]     route plain-text prompts (opencode or a provider)",
  "  /models [provider]           list a provider's models",
  "  /quit                        exit chert (Ctrl+C also works)",
  "connectors: opencode (default) · openrouter · gemini · groq · nim",
  "plain text (no /) goes to the active connector.",
].join("\n")

export function ReviewApp() {
  const renderer = useRenderer()
  const [files, setFiles] = createSignal<ReviewFile[] | null>(null)
  const [loadError, setLoadError] = createSignal<string | null>(null)
  const [selected, setSelected] = createSignal(0)
  const [patch, setPatch] = createSignal("")
  const [treeLines, setTreeLines] = createSignal<TreeLine[]>([])
  const [treeIndex, setTreeIndex] = createSignal(0)
  const [view, setView] = createSignal<"review" | "tree" | "log">("review")
  const [transcript, setTranscript] = createSignal<Array<{ kind: EntryKind; text: string }>>([])
  const [status, setStatus] = createSignal("")
  const [cwd, setCwd] = createSignal(process.cwd())
  const [connector, setConnector] = createSignal(getActive().connector)
  const [model, setModel] = createSignal<string | undefined>(getActive().model)

  const activeLabel = createMemo(() => {
    const active = connector()
    if (active === "opencode") return "opencode"
    const provider = findProvider(active)
    return provider ? `${provider.id}/${model() ?? provider.defaultModel}` : active
  })

  const patchCache = new Map<string, string>()
  let patchFor = ""
  let selectRef: SelectRenderable | undefined
  let inputRef: InputRenderable | undefined
  let logRef: ScrollBoxRenderable | undefined
  let treeRef: ScrollBoxRenderable | undefined

  const file = createMemo(() => {
    const list = files()
    if (!list || list.length === 0) return undefined
    return list[Math.min(selected(), list.length - 1)]
  })

  function cwdBase(): string {
    const parts = cwd().split(/[\\/]/)
    return parts[parts.length - 1] || cwd()
  }

  function connectorsStatus(): string {
    const lines = [
      "connectors:",
      `  opencode     ${connector() === "opencode" ? "← active" : ""}  local opencode CLI (no key needed)`,
    ]
    for (const provider of PROVIDERS) {
      const source = keySource(provider.id)
      const isActive = connector() === provider.id
      const useModel = isActive ? model() ?? provider.defaultModel : provider.defaultModel
      lines.push(
        `  ${provider.id.padEnd(12)} ${source === undefined ? "✗ no key" : `✓ key: ${source}`}   ${provider.label} · ${useModel}${isActive ? "  ← active" : ""}`,
      )
    }
    lines.push("save a key: /connect <provider> <key>   ·   switch: /use <connector> [model]")
    return lines.join("\n")
  }

  function addEntry(kind: EntryKind, text: string): void {
    setTranscript((entries) => [...entries, { kind, text }])
  }

  function clearInput(): void {
    if (inputRef) inputRef.value = ""
  }

  // Synchronous loads: git is fast, and sync state updates render
  // deterministically regardless of the host renderer's event loop.
  function load(): void {
    setFiles(null)
    setLoadError(null)
    setPatch("")
    patchCache.clear()
    patchFor = ""
    setSelected(0)
    try {
      setFiles(listChangedFiles())
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
    selectFile(0)
    // Rebuild the tree in place when it's on screen (/refresh, /cd).
    if (view() === "tree") {
      try {
        setTreeLines(buildTreeLines(changedGlyphs()))
        setTreeIndex(0)
      } catch {
        // Leave the stale tree; /tree or Tab reloads it.
      }
    }
  }

  function selectFile(index: number): void {
    const list = files()
    if (!list || list.length === 0) return
    const i = Math.max(0, Math.min(index, list.length - 1))
    setSelected(i)
    selectRef?.setSelectedIndex(i)
    const current = list[i]
    if (patchFor === current.path) return
    const cached = patchCache.get(current.path)
    if (cached !== undefined) {
      setPatch(cached)
      patchFor = current.path
      return
    }
    try {
      const result = loadPatch(current)
      patchCache.set(current.path, result)
      setPatch(result)
      patchFor = current.path
    } catch (error) {
      setPatch(`Error loading diff for ${current.path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function navigate(delta: number): void {
    selectFile(selected() + delta)
  }

  function changedGlyphs(): Map<string, string> {
    const map = new Map<string, string>()
    for (const f of files() ?? []) map.set(f.path, STATUS_GLYPH[f.status])
    return map
  }

  function loadTree(): void {
    try {
      setTreeLines(buildTreeLines(changedGlyphs()))
      setTreeIndex(0)
      setView("tree")
    } catch (error) {
      addEntry("error", `tree failed: ${error instanceof Error ? error.message : String(error)}`)
      setView("log")
    }
  }

  function moveTreeIndex(delta: number): void {
    const lines = treeLines()
    if (lines.length === 0) return
    const next = Math.max(0, Math.min(treeIndex() + delta, lines.length - 1))
    if (next === treeIndex()) return
    setTreeIndex(next)
    // Keep the selection a few rows inside the viewport on tall trees.
    treeRef?.scrollTo({ x: 0, y: Math.max(0, next - 10) })
  }

  function openTreeSelection(): void {
    const line = treeLines()[treeIndex()]
    if (line === undefined || line.isDir || line.path === undefined) {
      setStatus("select a file in the tree")
      return
    }
    const list = files() ?? []
    const index = list.findIndex((f) => f.path === line.path)
    if (index === -1) {
      setStatus(loadError() !== null ? `no diff for ${line.path}` : `unchanged: ${line.path}`)
      return
    }
    setView("review")
    selectFile(index)
    setStatus(`→ ${line.path}`)
  }

  load()

  function submit(): void {
    const raw = (inputRef?.value ?? "").trim()
    if (raw === "") return
    clearInput()
    if (raw.startsWith("/")) {
      runCommand(raw.slice(1).trim())
    } else {
      void askAgent(raw)
    }
  }

  async function askAgent(prompt: string): Promise<void> {
    addEntry("user", prompt)
    setView("log")
    const active = connector()
    if (active === "opencode") {
      if (!opencodeAvailable()) {
        addEntry("error", "opencode CLI not found — install it (https://opencode.ai) or /connect a provider (openrouter, gemini, groq, nim)")
        setStatus("")
        return
      }
      setStatus("agent: thinking…")
      try {
        addEntry("agent", await runAgent(prompt, cwd()))
        setStatus("")
      } catch (error) {
        addEntry("error", error instanceof Error ? error.message : String(error))
        setStatus("agent: failed")
      }
      return
    }
    const provider = findProvider(active)
    if (!provider) {
      addEntry("error", `unknown connector "${active}"`)
      setStatus("")
      return
    }
    const key = resolveKey(provider.id)
    if (key === undefined) {
      addEntry("error", `no API key for ${provider.label} — /connect ${provider.id} <key> or set ${provider.envKeys[0]}`)
      setStatus("")
      return
    }
    const useModel = model() ?? provider.defaultModel
    setStatus(`${provider.id} ${useModel}: thinking…`)
    const system = `You are chert's code-review assistant. Current project directory: ${cwd()}. Locally changed files: ${(files() ?? []).map((f) => f.path).join(", ") || "none"}.`
    try {
      addEntry("agent", await chatCompletion(provider, key, useModel, system, prompt))
      setStatus("")
    } catch (error) {
      addEntry("error", error instanceof Error ? error.message : String(error))
      setStatus("agent: failed")
    }
  }

  function runCommand(line: string): void {
    if (line === "") {
      addEntry("system", HELP_TEXT)
      setView("log")
      return
    }
    const [name, ...restParts] = line.split(/\s+/)
    const rest = restParts.join(" ")
    switch (name) {
      case "help":
        addEntry("system", HELP_TEXT)
        setView("log")
        return
      case "refresh": {
        load()
        setStatus(`refreshed ${files()?.length ?? 0} files`)
        return
      }
      case "open": {
        const query = rest.toLowerCase()
        const list = files() ?? []
        const index = list.findIndex(
          (f) =>
            f.path.toLowerCase() === query ||
            f.path.toLowerCase().endsWith(query) ||
            f.path.toLowerCase().includes(query),
        )
        if (index === -1) {
          addEntry("error", `no file matching "${rest}"`)
          setView("log")
          return
        }
        setView("review")
        selectFile(index)
        setStatus(`→ ${list[index].path}`)
        return
      }
      case "run": {
        if (rest === "") {
          addEntry("error", "usage: /run <command>")
          setView("log")
          return
        }
        setView("log")
        addEntry("user", `/run ${rest}`)
        try {
          const argv = process.platform === "win32" ? ["cmd.exe", "/c", rest] : ["sh", "-c", rest]
          const proc = Bun.spawnSync(argv, { cwd: cwd(), stdout: "pipe", stderr: "pipe" })
          const stdout = proc.stdout.toString().trimEnd()
          const stderr = proc.stderr.toString().trimEnd()
          const combined = `${stdout}${stderr !== "" ? `\n${stderr}` : ""}`.trim()
          addEntry(proc.exitCode === 0 ? "system" : "error", combined === "" ? "(no output)" : tailLines(combined, 30))
          setStatus(proc.exitCode === 0 ? `✓ /run ${rest}` : `✗ /run exited with ${proc.exitCode}`)
        } catch (error) {
          addEntry("error", error instanceof Error ? error.message : String(error))
        }
        return
      }
      case "cd":
      case "project": {
        if (rest === "") {
          addEntry("system", `project: ${cwd()}`)
          setView("log")
          return
        }
        try {
          process.chdir(rest)
          setCwd(process.cwd())
          load()
          addEntry("system", `project: ${cwd()}`)
          setStatus("")
        } catch (error) {
          addEntry("error", `cd failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`)
        }
        return
      }
      case "cwd":
        addEntry("system", `project: ${cwd()}`)
        setView("log")
        return
      case "tree":
        loadTree()
        return
      case "connect": {
        setView("log")
        if (rest === "") {
          addEntry("system", connectorsStatus())
          return
        }
        const [providerToken, ...keyParts] = rest.split(/\s+/)
        const provider = findProvider(providerToken)
        if (!provider) {
          addEntry("error", `unknown provider "${providerToken}" — providers: ${PROVIDERS.map((p) => p.id).join(", ")}`)
          return
        }
        const key = keyParts.join(" ").trim()
        if (key === "") {
          const source = keySource(provider.id)
          addEntry(
            "system",
            [
              `${provider.label} (${provider.id})`,
              `  key: ${source === "saved" ? "saved" : source === "env" ? `env (${provider.envKeys.join(" or ")})` : "not configured"}`,
              `  default model: ${provider.defaultModel}`,
              `  get a key: ${provider.keyUrl}`,
              `  save it: /connect ${provider.id} <key>`,
            ].join("\n"),
          )
          return
        }
        try {
          saveProviderKey(provider.id, key)
          addEntry("system", `saved ${provider.label} key`)
          setStatus(`✓ ${provider.id} connected`)
        } catch (error) {
          addEntry("error", error instanceof Error ? error.message : String(error))
        }
        return
      }
      case "disconnect": {
        setView("log")
        const provider = findProvider(rest.trim())
        if (!provider) {
          addEntry("error", `unknown provider "${rest}" — providers: ${PROVIDERS.map((p) => p.id).join(", ")}`)
          return
        }
        try {
          clearProviderKey(provider.id)
          addEntry("system", `cleared saved key for ${provider.label} (env vars still apply)`)
          setStatus("")
        } catch (error) {
          addEntry("error", error instanceof Error ? error.message : String(error))
        }
        return
      }
      case "use": {
        const [id, ...modelParts] = rest.split(/\s+/)
        if (id === "" || id === "opencode") {
          setConnector("opencode")
          setModel(undefined)
          setActive("opencode")
          setStatus("connector: opencode")
          return
        }
        setView("log")
        const provider = findProvider(id)
        if (!provider) {
          addEntry("error", `unknown connector "${id}" — connectors: opencode, ${PROVIDERS.map((p) => p.id).join(", ")}`)
          return
        }
        if (resolveKey(provider.id) === undefined) {
          addEntry("error", `no API key for ${provider.label} — /connect ${provider.id} <key> first`)
          return
        }
        const newModel = modelParts.join(" ").trim()
        setConnector(provider.id)
        setModel(newModel === "" ? undefined : newModel)
        setActive(provider.id, newModel === "" ? undefined : newModel)
        setStatus(`connector: ${activeLabel()}`)
        return
      }
      case "models": {
        const provider = findProvider(rest.trim()) ?? (connector() !== "opencode" ? findProvider(connector()) : undefined)
        if (!provider) {
          addEntry("error", `usage: /models <provider> — providers: ${PROVIDERS.map((p) => p.id).join(", ")}`)
          setView("log")
          return
        }
        const key = resolveKey(provider.id)
        if (key === undefined) {
          addEntry("error", `no API key for ${provider.label} — /connect ${provider.id} <key> first`)
          setView("log")
          return
        }
        setView("log")
        setStatus(`${provider.id}: listing models…`)
        void listModels(provider, key)
          .then((ids) => {
            addEntry("system", ids.length === 0 ? `${provider.label}: no models` : `${provider.label} models:\n${tailLines(ids.join("\n"), 30)}`)
            setStatus("")
          })
          .catch((error) => {
            addEntry("error", error instanceof Error ? error.message : String(error))
            setStatus("")
          })
        return
      }
      case "quit":
      case "exit":
      case "q":
        renderer.destroy()
        process.exit(0)
        return
      default:
        addEntry("error", `unknown command /${name} — try /help`)
        setView("log")
    }
  }

  // The prompt input owns keyboard focus. Global handlers run before
  // renderable handlers, so we preventDefault the keys we want for ourselves
  // and let every printable character flow into the input untouched.
  useKeyboard((key) => {
    if (key.name === "return" || key.name === "enter") {
      key.preventDefault()
      if (view() === "tree" && (inputRef?.value ?? "") === "") {
        openTreeSelection()
        return
      }
      submit()
      return
    }
    if (key.name === "tab") {
      key.preventDefault()
      // Cycle: review → tree → log → review.
      const next = view() === "review" ? "tree" : view() === "tree" ? "log" : "review"
      if (next === "tree") loadTree()
      else setView(next)
      return
    }
    if ((key.name === "up" || key.name === "down") && (inputRef?.value ?? "") === "") {
      if (view() === "tree") {
        key.preventDefault()
        moveTreeIndex(key.name === "up" ? -1 : 1)
        return
      }
      if (view() === "review") {
        key.preventDefault()
        navigate(key.name === "up" ? -1 : 1)
        return
      }
    }
    if (key.name === "escape" && (inputRef?.value ?? "") !== "") {
      clearInput()
    }
  })

  // Keep the log pinned to the bottom as entries arrive. Effects run under the
  // real renderer; headless tests rely on short transcripts instead.
  createEffect(() => {
    transcript()
    view()
    logRef?.scrollTo({ x: 0, y: Infinity })
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
      <box height={1} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1}>
        <text fg={COLORS.bright}>chert</text>
        <text fg={COLORS.dim}>{` · ${cwdBase()} · ${headerInfo()}`}</text>
        <box flexGrow={1} />
        <text fg={COLORS.dim}>{`[ ${activeLabel()} ]`}</text>
      </box>
      <box height={1} flexShrink={0} border={["bottom"]} borderColor={COLORS.rule} />

      <Show
        when={view() === "log"}
        fallback={
          <Show
            when={view() === "tree"}
            fallback={
              <box flexGrow={1} flexDirection="row">
                <select
                  ref={(el: SelectRenderable) => {
                    selectRef = el
                  }}
                  width="38%"
                  height="100%"
                  options={options()}
                  showDescription={true}
                  showScrollIndicator={true}
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
                  <Show when={!loadError()} fallback={<text fg={COLORS.danger}>{` ${loadError()}`}</text>}>
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
            }
          >
            <scrollbox
              ref={(el: ScrollBoxRenderable) => (treeRef = el)}
              flexGrow={1}
              backgroundColor={COLORS.bg}
              paddingLeft={1}
            >
              <For each={treeLines()}>
                {(line, index) => (
                  <text fg={index() === treeIndex() ? COLORS.bright : line.isDir ? COLORS.dim : COLORS.text}>
                    {`${index() === treeIndex() ? "▸ " : "  "}${line.text}`}
                  </text>
                )}
              </For>
            </scrollbox>
          </Show>
        }
      >
        <scrollbox
          ref={(el: ScrollBoxRenderable) => (logRef = el)}
          flexGrow={1}
          backgroundColor={COLORS.bg}
          paddingLeft={1}
        >
          <For each={transcript()}>
            {(entry) => (
              <For each={entry.text.split("\n")}>
                {(line) => <text fg={ENTRY_FG[entry.kind]}>{line === "" ? " " : line}</text>}
              </For>
            )}
          </For>
        </scrollbox>
      </Show>

      <box height={1} flexShrink={0} border={["top"]} borderColor={COLORS.rule} />
      <box height={1} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1}>
        <text fg={COLORS.bright}>{"> "}</text>
        <input
          ref={(el: InputRenderable) => {
            inputRef = el
            // The prompt owns keyboard focus for the app's lifetime; OpenTUI
            // ignores the `focused` JSX prop, so focus it directly.
            el.focus()
          }}
          flexGrow={1}
          backgroundColor={COLORS.bg}
          focusedBackgroundColor={COLORS.bg}
          textColor={COLORS.bright}
          focusedTextColor={COLORS.bright}
          placeholder="type / for commands, or ask the agent…"
          placeholderColor={COLORS.dim}
        />
      </box>
      <box height={1} flexShrink={0} border={["bottom"]} borderColor={COLORS.rule} />
      <box height={1} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1}>
        <text fg={COLORS.dim}>{"↑↓ select · / commands · Tab review/tree/log · Ctrl+C quit"}</text>
        <box flexGrow={1} />
        <Show when={status() !== ""}>
          <text fg={COLORS.dim}>{status()}</text>
        </Show>
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
