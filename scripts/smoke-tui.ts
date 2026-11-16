// Headless end-to-end smoke test:
//   1. seeds a temp git repo (base commit, then modify/delete/untrack files)
//   2. mounts the review TUI in memory against that repo
//   3. drives the prompt and navigation with mock keyboard input, asserting
//      rendered frames at each step
// Run with: bun run scripts/smoke-tui.ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin";
import { getTreeSitterClient } from "@opentui/core";
import type { testRender } from "@opentui/solid";

ensureSolidTransformPlugin();

function runGit(cwd: string, args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], { cwd });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

async function phase1Tests(): Promise<void> {
  const { expandPath, resolveProjectRoot, enterProject } = await import("../src/projects.ts");

  const home = process.env.HOME ?? "";
  assert(expandPath("~/code-test-base", "/tmp") === join(home, "code-test-base"), "expandPath expands ~/");
  assert(expandPath("~", "/tmp") === home, "expandPath expands ~");
  assert(expandPath("sub/dir", "/base/path") === "/base/path/sub/dir", "expandPath resolves relative paths");
  assert(expandPath("/abs/path/.", "/tmp") === "/abs/path", "expandPath normalizes absolute paths");
  assert(expandPath("'~/quoted'", "/tmp") === join(home, "quoted"), "expandPath strips quotes");

  const missing = join(tmpdir(), `chert-missing-${Date.now()}-nope`);
  assert(resolveProjectRoot(missing) === undefined, "resolveProjectRoot returns undefined for missing dir");

  const nonRepo = mkdtempSync(join(tmpdir(), "chert-nonrepo-"));
  try {
    assert(resolveProjectRoot(nonRepo) === undefined, "resolveProjectRoot returns undefined for non-repo");
  } finally {
    rmSync(nonRepo, { recursive: true, force: true });
  }

  const repo = mkdtempSync(join(tmpdir(), "chert-phase1-"));
  const cfg = mkdtempSync(join(tmpdir(), "chert-phase1-cfg-"));
  const orig = process.cwd();
  const prevCfg = process.env.CHERT_CONFIG_DIR;
  process.env.CHERT_CONFIG_DIR = cfg;
  try {
    runGit(repo, ["init", "-b", "main"]);
    runGit(repo, ["config", "user.email", "smoke@example.com"]);
    runGit(repo, ["config", "user.name", "smoke"]);
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "base.txt"), "base\n");
    runGit(repo, ["add", "."]);
    runGit(repo, ["commit", "-m", "base"]);

    assert(resolveProjectRoot(join(repo, "src")) === repo, "resolveProjectRoot from subfolder gives root");

    // Regression: start in subfolder, working changes + untracked; diffs must load from repo root.
    writeFileSync(join(repo, "src", "modified.ts"), "export const before = 1\n");
    runGit(repo, ["add", "src/modified.ts"]);
    runGit(repo, ["commit", "-m", "add modified"]);
    writeFileSync(join(repo, "src", "modified.ts"), "export const before = 1\nexport const addedByTest = 2\n");
    writeFileSync(join(repo, "src", "untracked-new.ts"), "export const brandNew = true\n");

    process.chdir(join(repo, "src"));
    const entered = enterProject(join(repo, "src"));
    assert(entered === repo, "enterProject from subfolder returns and chdirs to root");
    assert(process.cwd() === repo, "enterProject chdirs to repo root");

    const { testRender: render } = await import("@opentui/solid");
    const { ReviewApp } = await import("../src/tui/app.tsx");
    const setup = await render(ReviewApp, { width: 100, height: 30 });
    try {
      await setup.renderOnce();
      let frame = setup.captureCharFrame();
      assert(
        frame.includes("src/modified.ts") && frame.includes("src/untracked-new.ts"),
        "subfolder launch: file list shows all changed files with root-relative paths",
      );
      assert(frame.includes("addedByTest"), "subfolder launch: selecting modified file shows actual diff text");
    } finally {
      await setup.dispose().catch(() => {});
    }
  } finally {
    process.chdir(orig);
    if (prevCfg === undefined) delete process.env.CHERT_CONFIG_DIR;
    else process.env.CHERT_CONFIG_DIR = prevCfg;
    rmSync(repo, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
  }
}


async function phase2Tests(): Promise<void> {
  const projectsDir = mkdtempSync(join(tmpdir(), "chert-projects-"));
  const cfg = join(projectsDir, ".chert-config");
  const orig = process.cwd();
  const prevCfg = process.env.CHERT_CONFIG_DIR;
  process.env.CHERT_CONFIG_DIR = cfg;
  try {
    const mkRepo = (name: string, content: string) => {
      const dir = join(projectsDir, name);
      mkdirSync(dir, { recursive: true });
      runGit(dir, ["init", "-b", "main"]);
      runGit(dir, ["config", "user.email", "smoke@example.com"]);
      runGit(dir, ["config", "user.name", "smoke"]);
      writeFileSync(join(dir, "file.txt"), content);
      runGit(dir, ["add", "."]);
      runGit(dir, ["commit", "-m", "base"]);
      writeFileSync(join(dir, "file.txt"), content + "changed\n");
      return dir;
    };
    const alpha = mkRepo("alpha", "alpha-one\n");
    const beta = mkRepo("beta", "beta-one\n");

    process.chdir(projectsDir);
    const { testRender: render } = await import("@opentui/solid");
    const { ReviewApp } = await import("../src/tui/app.tsx");
    const setup = await render(ReviewApp, { width: 100, height: 30 });
    try {
      await setup.renderOnce();
      let frame = setup.captureCharFrame();
      assert(frame.includes("no project selected"), "picker starts with no project selected in non-repo cwd");
      assert(frame.includes("alpha") && frame.includes("beta"), "picker lists child repos");
      assert(frame.includes("found here"), "picker shows found repos");

      // alpha and beta alphabetical; open beta (second)
      await setup.mockInput.pressArrow("down");
      await setup.mockInput.pressKey("RETURN");
      await setup.renderOnce();
      frame = setup.captureCharFrame();
      assert(frame.includes("chert · beta ·"), "opening found repo shows its name in header");
      assert(frame.includes("file.txt"), "opened project loads its files");

      // projects.json lists beta first
      const { loadRecent } = await import("../src/projects.ts");
      let recents = loadRecent();
      assert(recents.length >= 1 && recents[0].path === beta, "projects.json lists opened project first");

      // open alpha via /project <path>, order flips and no duplication
      await setup.mockInput.pressKeys(("/project " + alpha).split(""));
      await setup.mockInput.pressKey("RETURN");
      await setup.renderOnce();
      frame = setup.captureCharFrame();
      assert(frame.includes("chert · alpha ·"), "opening other project switches to it");
      recents = loadRecent();
      assert(recents[0].path === alpha && recents[1].path === beta, "recent order flips to newest first");
      assert(recents.filter((r) => r.path === alpha || r.path === beta).length === 2, "no duplicate recent entries");

      // /project reopens picker with recents first
      await setup.mockInput.pressKeys("/project".split(""));
      await setup.mockInput.pressKey("RETURN");
      await setup.renderOnce();
      frame = setup.captureCharFrame();
      const alphaIdx = frame.indexOf("alpha");
      const betaIdx = frame.indexOf("beta");
      assert(alphaIdx !== -1 && betaIdx !== -1 && alphaIdx < betaIdx, "picker shows recents first");

      // bogus path shows error and stays in picker (typed as non-slash path)
      await setup.mockInput.pressKeys("no-such-repo-here".split(""));
      await setup.mockInput.pressKey("RETURN");
      await setup.renderOnce();
      frame = setup.captureCharFrame();
      assert(frame.includes("that folder isn't a git project:"), "bogus path shows error");
      assert(frame.includes("found here") || frame.includes("recent"), "stays in picker after bogus path");

      // subfolder of alpha opens alpha root (typed as non-slash relative path)
      mkdirSync(join(alpha, "subdir"), { recursive: true });
      await setup.mockInput.pressKeys("subdir".split(""));
      await setup.mockInput.pressKey("RETURN");
      await setup.renderOnce();
      frame = setup.captureCharFrame();
      assert(frame.includes("chert · alpha ·"), "subfolder path opens repo root project");

      // x forgets a recent entry
      await setup.mockInput.pressKeys("/project".split(""));
      await setup.mockInput.pressKey("RETURN");
      await setup.renderOnce();
      // recent list now alpha, beta; select alpha (recent) and forget
      const recentsBeforeX = loadRecent();
      await setup.mockInput.pressKeys(["\u001B[3~"]);
      await new Promise((r) => setTimeout(r, 60));
      await setup.renderOnce();
      frame = setup.captureCharFrame();
      const recentsAfterX = loadRecent();
      assert(recentsAfterX.length === recentsBeforeX.length - 1, "Delete removes one recent entry");
      assert(frame.includes("removed from the list"), "Delete shows removed status");
    } finally {
      await setup.dispose().catch(() => {});
    }
  } finally {
    process.chdir(orig);
    if (prevCfg === undefined) delete process.env.CHERT_CONFIG_DIR;
    else process.env.CHERT_CONFIG_DIR = prevCfg;
    rmSync(projectsDir, { recursive: true, force: true });
  }
}


async function phase3Tests(): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), "chert-phase3-"));
  const cfg = mkdtempSync(join(tmpdir(), "chert-phase3-cfg-"));
  const orig = process.cwd();
  const prevCfg = process.env.CHERT_CONFIG_DIR;
  process.env.CHERT_CONFIG_DIR = cfg;
  try {
    runGit(repo, ["init", "-b", "main"]);
    runGit(repo, ["config", "user.email", "smoke@example.com"]);
    runGit(repo, ["config", "user.name", "smoke"]);
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1\n");
    writeFileSync(join(repo, "src", "big.ts"), "export const x = 0\n");
    runGit(repo, ["add", "."]);
    runGit(repo, ["commit", "-m", "base"]);
    // modify a.ts
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1\nexport const a2 = 2\n");
    // make big.ts 200 lines
    const lines = Array.from({ length: 200 }, (_, i) => `export const line${i} = ${i}`).join("\n") + "\n";
    writeFileSync(join(repo, "src", "big.ts"), lines);

    process.chdir(repo);
    await getTreeSitterClient().initialize().catch(() => {});
    const { testRender: render } = await import("@opentui/solid");
    const { ReviewApp } = await import("../src/tui/app.tsx");
    const setup = await render(ReviewApp, { width: 100, height: 30 });
    try {
      await setup.renderOnce();
      let frame = setup.captureCharFrame();
      assert(frame.includes("Ctrl+C quit"), "phase3 footer has Ctrl+C quit");
      assert(frame.includes("↑↓ files"), "phase3 starts in prompt mode footer");
      assert(frame.includes("> "), "phase3 prompt row >");

      // Esc (empty prompt) -> browse mode
      await setup.mockInput.pressEscape();
      await new Promise((r) => setTimeout(r, 60));
      await setup.renderOnce();
      frame = setup.captureCharFrame();
      console.log("DEBUG3A:\n" + frame + "\nEND3A");
      assert(frame.includes("j/k files"), "phase3 browse mode footer");
      assert(frame.includes("· "), "phase3 browse prompt row");

      // j moves selection; nothing typed into prompt
      await setup.mockInput.pressKey("j");
      await setup.renderOnce();
      frame = setup.captureCharFrame();
      assert(!frame.includes("· j"), "phase3 j not typed into prompt");

      // i -> prompt mode
      await setup.mockInput.pressKey("i");
      await setup.renderOnce();
      frame = setup.captureCharFrame();
      assert(frame.includes("> "), "phase3 i returns to prompt mode");

      // type hello
      await setup.mockInput.pressKeys("hello".split(""));
      await setup.renderOnce();
      frame = setup.captureCharFrame();
      assert(frame.includes("hello"), "phase3 typed text shows");

      // Esc clears input
      await setup.mockInput.pressEscape();
      await new Promise((r) => setTimeout(r, 60));
      await setup.renderOnce();
      frame = setup.captureCharFrame();
      assert(!frame.includes("hello"), "phase3 Esc clears input");

      // Esc again -> browse
      await setup.mockInput.pressEscape();
      await new Promise((r) => setTimeout(r, 60));
      await setup.renderOnce();
      frame = setup.captureCharFrame();
      assert(frame.includes("j/k files"), "phase3 Esc again goes to browse");

      // Space scrolls 200-line diff: first ensure big.ts selected? navigate to it
      // Select big.ts via /open
      await setup.mockInput.pressKey("i");
      await setup.mockInput.pressKeys("/open big".split(""));
      await setup.mockInput.pressKey("RETURN");
      await setup.renderOnce();
      // back to browse
      await setup.mockInput.pressEscape();
      await setup.mockInput.pressEscape();
      await new Promise((r) => setTimeout(r, 60));
      await setup.renderOnce();
      frame = setup.captureCharFrame();
      assert(!frame.includes("line35"), "phase3 line35 off-screen before scroll");

      await setup.mockInput.pressKey(" ");
      await new Promise((r) => setTimeout(r, 60));
      await setup.renderOnce();
      frame = setup.captureCharFrame();
      assert(frame.includes("line35"), "phase3 Space scrolls to show later lines");

      // / opens prompt mode with / typed
      await setup.mockInput.pressKey("/");
      await setup.renderOnce();
      frame = setup.captureCharFrame();
      assert(frame.includes("> /"), "phase3 slash opens prompt mode with / typed");
    } finally {
      await setup.dispose().catch(() => {});
    }
  } finally {
    process.chdir(orig);
    if (prevCfg === undefined) delete process.env.CHERT_CONFIG_DIR;
    else process.env.CHERT_CONFIG_DIR = prevCfg;
    rmSync(repo, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
  }
}


async function phase4Tests(): Promise<void> {
  if (process.platform === "win32") {
    console.log("phase4Tests skipped on win32");
    return;
  }
  const repo = mkdtempSync(join(tmpdir(), "chert-phase4-"));
  const cfg = mkdtempSync(join(tmpdir(), "chert-phase4-cfg-"));
  const binDir = mkdtempSync(join(tmpdir(), "chert-phase4-bin-"));
  const orig = process.cwd();
  const prevCfg = process.env.CHERT_CONFIG_DIR;
  const prevPath = process.env.PATH;
  try {
    // fake opencode executable
    const script = join(binDir, "opencode");
    writeFileSync(script, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then exit 0; fi\nif [ \"$1\" = \"run\" ]; then\n  sleep 1\n  echo \"answer line 1\"\n  echo \"answer line 2\"\n  echo \"answer line 3\"\n  exit 0\nfi\nexit 0\n");
    const { chmodSync } = await import("node:fs");
    chmodSync(script, 0o755);

    // prepend to PATH BEFORE importing the app (opencodeAvailable caches)
    process.env.PATH = binDir + ":" + (process.env.PATH ?? "");
    process.env.CHERT_CONFIG_DIR = cfg;

    runGit(repo, ["init", "-b", "main"]);
    runGit(repo, ["config", "user.email", "smoke@example.com"]);
    runGit(repo, ["config", "user.name", "smoke"]);
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "modified.ts"), "export const before = 1\n");
    runGit(repo, ["add", "."]);
    runGit(repo, ["commit", "-m", "base"]);
    writeFileSync(join(repo, "src", "modified.ts"), "export const before = 1\nexport const addedByTest = 2\n");

    process.chdir(repo);
    await getTreeSitterClient().initialize().catch(() => {});
    const { testRender: render } = await import("@opentui/solid");
    const { ReviewApp } = await import("../src/tui/app.tsx");
    const setup = await render(ReviewApp, { width: 100, height: 30 });
    try {
      await setup.renderOnce();
      let frame = setup.captureCharFrame();
      assert(frame.includes("addedByTest"), "phase4 diff text on screen initially");

      // ask a question from review view
      await setup.mockInput.pressKeys("what changed?".split(""));
      await setup.mockInput.pressKey("RETURN");
      await setup.renderOnce();
      // busy: submit another prompt -> rejected
      await setup.mockInput.pressKeys("second question".split(""));
      await setup.mockInput.pressKey("RETURN");
      await setup.renderOnce();
      frame = setup.captureCharFrame();
      assert(frame.includes("still waiting on the last answer"), "phase4 second prompt rejected while busy");

      // wait for answer
      await new Promise((r) => setTimeout(r, 1500));
      await setup.renderOnce();
      frame = setup.captureCharFrame();
      assert(frame.includes("addedByTest"), "phase4 diff text stays on screen after answer");
      assert(frame.includes("answer line 1"), "phase4 answer text appears in pane");

      // a toggles pane
      await setup.mockInput.pressEscape();
      await new Promise((r) => setTimeout(r, 60));
      await setup.renderOnce();
      await setup.mockInput.pressKey("a");
      await setup.renderOnce();
      frame = setup.captureCharFrame();
      assert(!frame.includes("answer line 1"), "phase4 a hides pane");
      await setup.mockInput.pressKey("a");
      await setup.renderOnce();
      frame = setup.captureCharFrame();
      assert(frame.includes("answer line 1"), "phase4 a shows pane");
    } finally {
      await setup.dispose().catch(() => {});
    }
  } finally {
    process.chdir(orig);
    if (prevCfg === undefined) delete process.env.CHERT_CONFIG_DIR;
    else process.env.CHERT_CONFIG_DIR = prevCfg;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    rmSync(repo, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const originalCwd = process.cwd();
  const tmp = mkdtempSync(join(tmpdir(), "chert-smoke-"));
  // Connector key storage lives in a separate temp dir: inside the repo it
  // would show up in the project tree as an untracked directory.
  const cfgTmp = mkdtempSync(join(tmpdir(), "chert-cfg-"));
  let setup: Awaited<ReturnType<typeof testRender>> | undefined;
  let ok = false;

  try {
    await phase4Tests();
    await phase1Tests();
    await phase2Tests();
    await phase3Tests();
    // Seed a repo that exercises every change kind.
    runGit(tmp, ["init", "-b", "main"]);
    runGit(tmp, ["config", "user.email", "smoke@example.com"]);
    runGit(tmp, ["config", "user.name", "smoke"]);
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "src", "deleted.ts"), "export function oldThing() {\n  return 'gone'\n}\n");
    writeFileSync(join(tmp, "src", "modified.ts"), "export const before = 1\n");
    runGit(tmp, ["add", "."]);
    runGit(tmp, ["commit", "-m", "base"]);
    writeFileSync(join(tmp, "src", "modified.ts"), "export const before = 1\nexport const addedByTest = 2\n");
    rmSync(join(tmp, "src", "deleted.ts"));
    writeFileSync(join(tmp, "src", "untracked-new.ts"), "export const brandNew = true\n");

    process.chdir(tmp);
    // Keep connector key storage hermetic without polluting the repo.
    process.env.CHERT_CONFIG_DIR = join(cfgTmp, "chert-config");

    // Pre-initialize tree-sitter with visible diagnostics.
    const client = getTreeSitterClient();
    try {
      await client.initialize();
    } catch (error) {
      console.error("tree-sitter initialization failed:", error);
    }

    const { testRender: render } = await import("@opentui/solid");
    const { ReviewApp } = await import("../src/tui/app.tsx");

    setup = await render(ReviewApp, { width: 100, height: 30 });
    await setup.renderOnce();

    let frame = setup.captureCharFrame();
    assert(
      frame.includes("deleted.ts") && frame.includes("modified.ts") && frame.includes("untracked-new.ts"),
      "file list shows all changed files",
    );
    assert(frame.includes("oldThing"), "initial diff shows the deleted file patch");
    assert(frame.includes("> "), "prompt row is present");

    // The prompt input owns focus; an empty prompt lets arrows through to the
    // file list via the global key handler.
    await setup.mockInput.pressArrow("down");
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    assert(frame.includes("addedByTest"), "arrow-down loads the modified file patch");

    // /open <query> jumps to a file.
    await setup.mockInput.pressKeys("/open untracked".split(""));
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    assert(frame.includes("/open untracked"), "typed command is echoed in the prompt");
    await setup.mockInput.pressKey("RETURN");
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    assert(frame.includes("brandNew"), "/open jumps to the matching file");
    assert(!frame.includes("/open"), "prompt is cleared after submit");

    // /run executes a shell command and shows output in the log view.
    await setup.mockInput.pressKeys("/run echo chert-e2e-ok".split(""));
    await setup.mockInput.pressKey("RETURN");
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    assert(frame.includes("chert-e2e-ok"), "/run output appears in the log view");

    // /refresh rescans and reports the count.
    await setup.mockInput.pressKeys("/refresh".split(""));
    await setup.mockInput.pressKey("RETURN");
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    assert(frame.includes("refreshed 3 files"), "/refresh reports the file count");

    // Tab returns to the review view; refresh reset selection to the first file.
    await setup.mockInput.pressKey("TAB");
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    assert(frame.includes("oldThing") && frame.includes("Ctrl+C quit"), "Tab returns to the review view");

    // /connect lists every connector with key state.
    await setup.mockInput.pressKeys("/connect".split(""));
    await setup.mockInput.pressKey("RETURN");
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    assert(frame.includes("connectors:") && frame.includes("opencode"), "/connect lists connectors");
    assert(frame.includes("Groq") && frame.includes("NVIDIA NIM"), "/connect lists all providers");

    // /connect <provider> <key> saves the key to the (redirected) config.
    await setup.mockInput.pressKeys("/connect groq gsk-smoke-key".split(""));
    await setup.mockInput.pressKey("RETURN");
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    assert(frame.includes("saved Groq key"), "/connect <provider> <key> saves the key");

    // /use routes plain-text prompts to a provider; the header reflects it.
    await setup.mockInput.pressKeys("/use groq".split(""));
    await setup.mockInput.pressKey("RETURN");
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    assert(frame.includes("[ groq/llama-3.3-70b-versatile ]"), "/use switches the active connector");

    // ...and back to the opencode CLI.
    await setup.mockInput.pressKeys("/use opencode".split(""));
    await setup.mockInput.pressKey("RETURN");
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    assert(frame.includes("[ opencode ]"), "/use opencode switches back");

    // Tab cycles back to the review view first…
    await setup.mockInput.pressKey("TAB");
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    assert(frame.includes("oldThing") && frame.includes("Ctrl+C quit"), "Tab cycles back to the review view");

    // …then into the project tree view.
    await setup.mockInput.pressKey("TAB");
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    assert(
      frame.includes("└── src/") &&
        frame.includes("├── deleted.ts  D") &&
        frame.includes("├── modified.ts  M") &&
        frame.includes("└── untracked-new.ts  ??"),
      "tree shows nested folders and files with status marks",
    );

    // Arrows move the tree selection; Enter opens the file in the review view.
    await setup.mockInput.pressArrow("down");
    await setup.renderOnce();
    await setup.mockInput.pressArrow("down");
    await setup.renderOnce();
    await setup.mockInput.pressArrow("down");
    await setup.renderOnce();
    await setup.mockInput.pressKey("RETURN");
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    assert(frame.includes("addedByTest"), "Enter on a tree file opens its diff");
    assert(frame.includes("→ src/modified.ts"), "status line shows the opened file");

    console.log(frame);
    ok = true;
  } catch (error) {
    console.error("Smoke test FAILED:", error instanceof Error ? error.message : error);
  } finally {
    if (setup) await setup.dispose().catch(() => {});
    process.chdir(originalCwd);
    // Windows can transiently hold handles on freshly used directories.
    for (const dir of [tmp, cfgTmp]) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          rmSync(dir, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
    }
  }

  if (!ok) process.exit(1);
  console.log("TUI smoke test passed");
}

await main();
