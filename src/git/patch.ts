// Patch text. The only synthesized case is an untracked file, which has no
// history to diff against: it is rendered as an all-added patch, or as a
// placeholder when it is binary or too large to show.

import { readFileSync } from "node:fs"
import { tryOr } from "../best-effort"
import { MAX_UNTRACKED_PATCH_BYTES, diffBaseArgs } from "./changes"
import type { ReviewFile, ReviewSource } from "./changes"
import { hasHead } from "./refs"
import { run } from "./run"

export function loadPatch(
  root: string,
  file: ReviewFile,
  source: ReviewSource = { kind: "working" },
): string {
  if (file.status === "untracked") {
    return synthesizedAddedPatch(file.path)
  }
  const headExists = source.kind === "working" ? hasHead(root) : true
  const { base } = diffBaseArgs(root, source, headExists)
  if (base === null) {
    return synthesizedAddedPatch(file.path)
  }
  return run(root, ["diff", ...base, "--no-renames", "--no-color", "--", file.path])
}

function synthesizedAddedPatch(path: string): string {
  // An unreadable file still gets a header, just with no lines.
  const content = tryOr(() => readFileSync(path), Buffer.alloc(0))

  const header = [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..e69de29",
    "--- /dev/null",
    `+++ b/${path}`,
  ].join("\n")

  // Untracked files are read whole, so a huge one would build a patch with
  // tens of thousands of rows and stall the viewer.
  if (content.length > MAX_UNTRACKED_PATCH_BYTES) {
    return `${header}\n… file is ${Math.round(content.length / 1024)} KiB, too large to show\n`
  }
  // A NUL byte means binary; say what git says for a tracked binary so the
  // viewer can style and skip it the same way.
  if (content.includes(0)) {
    return `${header}\nBinary files /dev/null and b/${path} differ\n`
  }

  const lines = content.toString().split("\n")
  if (lines[lines.length - 1] === "") lines.pop()

  if (lines.length === 0) {
    return `${header}\n@@ -0,0 +0,0 @@\n`
  }
  const body = lines.map((line) => `+${line}`).join("\n")
  return `${header}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`
}
