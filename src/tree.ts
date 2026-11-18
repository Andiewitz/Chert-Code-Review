// Project tree: the entire working directory rendered as a nested list with
// box-drawing connectors. The file set comes from git (tracked + untracked,
// which respects .gitignore); outside a repository the filesystem is walked
// directly. Locally changed files carry their git-style marker (M/D/??).

import { lstatSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { isGitRepository, listProjectFiles } from "./git"
import { tryOr } from "./best-effort"
import { lastPathSegment } from "./paths"

export interface TreeLine {
  text: string
  /** Project-relative path, or undefined for the root and notice lines. */
  path: string | undefined
  isDir: boolean
}

/** Cap the rendered lines so a huge checkout can't stall the UI. */
const MAX_ENTRIES = 4000

// Directories skipped by the filesystem fallback. When a git repo is present,
// git's own ignore rules handle this instead.
const FS_IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  "target",
  "build",
  "out",
  "__pycache__",
  ".venv",
  "venv",
  ".next",
  "coverage",
])

interface TreeNode {
  name: string
  /** Project-relative path with "/" separators. */
  path: string
  isDir: boolean
  children: TreeNode[]
  /** Child lookup by `${isDir ? "d" : "f"}:${name}` so building stays linear. */
  byKey: Map<string, TreeNode>
}

/** Every file in the project, project-relative with "/" separators. */
function projectFiles(): string[] {
  if (isGitRepository()) {
    return listProjectFiles()
  }
  const out: string[] = []
  walkFs(process.cwd(), "", out)
  return out.sort((a, b) => a.localeCompare(b))
}

function walkFs(dir: string, prefix: string, out: string[]): void {
  // An unreadable directory is not an error worth stopping the walk for.
  const names = tryOr<string[] | undefined>(() => readdirSync(dir), undefined)
  if (names === undefined) return
  names.sort((a, b) => a.localeCompare(b))
  for (const name of names) {
    if (FS_IGNORE.has(name)) continue
    const full = join(dir, name)
    const rel = prefix === "" ? name : `${prefix}/${name}`
    // A file that vanished mid-walk simply is not listed.
    tryOr(() => {
      const info = lstatSync(full)
      // Symlinks are listed as files and never recursed into, so link
      // cycles can't hang the walk.
      if (info.isDirectory()) walkFs(full, rel, out)
      else out.push(rel)
      return true
    }, false)
  }
}

function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = {
    name: lastPathSegment(process.cwd()),
    path: "",
    isDir: true,
    children: [],
    byKey: new Map(),
  }
  for (const path of paths) {
    const parts = path.split("/")
    let node = root
    for (let depth = 0; depth < parts.length; depth += 1) {
      const isDir = depth < parts.length - 1
      const name = parts[depth]
      const key = `${isDir ? "d" : "f"}:${name}`
      let child = node.byKey.get(key)
      if (child === undefined) {
        child = { name, path: parts.slice(0, depth + 1).join("/"), isDir, children: [], byKey: new Map() }
        node.children.push(child)
        node.byKey.set(key, child)
      }
      node = child
    }
  }
  sortChildren(root)
  return root
}

/** Dirs first, then files, each alphabetically. */
function sortChildren(node: TreeNode): void {
  node.children.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)))
  for (const child of node.children) sortChildren(child)
}

function countNodes(node: TreeNode): number {
  let count = 1
  for (const child of node.children) count += countNodes(child)
  return count
}

function flatten(node: TreeNode, prefix: string, out: TreeLine[], changed: Map<string, string>): void {
  for (let i = 0; i < node.children.length; i += 1) {
    if (out.length >= MAX_ENTRIES) return
    const child = node.children[i]
    const isLast = i === node.children.length - 1
    const glyph = child.isDir ? undefined : changed.get(child.path)
    out.push({
      text: `${prefix}${isLast ? "└── " : "├── "}${child.name}${child.isDir ? "/" : ""}${glyph === undefined ? "" : `  ${glyph}`}`,
      path: child.isDir ? undefined : child.path,
      isDir: child.isDir,
    })
    flatten(child, prefix + (isLast ? "    " : "│   "), out, changed)
  }
}

/** Build the display lines for the tree view. `changed` maps a project
 * relative path to its status glyph ("M", "D", "??", "A"). */
export function buildTreeLines(changed: Map<string, string>): TreeLine[] {
  const paths = projectFiles()
  // Deleted files may already be gone from the listing; merge any changed
  // path it missed so their markers are never lost.
  for (const path of changed.keys()) {
    if (!paths.includes(path)) paths.push(path)
  }
  if (paths.length === 0) {
    return [{ text: "(no files)", path: undefined, isDir: false }]
  }

  const root = buildTree(paths)
  const out: TreeLine[] = [{ text: `${root.name}/`, path: undefined, isDir: true }]
  flatten(root, "", out, changed)

  const total = countNodes(root)
  if (out.length < total) {
    out.push({ text: `… ${total - out.length} more entries hidden`, path: undefined, isDir: false })
  }
  return out
}
