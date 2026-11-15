// Headless smoke test: renders the review TUI in memory and asserts the frame.
// Run with: bun run scripts/smoke-tui.ts
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin";
import { getTreeSitterClient } from "@opentui/core";

ensureSolidTransformPlugin();

async function main(): Promise<void> {
  // Pre-initialize tree-sitter with visible diagnostics; renderables use the
  // global client and would otherwise swallow initialization errors.
  const client = getTreeSitterClient();
  client.on("error", (message) => console.error("tree-sitter error:", message));
  client.on("warning", (message) => console.warn("tree-sitter warning:", message));
  client.on("worker:log", (type, message) => console.log(`tree-sitter worker ${type}:`, message));

  try {
    await client.initialize();
    console.log("tree-sitter pre-initialized OK");
  } catch (error) {
    console.error("tree-sitter initialization failed:", error);
  }

  const { testRender } = await import("@opentui/solid");
  const { ReviewApp } = await import("../src/tui/app.tsx");

  const setup = await testRender(ReviewApp, { width: 100, height: 26 });
  await setup.renderOnce();
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();

  // Verify tree-sitter highlighting reached the diff pane: its rows should
  // carry several distinct foreground colors once highlights are applied.
  const spans = setup.captureSpans();
  const diffRows = spans.lines.slice(1).map((line) => line.spans);
  const distinctFgs = new Set(
    diffRows
      .flat()
      .filter((span) => span.text.trim().length > 0 && span.width >= 0)
      .map((span) => `${span.fg}`),
  );
  console.log(`distinct foreground colors in frame: ${distinctFgs.size}`);
  if (distinctFgs.size < 3) {
    console.error("Smoke test FAILED: expected syntax highlighting colors in the diff pane");
    await setup.dispose();
    process.exit(1);
  }

  console.log(frame);
  console.log("=".repeat(100));

  const required = ["chert", "files", "src/index.ts", "src/review.ts", "src/legacy.ts"];
  const missing = required.filter((needle) => !frame.includes(needle));
  if (missing.length > 0) {
    console.error(`Smoke test FAILED. Missing from rendered frame: ${missing.join(", ")}`);
    await setup.dispose();
    process.exit(1);
  }

  console.log("TUI smoke test passed");
  await setup.dispose();
}

await main();
