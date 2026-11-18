// Review commands: what is being reviewed, the transcript, highlights and export.

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  commitParent,
  commitSubject,
  currentBranch,
  gitDir,
  mergeBase,
  resolveReviewBase,
  resolveSha,
  validateRef,
} from "../../git"
import type { Highlight } from "../../highlights"
import type { CommandContext } from "./context"

/** /review with no argument opens the picker; otherwise pick a source. */
export function reviewCommand(ctx: CommandContext): void {
  const tokens = ctx.args.split(/\s+/).filter(Boolean)
  const sub = (tokens[0] ?? "").toLowerCase()

  if (sub === "") {
    ctx.openReviewPicker()
    return
  }

  if (sub === "working") {
    ctx.applyReviewSource({ kind: "working" })
    ctx.setStatus("reviewing: uncommitted changes")
    return
  }
  if (sub === "staged") {
    ctx.applyReviewSource({ kind: "staged" })
    ctx.setStatus("reviewing: staged changes")
    return
  }
  if (sub === "last") {
    const sha = resolveSha("HEAD")
    if (sha === null) {
      ctx.addEntry("error", "No commits yet.")
      ctx.setView("log")
      return
    }
    ctx.applyReviewSource({ kind: "commit", sha, parent: commitParent(sha), subject: commitSubject(sha) })
    ctx.setStatus(`reviewing: commit ${sha.slice(0, 7)}`)
    return
  }
  if (sub === "commit") {
    const ref = tokens[1] ?? ""
    if (ref === "" || !validateRef(ref)) {
      ctx.addEntry("error", `Not a valid commit: "${ref}".`)
      ctx.setView("log")
      return
    }
    const sha = resolveSha(ref)
    if (sha === null) {
      ctx.addEntry("error", `Could not resolve "${ref}".`)
      ctx.setView("log")
      return
    }
    ctx.applyReviewSource({ kind: "commit", sha, parent: commitParent(sha), subject: commitSubject(sha) })
    ctx.setStatus(`reviewing: commit ${sha.slice(0, 7)}`)
    return
  }
  if (sub === "branch") {
    const baseArg = tokens.slice(1).join(" ").trim()
    let base: string | null
    if (baseArg !== "") {
      if (!validateRef(baseArg)) {
        ctx.addEntry("error", `Not a valid branch: "${baseArg}".`)
        ctx.setView("log")
        return
      }
      base = baseArg
    } else {
      base = resolveReviewBase()
    }
    if (base === null) {
      ctx.addEntry("error", "I couldn't find the main branch. Type /review branch <name>.")
      ctx.setView("log")
      return
    }
    const current = currentBranch()
    if (current === base) {
      ctx.addEntry("system", `You're already on ${base}; staying on uncommitted changes.`)
      ctx.setView("log")
      return
    }
    try {
      ctx.applyReviewSource({ kind: "branch", base, mergeBase: mergeBase(current, base) })
      ctx.setStatus(`reviewing: everything on ${current} since ${base}`)
    } catch {
      ctx.addEntry("error", `Could not find where ${current} split from ${base}.`)
      ctx.setView("log")
    }
    return
  }

  ctx.addEntry("error", `Unknown review source "${sub}". Try /review with no arguments.`)
  ctx.setView("log")
}

export function logCommand(ctx: CommandContext): void {
  ctx.setView("log")
}

/** /highlights lists saved highlights, or clears them with `clear yes`. */
export function highlightsCommand(ctx: CommandContext): void {
  const tokens = ctx.args.split(/\s+/).filter(Boolean)
  if (tokens[0] === "clear") {
    if (tokens[1] !== "yes") {
      ctx.addEntry(
        "system",
        `This will delete ${ctx.highlights().length} saved highlights. Type /highlights clear yes to confirm.`,
      )
      ctx.setView("log")
      return
    }
    ctx.clearHighlights()
    ctx.addEntry("system", "cleared all highlights")
    ctx.setView("log")
    return
  }

  const highlights = ctx.highlights()
  if (highlights.length === 0) {
    ctx.addEntry("system", "No highlights yet.")
    ctx.setView("log")
    return
  }
  const lines = highlights.map((highlight) => {
    const status = ctx.isHighlightOutdated(highlight.id) ? "outdated" : ""
    const who = highlight.by === "you" ? "you" : "AI " + highlight.level
    return `${highlight.path}:${highlight.start}-${highlight.end}  ${who}  ${highlight.note || "(no note)"}  ${status}`
  })
  ctx.addEntry("system", lines.join("\n"))
  ctx.setView("log")
}

/** /export writes the review notes to <gitdir>/chert/last-review.md. */
export function exportCommand(ctx: CommandContext): void {
  const lines: string[] = []
  lines.push("# chert review export")
  lines.push(`Project: ${ctx.projectRoot()}`)
  lines.push(`Reviewing: ${ctx.sourceLabel()}`)
  lines.push(`Date: ${new Date().toISOString()}`)
  lines.push("")

  const byFile = new Map<string, Highlight[]>()
  const highlights = ctx.highlights()
  for (const highlight of highlights) {
    const group = byFile.get(highlight.path)
    if (group === undefined) byFile.set(highlight.path, [highlight])
    else group.push(highlight)
  }
  for (const [path, group] of byFile) {
    lines.push(`## ${path}`)
    for (const highlight of group) {
      const who = highlight.by === "you" ? "you" : "AI " + highlight.level
      lines.push(`- ${who} lines ${highlight.start}-${highlight.end}: ${highlight.note || "(no note)"}`)
      for (const text of highlight.text) lines.push(`  > ${text}`)
    }
    lines.push("")
  }

  const markdown = lines.join("\n")
  try {
    const dir = join(gitDir(), "chert")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "last-review.md"), markdown)
    ctx.addEntry("system", `Exported to ${join(dir, "last-review.md")}\n\n${markdown}`)
  } catch (error) {
    ctx.addEntry("error", `export failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  ctx.setView("log")
}
