import { lstatSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, isAbsolute, join, resolve } from "node:path"
import { configDir, readJson, writeJsonAtomic } from "./config"
import { run } from "./git"
import { MAX_CONTAINED_REPOS, MAX_RECENT_PROJECTS } from "./limits"
import { toRealPath } from "./paths"
import { bestEffort, tryOr } from "./best-effort"

export interface RecentProject {
  path: string
  lastOpened: number
}

interface ProjectsFile {
  recent?: RecentProject[]
}

/** Expand a user-entered path: strips surrounding quotes, expands "~"/"~/...",
 * resolves relative paths against `base`, and normalizes to an absolute path. */
export function expandPath(input: string, base = process.cwd()): string {
  let p = input.trim()
  if (
    (p.startsWith('"') && p.endsWith('"') && p.length >= 2) ||
    (p.startsWith("'") && p.endsWith("'") && p.length >= 2)
  ) {
    p = p.slice(1, -1)
  }
  if (p === "~") {
    p = homedir()
  } else if (p.startsWith("~/") || p.startsWith("~\\")) {
    p = resolve(homedir(), p.slice(2))
  }
  if (!isAbsolute(p)) {
    p = resolve(base, p)
  } else {
    p = resolve(p)
  }
  return p
}

export function isDirectory(path: string): boolean {
  return tryOr(() => statSync(path).isDirectory(), false)
}

/** Resolve the git repository root for `dir`.
 * Returns the realpath'd root, or undefined when `dir` is missing, not a
 * repository, or git fails. Never throws. */
export function resolveProjectRoot(dir: string): string | undefined {
  // Not a repository (or unreadable): the caller shows the home screen.
  return tryOr(() => {
    const d = expandPath(dir)
    if (!isDirectory(d)) return undefined
    const out = run(d, ["rev-parse", "--show-toplevel"]).trim()
    if (out === "") return undefined
    return toRealPath(out)
  }, undefined)
}

/** Replace the home directory prefix with "~" for display. */
export function displayPath(path: string): string {
  const home = homedir()
  if (path === home) return "~"
  if (path.startsWith(home + "/") || path.startsWith(home + "\\")) {
    return "~" + path.slice(home.length)
  }
  return path
}

function projectsFile(): string {
  return join(configDir(), "projects.json")
}

function saveRecent(list: RecentProject[]): void {
  bestEffort("save the recent-projects list", () =>
    writeJsonAtomic(projectsFile(), { recent: list } satisfies ProjectsFile),
  )
}

export function loadRecent(): RecentProject[] {
  // An unreadable projects file means "no recents", not a startup failure.
  return tryOr(() => {
    const parsed = readJson<ProjectsFile>(projectsFile())
    const items = Array.isArray(parsed?.recent) ? parsed.recent : []
    const cleaned = items
      .filter((r): r is RecentProject => typeof r?.path === "string" && typeof r?.lastOpened === "number")
      .sort((a, b) => b.lastOpened - a.lastOpened)
    const seen = new Set<string>()
    const out: RecentProject[] = []
    for (const r of cleaned) {
      const abs = resolve(r.path)
      if (!isDirectory(abs)) continue
      const real = toRealPath(abs)
      if (seen.has(real)) continue
      seen.add(real)
      out.push({ path: abs, lastOpened: r.lastOpened })
      if (out.length >= MAX_RECENT_PROJECTS) break
    }
    return out
  }, [])
}

export function rememberProject(path: string): void {
  bestEffort("remember the opened project", () => {
    const abs = resolve(expandPath(path))
    const real = toRealPath(abs)
    const list = loadRecent().filter((r) => toRealPath(r.path) !== real)
    list.unshift({ path: abs, lastOpened: Date.now() })
    saveRecent(list.slice(0, MAX_RECENT_PROJECTS))
  })
}

export function forgetProject(path: string): void {
  bestEffort("forget a saved project", () => {
    const real = toRealPath(resolve(expandPath(path)))
    const list = loadRecent().filter((r) => toRealPath(r.path) !== real)
    saveRecent(list)
  })
}

/** Immediate child folders that contain a ".git" entry (file or folder).
 * Skips dot-names and node_modules. Alphabetical, capped at 50. No git calls. */
export function findReposBelow(dir: string): string[] {
  // Unresolvable directory: there is nothing to list.
  return tryOr(() => {
    const base = resolve(expandPath(dir))
    const names = tryOr<string[] | undefined>(() => readdirSync(base), undefined)
    if (names === undefined) return []
    const out: Array<{ name: string; path: string }> = []
    for (const name of names) {
      if (name.startsWith(".") || name === "node_modules") continue
      const child = join(base, name)
      // A child we cannot stat is not a candidate repository.
      const st = tryOr(() => lstatSync(child), undefined)
      if (st === undefined) continue
      if (!st.isDirectory() && !st.isSymbolicLink()) continue
      // treat symlink as candidate dir if it points to a dir
      if (st.isSymbolicLink() && !tryOr(() => statSync(child).isDirectory(), false)) continue
      if (!tryOr(() => !!lstatSync(join(child, ".git")), false)) continue
      out.push({ name, path: child })
    }
    out.sort((a, b) => a.name.localeCompare(b.name))
    return out.slice(0, MAX_CONTAINED_REPOS).map((e) => e.path)
  }, [])
}

export type ResolveResult =
  | { kind: "open"; root: string; name: string }
  | { kind: "ambiguous"; matches: RecentProject[] }
  | { kind: "contains"; repoNames: string[] }
  | { kind: "none"; query: string }

/** Parse a /cd argument: strip matching quotes, handle backslash-space escapes
 * (non-Windows), expand "~", strip trailing slashes. */
export function parseCdArgument(raw: string): string {
  let p = raw.trim()
  if (p.length >= 2 && ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'")))) {
    p = p.slice(1, -1)
  } else if (process.platform !== "win32") {
    p = p.replace(/\\ /g, " ")
  }
  p = expandPath(p)
  p = p.replace(/[\\/]+$/, "")
  return p
}

/** Successively looser ways to match a project name against a query. */
const NAME_TIERS: Array<(name: string, query: string) => boolean> = [
  (name, query) => name === query,
  (name, query) => name.startsWith(query),
  (name, query) => name.includes(query),
]

/**
 * Resolve a /cd query to a decision. Pure: it never chdirs and never touches
 * the recent list, so callers decide when a project is really opened.
 */
export function resolveProject(query: string): ResolveResult {
  const q = query.trim()
  const expanded = expandPath(q)
  if (isDirectory(expanded)) {
    const root = resolveProjectRoot(expanded)
    if (root !== undefined) {
      return { kind: "open", root, name: basename(root) || root }
    }
    const repos = findReposBelow(expanded)
    if (repos.length > 0) {
      return { kind: "contains", repoNames: repos.map((r) => basename(r)) }
    }
    return { kind: "none", query: q }
  }

  const recents = loadRecent()
  const lower = q.toLowerCase()
  for (const tier of NAME_TIERS) {
    const matches = recents.filter((recent) => tier(basename(recent.path).toLowerCase(), lower))
    if (matches.length > 1) return { kind: "ambiguous", matches }
    if (matches.length !== 1) continue
    // A saved path may have vanished or stopped being a repository; if so,
    // fall through to the next, looser tier just as a failed open used to.
    const root = resolveProjectRoot(expandPath(matches[0].path))
    if (root !== undefined) return { kind: "open", root, name: basename(root) || root }
  }
  return { kind: "none", query: q }
}

/** Resolve `dir` to a repo root, chdir into it and remember it. Returns the
 * root, or undefined when `dir` is not inside a git repository. */
/**
 * Resolve the repository root for `dir` and remember it as recent. Deliberately
 * does not chdir: every git call takes the root explicitly, and the agent
 * subprocess gets its working directory as a spawn option.
 */
export function openProject(dir: string): string | undefined {
  const root = resolveProjectRoot(dir)
  if (root === undefined) return undefined
  rememberProject(root)
  return root
}
