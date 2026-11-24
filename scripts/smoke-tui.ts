// Headless end-to-end smoke test:
//   1. seeds a temp git repo (base commit, then modify/delete/untrack files)
//   2. mounts the review TUI in memory against that repo
//   3. drives the prompt and navigation with mock keyboard input, asserting
//      rendered frames at each step
// Run with: bun run scripts/smoke-tui.ts
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tryOr } from "../src/best-effort"
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { getTreeSitterClient } from "@opentui/core"
import type { testRender } from "@opentui/solid"

ensureSolidTransformPlugin()

function runGit(cwd: string, args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], { cwd })
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`)
  }
}

/**
 * A fake `opencode` that answers a plain prompt the way `run --format json`
 * does: one JSON event per line, text inside `part.text`, joined with newlines.
 */
function fakeOpencodeScript(parts: string[]): string {
  const events = parts.map(
    (text) =>
      `  echo '${JSON.stringify({ type: "text", sessionID: "ses_fake", part: { type: "text", text } })}'`,
  )
  return [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "2.3.0"; exit 0; fi',
    'if [ "$1" = "run" ]; then',
    "  sleep 1",
    ...events,
    "  exit 0",
    "fi",
    "exit 0",
    "",
  ].join("\n")
}

/**
 * A stand-in for `opencode serve`. chert only asks it for `/global/health`, and
 * points every other call at the fake CLI on PATH.
 */
function startFakeOpencodeServer(): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      if (new URL(request.url).pathname === "/global/health") {
        return Response.json({ healthy: true, version: "2.3.0" })
      }
      return new Response("not found", { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

async function phase1Tests(): Promise<void> {
  const { expandPath, resolveProjectRoot, openProject } = await import("../src/projects.ts")

  const home = process.env.HOME ?? ""
  assert(expandPath("~/code-test-base", "/tmp") === join(home, "code-test-base"), "expandPath expands ~/")
  assert(expandPath("~", "/tmp") === home, "expandPath expands ~")
  assert(expandPath("sub/dir", "/base/path") === "/base/path/sub/dir", "expandPath resolves relative paths")
  assert(expandPath("/abs/path/.", "/tmp") === "/abs/path", "expandPath normalizes absolute paths")
  assert(expandPath("'~/quoted'", "/tmp") === join(home, "quoted"), "expandPath strips quotes")

  const missing = join(tmpdir(), `chert-missing-${Date.now()}-nope`)
  assert(resolveProjectRoot(missing) === undefined, "resolveProjectRoot returns undefined for missing dir")

  const nonRepo = mkdtempSync(join(tmpdir(), "chert-nonrepo-"))
  try {
    assert(resolveProjectRoot(nonRepo) === undefined, "resolveProjectRoot returns undefined for non-repo")
  } finally {
    rmSync(nonRepo, { recursive: true, force: true })
  }

  const repo = mkdtempSync(join(tmpdir(), "chert-phase1-"))
  const cfg = mkdtempSync(join(tmpdir(), "chert-phase1-cfg-"))
  const orig = process.cwd()
  const prevCfg = process.env.CHERT_CONFIG_DIR
  process.env.CHERT_CONFIG_DIR = cfg
  try {
    runGit(repo, ["init", "-b", "main"])
    runGit(repo, ["config", "user.email", "smoke@example.com"])
    runGit(repo, ["config", "user.name", "smoke"])
    mkdirSync(join(repo, "src"), { recursive: true })
    writeFileSync(join(repo, "src", "base.txt"), "base\n")
    runGit(repo, ["add", "."])
    runGit(repo, ["commit", "-m", "base"])

    assert(resolveProjectRoot(join(repo, "src")) === repo, "resolveProjectRoot from subfolder gives root")

    // Regression: start in subfolder, working changes + untracked; diffs must load from repo root.
    writeFileSync(join(repo, "src", "modified.ts"), "export const before = 1\n")
    runGit(repo, ["add", "src/modified.ts"])
    runGit(repo, ["commit", "-m", "add modified"])
    writeFileSync(join(repo, "src", "modified.ts"), "export const before = 1\nexport const addedByTest = 2\n")
    writeFileSync(join(repo, "src", "untracked-new.ts"), "export const brandNew = true\n")

    process.chdir(join(repo, "src"))
    const entered = openProject(join(repo, "src"))
    assert(entered === repo, "openProject from a subfolder returns the repo root")
    assert(process.cwd() === join(repo, "src"), "openProject leaves the process directory alone")

    const { testRender: render } = await import("@opentui/solid")
    const { ReviewApp } = await import("../src/tui/app.tsx")
    const setup = await render(ReviewApp, { width: 100, height: 30 })
    try {
      await setup.renderOnce()
      let frame = setup.captureCharFrame()
      assert(
        frame.includes("src/modified.ts") || frame.includes("src/untracked-new.ts"),
        "subfolder launch: a changed file path is shown",
      )
      // navigate to modified.ts if needed
      assert(
        frame.includes("addedByTest") || frame.includes("brandNew"),
        "subfolder launch: diff text is shown (not empty)",
      )
    } finally {
      await setup.dispose().catch(() => {})
    }
  } finally {
    process.chdir(orig)
    if (prevCfg === undefined) delete process.env.CHERT_CONFIG_DIR
    else process.env.CHERT_CONFIG_DIR = prevCfg
    rmSync(repo, { recursive: true, force: true })
    rmSync(cfg, { recursive: true, force: true })
  }
}

async function phase4Tests(): Promise<void> {
  if (process.platform === "win32") {
    console.log("phase4Tests skipped on win32")
    return
  }
  const repo = mkdtempSync(join(tmpdir(), "chert-phase4-"))
  const cfg = mkdtempSync(join(tmpdir(), "chert-phase4-cfg-"))
  const binDir = mkdtempSync(join(tmpdir(), "chert-phase4-bin-"))
  const orig = process.cwd()
  const prevCfg = process.env.CHERT_CONFIG_DIR
  const prevPath = process.env.PATH
  try {
    // fake opencode executable
    const script = join(binDir, "opencode")
    writeFileSync(script, fakeOpencodeScript(["answer line 1", "answer line 2", "answer line 3"]))
    const { chmodSync } = await import("node:fs")
    chmodSync(script, 0o755)

    // prepend to PATH BEFORE importing the app (harness detection caches)
    process.env.PATH = binDir + ":" + (process.env.PATH ?? "")
    process.env.CHERT_CONFIG_DIR = cfg

    runGit(repo, ["init", "-b", "main"])
    runGit(repo, ["config", "user.email", "smoke@example.com"])
    runGit(repo, ["config", "user.name", "smoke"])
    mkdirSync(join(repo, "src"), { recursive: true })
    writeFileSync(join(repo, "src", "modified.ts"), "export const before = 1\n")
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1\n")
    runGit(repo, ["add", "."])
    runGit(repo, ["commit", "-m", "base"])
    writeFileSync(join(repo, "src", "modified.ts"), "export const before = 1\nexport const addedByTest = 2\n")
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1\nexport const a2 = 2\n")

    process.chdir(repo)
    await getTreeSitterClient()
      .initialize()
      .catch(() => {})
    const { testRender: render } = await import("@opentui/solid")
    const { ReviewApp } = await import("../src/tui/app.tsx")
    const setup = await render(ReviewApp, { width: 100, height: 30 })
    try {
      await setup.renderOnce()
      let frame = setup.captureCharFrame()
      assert(frame.includes("a2") || frame.includes("addedByTest"), "phase4 diff text on screen initially")

      // ask by typing a question: the action bar has no preset question
      await setup.mockInput.pressKeys("look".split(""))
      await setup.renderOnce()
      await setup.mockInput.pressKey("RETURN")
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      assert(frame.includes("Thinking"), "phase4 shows thinking state in pane")
      assert(frame.includes("a2") || frame.includes("addedByTest"), "phase4 diff text stays on screen")
      // busy: submit another prompt -> rejected
      await setup.mockInput.pressKeys("again".split(""))
      await setup.renderOnce()
      await setup.mockInput.pressKey("RETURN")
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      assert(
        frame.includes("Still thinking about your last question."),
        "phase4 second prompt rejected while busy",
      )

      // wait for answer
      await new Promise((r) => setTimeout(r, 1500))
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      assert(
        frame.includes("a2") || frame.includes("addedByTest"),
        "phase4 diff text stays on screen after answer",
      )
      assert(frame.includes("answer line 1"), "phase4 answer text appears in pane")

      // PageDown scrolls the answer pane
      await setup.mockInput.pressKeys(["\u001B[6~"])
      await setup.renderOnce()
      assert(true, "phase4 PageDown does not crash")

      // Next resets highlight to Next and hides pane for a file with no answer
      await setup.mockInput.pressKey("RETURN")
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      assert(frame.includes("a.ts") || frame.includes("modified.ts"), "phase4 Next moves to next file")
      // pane should be hidden (no answer for new file)
      assert(!frame.includes("answer line 1"), "phase4 Next hides pane for file with no answer")
    } finally {
      await setup.dispose().catch(() => {})
    }
  } finally {
    process.chdir(orig)
    if (prevCfg === undefined) delete process.env.CHERT_CONFIG_DIR
    else process.env.CHERT_CONFIG_DIR = prevCfg
    if (prevPath === undefined) delete process.env.PATH
    else process.env.PATH = prevPath
    rmSync(repo, { recursive: true, force: true })
    rmSync(cfg, { recursive: true, force: true })
    rmSync(binDir, { recursive: true, force: true })
  }
}

async function phaseBTests(): Promise<void> {
  const projectsDir = mkdtempSync(join(tmpdir(), "chert-phaseb-"))
  const cfg = mkdtempSync(join(tmpdir(), "chert-phaseb-cfg-"))
  const orig = process.cwd()
  const prevCfg = process.env.CHERT_CONFIG_DIR
  process.env.CHERT_CONFIG_DIR = cfg
  try {
    const mkRepo = (name: string) => {
      const dir = join(projectsDir, name)
      mkdirSync(dir, { recursive: true })
      runGit(dir, ["init", "-b", "main"])
      runGit(dir, ["config", "user.email", "smoke@example.com"])
      runGit(dir, ["config", "user.name", "smoke"])
      writeFileSync(join(dir, "file.txt"), "x\n")
      runGit(dir, ["add", "."])
      runGit(dir, ["commit", "-m", "base"])
      writeFileSync(join(dir, "file.txt"), "x\nchanged\n")
      return dir
    }
    const alpha = mkRepo("alpha")
    const beta = mkRepo("beta")

    // empty start state: no project
    process.chdir(projectsDir)
    const { testRender: render } = await import("@opentui/solid")
    const { ReviewApp } = await import("../src/tui/app.tsx")
    const setup = await render(ReviewApp, { width: 100, height: 30 })
    try {
      await setup.renderOnce()
      let frame = setup.captureCharFrame()
      assert(frame.includes("Recent projects"), "phaseB empty start state")

      // /cd alpha opens it
      await setup.mockInput.pressKeys("/cd alpha".split(""))
      await setup.mockInput.pressKey("RETURN")
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      assert(frame.includes("opened alpha"), "phaseB /cd alpha opens")

      // /projects lists saved (alpha)
      await setup.mockInput.pressKeys("/projects".split(""))
      await setup.mockInput.pressKey("RETURN")
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      assert(frame.includes("alpha"), "phaseB /projects lists alpha")

      // /cd beta opens beta, /cd - returns to alpha
      await setup.mockInput.pressKeys(("/cd " + beta).split(""))
      await setup.mockInput.pressKey("RETURN")
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      assert(frame.includes("opened beta"), "phaseB /cd beta opens")
      await setup.mockInput.pressKeys("/cd -".split(""))
      await setup.mockInput.pressKey("RETURN")
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      assert(frame.includes("opened alpha"), "phaseB /cd - returns to previous")

      // bogus name
      await setup.mockInput.pressKeys("/cd nope-nope".split(""))
      await setup.mockInput.pressKey("RETURN")
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      assert(frame.includes("No project or folder called"), "phaseB bogus name error")
      assert(frame.includes("Files ("), "phaseB error stays on the review screen")
      await setup.mockInput.pressEscape()
      // A lone Esc is flushed by the input parser on its timer, not instantly.
      await new Promise((r) => setTimeout(r, 60))
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      assert(!frame.includes("No project or folder called"), "phaseB Esc dismisses the error")

      // /forget
      await setup.mockInput.pressKeys("/forget alpha".split(""))
      await setup.mockInput.pressKey("RETURN")
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      assert(frame.includes("removed from your list"), "phaseB /forget works")

      // /review opens the source picker as a drop-up over the review.
      await setup.mockInput.pressKeys("/review".split(""))
      await setup.mockInput.pressKey("RETURN")
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      assert(frame.includes("Review source"), "phaseB /review opens the picker")
      assert(frame.includes("Files ("), "phaseB picker floats over the review")
      await setup.mockInput.pressEscape()
      await new Promise((r) => setTimeout(r, 60))
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      assert(!frame.includes("Review source"), "phaseB Esc closes the review picker")

      // The menu's Recent projects row opens the same drop-up over the review.
      await setup.mockInput.pressEscape()
      await new Promise((r) => setTimeout(r, 60))
      await setup.renderOnce()
      await setup.mockInput.pressArrow("down")
      await setup.mockInput.pressArrow("down")
      await setup.mockInput.pressArrow("down")
      await setup.mockInput.pressKey("RETURN")
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      assert(frame.includes("Recent projects"), "phaseB Recent projects opens a drop-up")
      assert(frame.includes("Files ("), "phaseB projects float over the review")
      await setup.mockInput.pressEscape()
      await new Promise((r) => setTimeout(r, 60))
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      assert(!frame.includes("Recent projects"), "phaseB Esc closes the projects drop-up")
    } finally {
      await setup.dispose().catch(() => {})
    }
  } finally {
    process.chdir(orig)
    if (prevCfg === undefined) delete process.env.CHERT_CONFIG_DIR
    else process.env.CHERT_CONFIG_DIR = prevCfg
    rmSync(projectsDir, { recursive: true, force: true })
    rmSync(cfg, { recursive: true, force: true })
  }
}

async function phaseCTests(): Promise<void> {
  // allowlist test
  const { run } = await import("../src/git")
  const threw = tryOr(() => {
    run(process.cwd(), ["commit", "-m", "x"])
    return false
  }, true)
  assert(threw, "phaseC run(['commit']) throws")

  const repo = mkdtempSync(join(tmpdir(), "chert-phasec-"))
  const cfg = mkdtempSync(join(tmpdir(), "chert-phasec-cfg-"))
  const orig = process.cwd()
  const prevCfg = process.env.CHERT_CONFIG_DIR
  process.env.CHERT_CONFIG_DIR = cfg
  try {
    runGit(repo, ["init", "-b", "main"])
    runGit(repo, ["config", "user.email", "smoke@example.com"])
    runGit(repo, ["config", "user.name", "smoke"])
    writeFileSync(join(repo, "a.txt"), "one\n")
    runGit(repo, ["add", "."])
    runGit(repo, ["commit", "-m", "root commit"])
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n")
    // staged
    runGit(repo, ["add", "a.txt"])

    process.chdir(repo)
    await getTreeSitterClient()
      .initialize()
      .catch(() => {})
    const { testRender: render } = await import("@opentui/solid")
    const { ReviewApp } = await import("../src/tui/app.tsx")
    const setup = await render(ReviewApp, { width: 100, height: 30 })
    try {
      await setup.renderOnce()
      let frame = setup.captureCharFrame()
      assert(frame.includes("reviewing: uncommitted changes"), "phaseC default working source")

      // /review staged
      await setup.mockInput.pressKeys("/review staged".split(""))
      await setup.mockInput.pressKey("RETURN")
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      assert(frame.includes("reviewing: staged changes"), "phaseC /review staged")

      // /review last
      await setup.mockInput.pressKeys("/review last".split(""))
      await setup.mockInput.pressKey("RETURN")
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      assert(frame.includes("reviewing: commit"), "phaseC /review last")

      // /review working restores
      await setup.mockInput.pressKeys("/review working".split(""))
      await setup.mockInput.pressKey("RETURN")
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      assert(frame.includes("reviewing: uncommitted changes"), "phaseC /review working")

      // ref starting with - rejected
      await setup.mockInput.pressKeys("/review commit -foo".split(""))
      await setup.mockInput.pressKey("RETURN")
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      assert(frame.includes("Not a valid commit"), "phaseC bad ref rejected")
    } finally {
      await setup.dispose().catch(() => {})
    }
  } finally {
    process.chdir(orig)
    if (prevCfg === undefined) delete process.env.CHERT_CONFIG_DIR
    else process.env.CHERT_CONFIG_DIR = prevCfg
    rmSync(repo, { recursive: true, force: true })
    rmSync(cfg, { recursive: true, force: true })
  }
}

async function phaseETests(): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), "chert-phasee-"))
  const cfg = mkdtempSync(join(tmpdir(), "chert-phasee-cfg-"))
  const orig = process.cwd()
  const prevCfg = process.env.CHERT_CONFIG_DIR
  process.env.CHERT_CONFIG_DIR = cfg
  try {
    runGit(repo, ["init", "-b", "main"])
    runGit(repo, ["config", "user.email", "smoke@example.com"])
    runGit(repo, ["config", "user.name", "smoke"])
    mkdirSync(join(repo, "src"), { recursive: true })
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1\nexport const b = 2\n")
    runGit(repo, ["add", "."])
    runGit(repo, ["commit", "-m", "base"])
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1\nexport const b = 2\nexport const c = 3\n")

    process.chdir(repo)
    await getTreeSitterClient()
      .initialize()
      .catch(() => {})
    const { testRender: render } = await import("@opentui/solid")
    const { ReviewApp } = await import("../src/tui/app.tsx")
    const setup = await render(ReviewApp, { width: 100, height: 30 })
    try {
      await setup.renderOnce()
      let frame = setup.captureCharFrame()
      const lines = frame.split("\n")
      const firstLine = lines.findIndex((line) => line.includes("export const a = 1"))
      const secondLine = lines.findIndex((line) => line.includes("export const b = 2"))
      assert(firstLine !== -1 && secondLine === firstLine + 1, "phaseE finds the two added lines")
      // The highlight tool is the mouse: drag down over both lines copies them
      // for the prompt, with a toast and no note step.
      await setup.mockMouse.drag(45, firstLine, 45, secondLine)
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      // The fake terminal has no clipboard, so the toast reports one of the two
      // outcomes; either way the drag copied the lines it covered.
      assert(frame.includes("Copied") || frame.includes("highlight saved"), "phaseE drag reports the copy")
      assert(frame.includes("\u258C"), "phaseE highlight gutter shows")
      // /highlights lists it
      await setup.mockInput.pressKeys("/highlights".split(""))
      await setup.mockInput.pressKey("RETURN")
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      assert(frame.includes("src/a.ts:1-2"), "phaseE /highlights lists the copied lines")
    } finally {
      await setup.dispose().catch(() => {})
    }
  } finally {
    process.chdir(orig)
    if (prevCfg === undefined) delete process.env.CHERT_CONFIG_DIR
    else process.env.CHERT_CONFIG_DIR = prevCfg
    rmSync(repo, { recursive: true, force: true })
    rmSync(cfg, { recursive: true, force: true })
  }
}

async function phaseFTests(): Promise<void> {
  if (process.platform === "win32") {
    console.log("phaseFTests e2e skipped on win32")
    return
  }
  // e2e with fake opencode
  const repo = mkdtempSync(join(tmpdir(), "chert-phasef-"))
  const cfg = mkdtempSync(join(tmpdir(), "chert-phasef-cfg-"))
  const binDir = mkdtempSync(join(tmpdir(), "chert-phasef-bin-"))
  const orig = process.cwd()
  const prevCfg = process.env.CHERT_CONFIG_DIR
  const prevPath = process.env.PATH
  const prevServer = process.env.CHERT_OPENCODE_SERVER
  const server = startFakeOpencodeServer()
  try {
    const script = join(binDir, "opencode")
    writeFileSync(script, fakeOpencodeScript(["answer line 1"]))
    const { chmodSync } = await import("node:fs")
    chmodSync(script, 0o755)
    process.env.PATH = binDir + ":" + (process.env.PATH ?? "")
    process.env.CHERT_CONFIG_DIR = cfg
    process.env.CHERT_OPENCODE_SERVER = server.url

    runGit(repo, ["init", "-b", "main"])
    runGit(repo, ["config", "user.email", "smoke@example.com"])
    runGit(repo, ["config", "user.name", "smoke"])
    mkdirSync(join(repo, "src"), { recursive: true })
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1\n")
    runGit(repo, ["add", "."])
    runGit(repo, ["commit", "-m", "base"])
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1\nexport const a2 = 2\n")

    process.chdir(repo)
    await getTreeSitterClient()
      .initialize()
      .catch(() => {})
    const { testRender: render } = await import("@opentui/solid")
    const { ReviewApp } = await import("../src/tui/app.tsx")
    const setup = await render(ReviewApp, { width: 100, height: 30 })
    try {
      await setup.renderOnce()
      // ask by typing a question, then wait for the fake connector's answer
      await setup.mockInput.pressKeys("look".split(""))
      await setup.renderOnce()
      await setup.mockInput.pressKey("RETURN")
      await setup.renderOnce()
      await new Promise((r) => setTimeout(r, 1500))
      await setup.renderOnce()
      let frame = setup.captureCharFrame()
      assert(frame.includes("answer line 1"), "phaseF answer shows in pane")

      // Dragging the band's top edge makes it taller by the drag distance: the
      // band grows upward, so its header moves up two rows.
      {
        const headerRow = () =>
          setup.captureCharFrame().split("\n").findIndex((line) => line.includes("You asked:"))
        const before = headerRow()
        const gripY = before - 1
        await setup.mockMouse.drag(40, gripY, 40, gripY - 2)
        await setup.renderOnce()
        const after = headerRow()
        assert(after === before - 2, `dragging the band resizes the answer pane (${before} -> ${after})`)
      }

      // Space approves the only file; there is nothing left, so the review ends.
      await setup.mockInput.pressKey(" ")
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      assert(frame.includes("All done."), "phaseF Space approves the file and finishes")
      const stored = JSON.parse(readFileSync(join(repo, ".git", "chert", "review-state.json"), "utf8")) as {
        approvals: Record<string, unknown>
      }
      assert(stored.approvals["src/a.ts"] !== undefined, "phaseF approval is persisted by patch hash")
    } finally {
      await setup.dispose().catch(() => {})
    }
  } finally {
    process.chdir(orig)
    server.stop()
    if (prevCfg === undefined) delete process.env.CHERT_CONFIG_DIR
    else process.env.CHERT_CONFIG_DIR = prevCfg
    if (prevPath === undefined) delete process.env.PATH
    else process.env.PATH = prevPath
    if (prevServer === undefined) delete process.env.CHERT_OPENCODE_SERVER
    else process.env.CHERT_OPENCODE_SERVER = prevServer
    rmSync(repo, { recursive: true, force: true })
    rmSync(cfg, { recursive: true, force: true })
    rmSync(binDir, { recursive: true, force: true })
  }
}

/** A fake opencode that speaks the walk protocol without a model. */
const WALK_FAKE = `#!/usr/bin/env bun
const args = process.argv.slice(2)
if (args[0] === "--version") {
  console.log("2.3.0")
  process.exit(0)
}
if (args[0] === "session") {
  console.log(JSON.stringify([{ id: "ses_author", title: "wrote a2", updated: 2000 }]))
  process.exit(0)
}
// chert must use the configured server, not start a private backend.
if (!args.includes("--server")) {
  console.error("chert called opencode without --server")
  process.exit(1)
}
const prompt = args[args.length - 1]
const sessionAt = args.indexOf("--session")
const sessionId = args.includes("--fork") ? "ses_walk" : sessionAt === -1 ? "ses_new" : args[sessionAt + 1]
const emit = (text) =>
  console.log(JSON.stringify({ type: "text", sessionID: sessionId, part: { type: "text", text } }))
const b = prompt.includes("src/b.ts")
const anchor = b
  ? { side: "new", start: 2, end: 2, quote: "export const b2 = 2" }
  : { side: "new", start: 2, end: 2, quote: "export const a2 = 2" }
if (args.includes("--fork")) {
  emit("ready")
} else if (prompt.includes("Project file:")) {
  emit(JSON.stringify({
    protocol: "chert-review/1",
    path: b ? "src/b.ts" : "src/a.ts",
    intent: b ? "adds b2" : "adds a2",
    summary: b ? "b line added" : "a line added",
    walkthrough: [{ anchor, explanation: b ? "the new b export" : "the new a export" }],
    concerns: [{ anchor, level: "medium", note: "is it used?" }],
    assumptions: [],
    questions: [b ? "why b2?" : "why a2?"],
  }))
} else if (prompt.includes("plan")) {
  emit(JSON.stringify({
    protocol: "chert-review/1",
    overview: "adds a2 and b2",
    order: [
      { path: "src/b.ts", reason: "start with the new file" },
      { path: "src/a.ts", reason: "then the edit" },
    ],
  }))
} else {
  emit("ready")
}
`

/** /walk end to end: fork, plan, file analysis, verified notes. */
async function phaseWalkTests(): Promise<void> {
  if (process.platform === "win32") {
    console.log("phaseWalkTests skipped on win32")
    return
  }
  const repo = mkdtempSync(join(tmpdir(), "chert-walk-smoke-"))
  const cfg = mkdtempSync(join(tmpdir(), "chert-walk-smoke-cfg-"))
  const binDir = mkdtempSync(join(tmpdir(), "chert-walk-smoke-bin-"))
  const orig = process.cwd()
  const prevCfg = process.env.CHERT_CONFIG_DIR
  const prevPath = process.env.PATH
  const prevServer = process.env.CHERT_OPENCODE_SERVER
  const server = startFakeOpencodeServer()
  try {
    const script = join(binDir, "opencode")
    writeFileSync(script, WALK_FAKE)
    const { chmodSync } = await import("node:fs")
    chmodSync(script, 0o755)
    process.env.PATH = binDir + ":" + (process.env.PATH ?? "")
    process.env.CHERT_CONFIG_DIR = cfg
    process.env.CHERT_OPENCODE_SERVER = server.url

    runGit(repo, ["init", "-b", "main"])
    runGit(repo, ["config", "user.email", "smoke@example.com"])
    runGit(repo, ["config", "user.name", "smoke"])
    mkdirSync(join(repo, "src"), { recursive: true })
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1\n")
    writeFileSync(join(repo, "src", "b.ts"), "export const b = 1\n")
    runGit(repo, ["add", "."])
    runGit(repo, ["commit", "-m", "base"])
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1\nexport const a2 = 2\n")
    writeFileSync(join(repo, "src", "b.ts"), "export const b = 1\nexport const b2 = 2\n")

    process.chdir(repo)
    await getTreeSitterClient()
      .initialize()
      .catch(() => {})
    const { testRender: render } = await import("@opentui/solid")
    const { ReviewApp } = await import("../src/tui/app.tsx")
    // Tall enough for the whole analysis: the pane shows its first lines only.
    const setup = await render(ReviewApp, { width: 100, height: 50 })
    try {
      await setup.renderOnce()
      await setup.mockInput.pressKeys("/walk".split(""))
      await setup.mockInput.pressKey("RETURN")
      await new Promise((r) => setTimeout(r, 1500))
      await setup.renderOnce()
      let frame = setup.captureCharFrame()
      console.log("WALK FRAME:\n" + frame + "\nENDWALK")
      assert(frame.includes("adds a2 and b2"), "walk plan overview reaches the screen")
      assert(frame.includes("b line added"), "walk starts with the agent's first file")
      assert(frame.includes("start with the new file"), "band explains why this file is first")
      assert(!frame.includes("You asked:"), "analysis is not labelled as a question")
      assert(frame.includes("Space approve"), "approval stays visible while the band is open")
      // The band, the prompt and the action bar all sit under the diff.
      const lines = frame.split("\n")
      const changedLine = lines.find((line) => line.includes("export const b2")) ?? ""
      assert(changedLine.includes("\u258c"), "walk anchor is placed on the changed line")
      const diffAt = lines.findIndex((line) => line.includes("export const b2"))
      const promptAt = lines.findIndex((line) => line.includes("ask a question"))
      const actionsAt = lines.findIndex((line) => line.includes("Back") && line.includes("Next"))
      assert(
        diffAt !== -1 && diffAt < promptAt && promptAt < actionsAt,
        "walk layout: diff above the band, prompt and actions",
      )
      assert(!frame.includes("Is it messy?"), "walk action bar no longer offers Is it messy?")

      // Next reaches the second file; the agent describes it without an ask.
      await setup.mockInput.pressKey("RETURN")
      await new Promise((r) => setTimeout(r, 900))
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      assert(frame.includes("2 of 2 files"), "Next follows the agent's order")
      assert(frame.includes("a line added"), "moving to a file asks the agent for it")
      assert(frame.includes("then the edit"), "band explains the second file's place")
      assert(frame.includes("Finish"), "the last file offers Finish, not Next")

      // Approve the second file; the walk returns to the first unapproved one.
      await setup.mockInput.pressKey(" ")
      await new Promise((r) => setTimeout(r, 400))
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      assert(frame.includes("b line added"), "approving advances to the next unapproved file")

      // Approve the first file too; there is nothing left, so the review ends.
      await setup.mockInput.pressKey(" ")
      await new Promise((r) => setTimeout(r, 300))
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      assert(frame.includes("All done."), "approving the last unapproved file finishes")
      assert(frame.includes("2 of 2 approved"), "done screen counts approvals")
      assert(frame.includes("Back to the files"), "done screen offers a way back")
      assert(frame.includes("Esc files"), "done footer offers Esc back")
      assert(!frame.includes("Walk: adds a2 and b2"), "the plan notice does not follow you to done")

      await setup.mockInput.pressKey("RETURN")
      await new Promise((r) => setTimeout(r, 300))
      await setup.renderOnce()
      frame = setup.captureCharFrame()
      assert(!frame.includes("All done."), "Back to the files returns to the review")
      assert(frame.includes("b line added"), "the walk's answer is restored on return")

      const stored = JSON.parse(readFileSync(join(repo, ".git", "chert", "review-state.json"), "utf8")) as {
        walks: Record<string, { forkedSessionId: string; mode: string }>
        approvals: Record<string, unknown>
      }
      assert(stored.walks.working.forkedSessionId === "ses_walk", "walk stores the forked session")
      assert(stored.walks.working.mode === "author-context", "walk records author context")
      assert(stored.approvals["src/a.ts"] !== undefined, "walk approval for a is persisted")
      assert(stored.approvals["src/b.ts"] !== undefined, "walk approval for b is persisted")
    } finally {
      await setup.dispose().catch(() => {})
    }
  } finally {
    process.chdir(orig)
    server.stop()
    if (prevCfg === undefined) delete process.env.CHERT_CONFIG_DIR
    else process.env.CHERT_CONFIG_DIR = prevCfg
    if (prevPath === undefined) delete process.env.PATH
    else process.env.PATH = prevPath
    if (prevServer === undefined) delete process.env.CHERT_OPENCODE_SERVER
    else process.env.CHERT_OPENCODE_SERVER = prevServer
    rmSync(repo, { recursive: true, force: true })
    rmSync(cfg, { recursive: true, force: true })
    rmSync(binDir, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const originalCwd = process.cwd()
  const tmp = mkdtempSync(join(tmpdir(), "chert-smoke-"))
  // Connector key storage lives in a separate temp dir: inside the repo it
  // would show up in the project tree as an untracked directory.
  const cfgTmp = mkdtempSync(join(tmpdir(), "chert-cfg-"))
  let setup: Awaited<ReturnType<typeof testRender>> | undefined
  let ok = false

  try {
    await phaseBTests()
    await phaseFTests()
    await phaseWalkTests()
    await phaseETests()
    await phaseCTests()
    await phase1Tests()
    // Seed a repo that exercises every change kind.
    runGit(tmp, ["init", "-b", "main"])
    runGit(tmp, ["config", "user.email", "smoke@example.com"])
    runGit(tmp, ["config", "user.name", "smoke"])
    mkdirSync(join(tmp, "src"), { recursive: true })
    writeFileSync(join(tmp, "src", "deleted.ts"), "export function oldThing() {\n  return 'gone'\n}\n")
    writeFileSync(join(tmp, "src", "modified.ts"), "export const before = 1\n")
    runGit(tmp, ["add", "."])
    runGit(tmp, ["commit", "-m", "base"])
    writeFileSync(join(tmp, "src", "modified.ts"), "export const before = 1\nexport const addedByTest = 2\n")
    rmSync(join(tmp, "src", "deleted.ts"))
    writeFileSync(join(tmp, "src", "untracked-new.ts"), "export const brandNew = true\n")

    process.chdir(tmp)
    // Keep connector key storage hermetic without polluting the repo.
    process.env.CHERT_CONFIG_DIR = join(cfgTmp, "chert-config")

    // Pre-initialize tree-sitter with visible diagnostics.
    const client = getTreeSitterClient()
    try {
      await client.initialize()
    } catch (error) {
      console.error("tree-sitter initialization failed:", error)
    }

    const { testRender: render } = await import("@opentui/solid")
    const { ReviewApp } = await import("../src/tui/app.tsx")

    setup = await render(ReviewApp, { width: 100, height: 30 })
    await setup.renderOnce()

    let frame = setup.captureCharFrame()
    assert(frame.includes("Files (3)"), "two-pane shows file count")
    assert(frame.includes("deleted.ts"), "first file is shown")
    assert(frame.includes("oldThing"), "initial diff shows the deleted file patch")
    assert(frame.includes("> "), "prompt row is present")

    // With no answer yet, the band collapses to its label: the prompt sits two
    // rows below it (a rule and the prompt itself), not five.
    {
      const lines = setup.captureCharFrame().split("\n")
      const header = lines.findIndex((line) => line.includes("Ask about this file"))
      const prompt = lines.findIndex((line) => line.includes("> ask a question"))
      assert(header > 0 && prompt === header + 2, `empty answer band is compact (${header} -> ${prompt})`)
    }

    // Suggestions live in the drop-up box above the prompt, not inline below it.
    await setup.mockInput.pressKeys("/op".split(""))
    await setup.renderOnce()
    {
      const lines = setup.captureCharFrame().split("\n")
      const promptRow = lines.findIndex((line) => line.includes("> /op"))
      const suggestionRow = lines.findIndex((line) => line.includes("/open"))
      assert(suggestionRow >= 0, "typing /o shows command suggestions")
      assert(suggestionRow < promptRow, "suggestions sit above the prompt")
      assert(!lines.some((line) => line.includes("╭")), "suggestions use the flat box, no frame")
    }
    await setup.mockInput.pressEscape()
    await new Promise((r) => setTimeout(r, 60))
    await setup.renderOnce()

    // /theme switches immediately and reports on the status line, not in a banner.
    await setup.mockInput.pressKeys("/theme github".split(""))
    await setup.mockInput.pressKey("RETURN")
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    assert(frame.includes("theme: GitHub"), "/theme reports on the status line")
    {
      const lines = frame.split("\n")
      const promptRow = lines.findIndex((line) => line.includes("> ask a question"))
      const themeRow = lines.findIndex((line) => line.includes("theme: GitHub"))
      assert(themeRow > promptRow, "/theme leaves no banner above the prompt")
    }
    await setup.mockInput.pressKeys("/theme default".split(""))
    await setup.mockInput.pressKey("RETURN")
    await setup.renderOnce()

    // The prompt input owns focus; an empty prompt lets arrows through to the
    // file list via the global key handler.
    await setup.mockInput.pressArrow("down")
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    assert(frame.includes("addedByTest"), "Down advances to the modified file patch")

    // /open <query> jumps to a file.
    await setup.mockInput.pressKeys("/open untracked".split(""))
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    assert(frame.includes("/open untracked"), "typed command is echoed in the prompt")
    await setup.mockInput.pressKey("RETURN")
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    assert(frame.includes("brandNew"), "/open jumps to the matching file")
    assert(!frame.includes("/open"), "prompt is cleared after submit")

    // Esc opens the menu as a drop-up over the review: the review stays
    // visible, and the panel is anchored near the bottom, not the top.
    await setup.mockInput.pressEscape()
    await new Promise((r) => setTimeout(r, 60))
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    assert(frame.includes("Menu"), "Esc opens the menu")
    assert(frame.includes("Walk through with agent"), "menu rows are listed")
    assert(frame.includes("Files (3)"), "the review stays visible under the menu")
    assert(
      frame.split("\n").findIndex((line) => line.includes("Menu")) > 10,
      "the menu drops up from the bottom",
    )
    await setup.mockInput.pressEscape()
    await new Promise((r) => setTimeout(r, 60))
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    assert(!frame.includes("Walk through with agent"), "Esc closes the menu")

    // /run executes a shell command and shows output in the log view.
    await setup.mockInput.pressKeys("/run echo chert-e2e-ok".split(""))
    await setup.mockInput.pressKey("RETURN")
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    assert(frame.includes("chert-e2e-ok"), "/run output appears in the log view")

    // /refresh rescans and reports the count.
    await setup.mockInput.pressKeys("/refresh".split(""))
    await setup.mockInput.pressKey("RETURN")
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    assert(frame.includes("refreshed 3 files"), "/refresh reports the file count")

    // (Tab no longer cycles views in Phase B; use /tree for the tree.)

    // /connect lists every connector with key state.
    await setup.mockInput.pressKeys("/connect".split(""))
    await setup.mockInput.pressKey("RETURN")
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    assert(frame.includes("connectors:") && frame.includes("opencode"), "/connect lists connectors")
    assert(frame.includes("Groq") && frame.includes("NVIDIA NIM"), "/connect lists all providers")

    // /connect <provider> <key> saves the key to the (redirected) config.
    await setup.mockInput.pressKeys("/connect groq gsk-smoke-key".split(""))
    await setup.mockInput.pressKey("RETURN")
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    assert(frame.includes("saved Groq key"), "/connect <provider> <key> saves the key")

    // /use routes plain-text prompts to a provider; the header reflects it.
    await setup.mockInput.pressKeys("/use groq".split(""))
    await setup.mockInput.pressKey("RETURN")
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    assert(frame.includes("[ groq/llama-3.3-70b-versatile ]"), "/use switches the active connector")

    // ...and back to the opencode CLI.
    await setup.mockInput.pressKeys("/use opencode".split(""))
    await setup.mockInput.pressKey("RETURN")
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    assert(frame.includes("[ opencode ]"), "/use opencode switches back")

    // Tree view via /tree command.
    await setup.mockInput.pressKeys("/tree".split(""))
    await setup.mockInput.pressKey("RETURN")
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    assert(
      frame.includes("└── src/") &&
        frame.includes("deleted.ts") &&
        frame.includes("modified.ts") &&
        frame.includes("untracked-new.ts"),
      "tree shows nested folders and files",
    )

    // Arrows move the tree selection; Enter opens the file in the review view.
    await setup.mockInput.pressArrow("down")
    await setup.renderOnce()
    await setup.mockInput.pressArrow("down")
    await setup.renderOnce()
    await setup.mockInput.pressArrow("down")
    await setup.renderOnce()
    await setup.mockInput.pressKey("RETURN")
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    assert(frame.includes("addedByTest"), "Enter on a tree file opens its diff")
    assert(frame.includes("→ src/modified.ts"), "status line shows the opened file")

    console.log(frame)
    ok = true
  } catch (error) {
    console.error("Smoke test FAILED:", error instanceof Error ? error.message : error)
  } finally {
    if (setup) await setup.dispose().catch(() => {})
    process.chdir(originalCwd)
    // Windows can transiently hold handles on freshly used directories.
    for (const dir of [tmp, cfgTmp]) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const removed = tryOr(() => {
          rmSync(dir, { recursive: true, force: true })
          return true
        }, false)
        if (removed) break
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }
  }

  if (!ok) process.exit(1)
  console.log("TUI smoke test passed")
}

await main()
