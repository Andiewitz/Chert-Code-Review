import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { configDir } from "./connectors";

export interface RecentProject {
  path: string;
  lastOpened: number;
}

interface ProjectsFile {
  recent?: RecentProject[];
}

/** Expand a user-entered path: strips surrounding quotes, expands "~"/"~/...",
 * resolves relative paths against `base`, and normalizes to an absolute path. */
export function expandPath(input: string, base = process.cwd()): string {
  let p = input.trim();
  if (
    (p.startsWith('"') && p.endsWith('"') && p.length >= 2) ||
    (p.startsWith("'") && p.endsWith("'") && p.length >= 2)
  ) {
    p = p.slice(1, -1);
  }
  if (p === "~") {
    p = homedir();
  } else if (p.startsWith("~/") || p.startsWith("~\\")) {
    p = resolve(homedir(), p.slice(2));
  }
  if (!isAbsolute(p)) {
    p = resolve(base, p);
  } else {
    p = resolve(p);
  }
  return p;
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function toReal(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Resolve the git repository root for `dir`.
 * Returns the realpath'd root, or undefined when `dir` is missing, not a
 * repository, or git fails. Never throws. */
export function resolveProjectRoot(dir: string): string | undefined {
  try {
    const d = expandPath(dir);
    if (!isDirectory(d)) return undefined;
    const proc = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      cwd: d,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return undefined;
    const out = proc.stdout.toString().trim();
    if (out === "") return undefined;
    return toReal(out);
  } catch {
    return undefined;
  }
}

/** Replace the home directory prefix with "~" for display. */
export function displayPath(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(home + "/") || path.startsWith(home + "\\")) {
    return "~" + path.slice(home.length);
  }
  return path;
}

function projectsFile(): string {
  return join(configDir(), "projects.json");
}

function saveRecent(list: RecentProject[]): void {
  try {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(projectsFile(), `${JSON.stringify({ recent: list } satisfies ProjectsFile, null, 2)}\n`);
  } catch {
    // write failure must never break startup
  }
}

export function loadRecent(): RecentProject[] {
  try {
    const raw = readFileSync(projectsFile(), "utf8");
    const parsed = JSON.parse(raw) as ProjectsFile;
    const items = Array.isArray(parsed?.recent) ? parsed.recent : [];
    const cleaned = items
      .filter((r): r is RecentProject => typeof r?.path === "string" && typeof r?.lastOpened === "number")
      .sort((a, b) => b.lastOpened - a.lastOpened);
    const seen = new Set<string>();
    const out: RecentProject[] = [];
    for (const r of cleaned) {
      const abs = resolve(r.path);
      if (!isDirectory(abs)) continue;
      const real = toReal(abs);
      if (seen.has(real)) continue;
      seen.add(real);
      out.push({ path: abs, lastOpened: r.lastOpened });
      if (out.length >= 20) break;
    }
    return out;
  } catch {
    return [];
  }
}

export function rememberProject(path: string): void {
  try {
    const abs = resolve(expandPath(path));
    const real = toReal(abs);
    const list = loadRecent().filter((r) => toReal(r.path) !== real);
    list.unshift({ path: abs, lastOpened: Date.now() });
    saveRecent(list.slice(0, 20));
  } catch {
    // must never break startup/opening
  }
}

export function forgetProject(path: string): void {
  try {
    const real = toReal(resolve(expandPath(path)));
    const list = loadRecent().filter((r) => toReal(r.path) !== real);
    saveRecent(list);
  } catch {
    // ignore
  }
}

/** Immediate child folders that contain a ".git" entry (file or folder).
 * Skips dot-names and node_modules. Alphabetical, capped at 50. No git calls. */
export function findReposBelow(dir: string): string[] {
  try {
    const base = resolve(expandPath(dir));
    let names: string[];
    try {
      names = readdirSync(base);
    } catch {
      return [];
    }
    const out: Array<{ name: string; path: string }> = [];
    for (const name of names) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const child = join(base, name);
      try {
        const st = lstatSync(child);
        if (!st.isDirectory() && !st.isSymbolicLink()) continue;
        // treat symlink as candidate dir if it points to a dir
        if (st.isSymbolicLink()) {
          try {
            if (!statSync(child).isDirectory()) continue;
          } catch {
            continue;
          }
        }
      } catch {
        continue;
      }
      try {
        lstatSync(join(child, ".git"));
      } catch {
        continue;
      }
      out.push({ name, path: child });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out.slice(0, 50).map((e) => e.path);
  } catch {
    return [];
  }
}

/** Resolve `dir` to a repo root and chdir into it. Returns the root on
 * success, or undefined if `dir` is not inside a git repository. */
export function enterProject(dir: string): string | undefined {
  const root = resolveProjectRoot(dir);
  if (root === undefined) return undefined;
  try {
    process.chdir(root);
  } catch {
    return undefined;
  }
  try {
    rememberProject(root);
  } catch {
    // remembering must never break opening
  }
  return root;
}
