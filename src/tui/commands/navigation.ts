// Navigation commands: which project and which file the review is looking at.
// Failures stay on the current screen: they report through `showError`, never
// by switching the view to the transcript.

import { basename } from "node:path"
import { displayPath, forgetProject, loadRecent, parseCdArgument, resolveProject } from "../../projects"
import type { CommandContext } from "./context"

const NO_PROJECT = "No project open. Press Esc, then pick Pick another project."

export function refreshCommand(ctx: CommandContext): void {
  if (!ctx.hasProject()) {
    ctx.showError(NO_PROJECT)
    return
  }
  ctx.refresh()
  ctx.setStatus(`refreshed ${ctx.files().length} files`)
}

export function openCommand(ctx: CommandContext): void {
  if (!ctx.hasProject()) {
    ctx.showError(NO_PROJECT)
    return
  }
  const query = ctx.args.toLowerCase()
  const list = ctx.files()
  const index = list.findIndex(
    (file) =>
      file.path.toLowerCase() === query ||
      file.path.toLowerCase().endsWith(query) ||
      file.path.toLowerCase().includes(query),
  )
  if (index === -1) {
    ctx.showError(`no file matching "${ctx.args}"`)
    return
  }
  ctx.setView("review")
  ctx.selectFile(index)
  ctx.setStatus(`→ ${list[index].path}`)
}

export function treeCommand(ctx: CommandContext): void {
  if (!ctx.hasProject()) {
    ctx.showError(NO_PROJECT)
    return
  }
  ctx.openTree()
}

export function cwdCommand(ctx: CommandContext): void {
  ctx.showNotice(`project: ${ctx.projectRoot()}`)
}

export function projectsCommand(ctx: CommandContext): void {
  ctx.listProjects()
}

/** /cd: no argument lists projects, "-" goes back, otherwise open or explain. */
export function cdCommand(ctx: CommandContext): void {
  const rest = ctx.args
  if (rest === "") {
    ctx.listProjects()
    return
  }

  if (rest === "-") {
    const target = ctx.previousProjectPath()
    if (target === null) {
      ctx.showError("No previous project.")
      return
    }
    const root = ctx.openProjectAt(target)
    if (root === undefined) {
      ctx.showError(`that folder isn't a git project: ${target}`)
      return
    }
    ctx.setStatus(`opened ${basename(root) || root}`)
    ctx.addEntry("system", `project: ${root}`)
    return
  }

  const query = parseCdArgument(rest)
  const result = resolveProject(query)
  if (result.kind === "open") {
    const root = ctx.openProjectAt(result.root)
    if (root === undefined) {
      ctx.showError(`that folder isn't a git project: ${result.root}`)
      return
    }
    ctx.setStatus(`opened ${result.name}`)
    ctx.addEntry("system", `project: ${result.root}`)
    return
  }
  if (result.kind === "ambiguous") {
    const lines = result.matches.map(
      (match) => `  ${basename(match.path).padEnd(20)}  ${displayPath(match.path)}`,
    )
    ctx.showError(
      `Several saved projects match "${query}":\n${lines.join("\n")}\ntype more letters or the full path`,
    )
    return
  }
  if (result.kind === "contains") {
    ctx.showNotice(
      `That folder isn't a git project, but it contains: ${result.repoNames.join(", ")}. Try /cd ${result.repoNames[0]}.`,
    )
    return
  }
  ctx.showError(`No project or folder called "${query}". Type /cd alone to see your saved projects.`)
}

/** /forget accepts a name or a path; the raw name is tried first. */
export function forgetCommand(ctx: CommandContext): void {
  const rest = ctx.args
  if (rest === "") {
    ctx.showError("usage: /forget <name or path>")
    return
  }
  const rawName = rest.trim()
  const query = parseCdArgument(rest)
  const recents = loadRecent()
  let match = recents.find(
    (recent) =>
      basename(recent.path).toLowerCase() === rawName.toLowerCase() ||
      recent.path === query ||
      basename(recent.path).toLowerCase() === query.toLowerCase(),
  )
  if (match === undefined) {
    const matches = recents.filter((recent) =>
      basename(recent.path).toLowerCase().includes(query.toLowerCase()),
    )
    if (matches.length === 1) {
      match = matches[0]
    } else if (matches.length > 1) {
      ctx.showError(`Several saved projects match "${query}". Type more letters.`)
      return
    }
  }
  if (match === undefined) {
    ctx.showError(`No saved project called "${query}".`)
    return
  }
  forgetProject(match.path)
  ctx.showNotice(`removed from your list: ${basename(match.path)} (your files were not touched)`)
}
