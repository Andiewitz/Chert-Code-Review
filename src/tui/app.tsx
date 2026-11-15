import { createSignal } from "solid-js"
import { render, useKeyboard, useRenderer } from "@opentui/solid"
import { getTreeSitterClient } from "@opentui/core"
import type { SelectOption } from "@opentui/core"

// ---------------------------------------------------------------------------
// Placeholder review data — replace with the real source (git diff, PR, etc.)
// ---------------------------------------------------------------------------

type FileStatus = "added" | "modified" | "deleted"

interface ReviewFile {
  path: string
  status: FileStatus
  additions: number
  deletions: number
  filetype: string
  patch: string
}

const STATUS_GLYPH: Record<FileStatus, string> = {
  added: "+",
  modified: "~",
  deleted: "-",
}

const FILES: ReviewFile[] = [
  {
    path: "src/index.ts",
    status: "modified",
    additions: 6,
    deletions: 3,
    filetype: "typescript",
    patch: `diff --git a/src/index.ts b/src/index.ts
index 1a2b3c4..5d6e7f8 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,6 +1,11 @@
 #!/usr/bin/env bun
-import { run } from "./runner"
+import { run } from "./runner"
+import { review } from "./review"
 
-export function main() {
-  run()
+export function main(args: string[]) {
+  if (args.length === 0) {
+    review()
+    return
+  }
+  run(args)
 }
`,
  },
  {
    path: "src/review.ts",
    status: "added",
    additions: 7,
    deletions: 0,
    filetype: "typescript",
    patch: `diff --git a/src/review.ts b/src/review.ts
new file mode 100644
index 0000000..9c8d7e6
--- /dev/null
+++ b/src/review.ts
@@ -0,0 +1,7 @@
+import type { ReviewFile } from "./types"
+
+export function review() {
+  for (const file of listFiles()) {
+    show(file)
+  }
+}
`,
  },
  {
    path: "src/legacy.ts",
    status: "deleted",
    additions: 0,
    deletions: 4,
    filetype: "typescript",
    patch: `diff --git a/src/legacy.ts b/src/legacy.ts
deleted file mode 100644
index abc1234..0000000
--- a/src/legacy.ts
+++ /dev/null
@@ -1,4 +0,0 @@
-// Legacy bootstrapping, superseded by review.ts
-export function boot() {
-  runLegacy()
-}
`,
  },
]

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const COLORS = {
  bg: "#0f1319",
  border: "#263241",
  dim: "#475569",
  text: "#94a3b8",
  bright: "#e2e8f0",
  accent: "#67e8f9",
  selectedBg: "#1c2a3a",
}

export function ReviewApp() {
  const renderer = useRenderer()
  const [selected, setSelected] = createSignal(0)
  const file = () => FILES[Math.min(selected(), FILES.length - 1)]

  useKeyboard((key) => {
    if (key.name === "q" || key.name === "escape") {
      renderer.destroy()
      process.exit(0)
    }
  })

  const options: SelectOption[] = FILES.map((f, index) => ({
    name: `${STATUS_GLYPH[f.status]} ${f.path}`,
    description: `${f.status}  +${f.additions} -${f.deletions}`,
    value: index,
  }))

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={COLORS.bg}>
      <box height={1} flexShrink={0} flexDirection="row" paddingLeft={1}>
        <text fg={COLORS.accent}>chert</text>
        <text fg={COLORS.dim}>{` review  ${FILES.length} files`}</text>
      </box>

      <box flexGrow={1} flexDirection="row">
        <box width="40%" border borderStyle="rounded" borderColor={COLORS.border} title="files" titleColor={COLORS.dim}>
          <select
            focused
            width="100%"
            height="100%"
            options={options}
            showDescription={true}
            showScrollIndicator={true}
            onChange={(index) => setSelected(index)}
            backgroundColor={COLORS.bg}
            textColor={COLORS.text}
            selectedTextColor={COLORS.bright}
            selectedBackgroundColor={COLORS.selectedBg}
            descriptionColor={COLORS.dim}
            selectedDescriptionColor={COLORS.text}
          />
        </box>

        <box flexGrow={1} border borderStyle="rounded" borderColor={COLORS.border} title={file().path} titleColor={COLORS.dim}>
          <diff
            width="100%"
            height="100%"
            diff={file().patch}
            view="unified"
            filetype={file().filetype}
            showLineNumbers={true}
          />
        </box>
      </box>

      <box height={1} flexShrink={0} paddingLeft={1}>
        <text fg={COLORS.dim}>{` up/down select file  ·  q quit`}</text>
      </box>
    </box>
  )
}

export async function launch(): Promise<void> {
  // Initialize the tree-sitter client up front so the diff pane highlights on
  // the first frame. Failure is non-fatal: renderables fall back to plain text.
  await getTreeSitterClient().initialize().catch(() => {});
  await render(() => <ReviewApp />, { exitOnCtrlC: true })
}
