// Headless end-to-end smoke test:
//   1. seeds a temp git repo (base commit, then modify/delete/untrack files)
//   2. mounts the review TUI in memory against that repo
//   3. drives it with mock keyboard input and asserts rendered frames
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

async function main(): Promise<void> {
  const originalCwd = process.cwd();
  const tmp = mkdtempSync(join(tmpdir(), "chert-smoke-"));
  let setup: Awaited<ReturnType<typeof testRender>> | undefined;
  let ok = false;

  try {
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

    // Pre-initialize tree-sitter with visible diagnostics.
    const client = getTreeSitterClient();
    try {
      await client.initialize();
    } catch (error) {
      console.error("tree-sitter initialization failed:", error);
    }

    const { testRender: render } = await import("@opentui/solid");
    const { ReviewApp } = await import("../src/tui/app.tsx");

    setup = await render(ReviewApp, { width: 100, height: 26 });
    await setup.renderOnce();

    // Sorted list: deleted.ts, modified.ts, untracked-new.ts.
    // The deleted file is selected first; its patch should render.
    let frame = setup.captureCharFrame();
    assert(frame.includes("deleted.ts") && frame.includes("modified.ts") && frame.includes("untracked-new.ts"),
      "file list shows all changed files");
    assert(frame.includes("oldThing"), "initial diff shows the deleted file patch");

    await setup.mockInput.pressArrow("down");
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    assert(frame.includes("addedByTest"), "arrow-down loads the modified file patch");

    await setup.mockInput.pressArrow("down");
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    assert(frame.includes("brandNew"), "arrow-down loads the synthesized untracked patch");

    await setup.mockInput.pressKey("r");
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    assert(frame.includes("oldThing") && frame.includes("untracked-new.ts"), "refresh reloads all files, first file selected again");

    console.log(frame);
    ok = true;
  } catch (error) {
    console.error("Smoke test FAILED:", error instanceof Error ? error.message : error);
  } finally {
    if (setup) await setup.dispose().catch(() => {});
    process.chdir(originalCwd);
    // Windows can transiently hold handles on freshly used directories.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(tmp, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }

  if (!ok) process.exit(1);
  console.log("TUI smoke test passed");
}

await main();
