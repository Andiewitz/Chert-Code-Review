import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  approvalCount,
  emptyState,
  getCachedAnalysis,
  getWalk,
  isApproved,
  loadReviewState,
  patchHash,
  pruneApprovals,
  putCachedAnalysis,
  saveReviewState,
  saveWalk,
  setApproval,
  sourceKey,
  statePath,
} from "./state"

const repos: string[] = []

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "chert-state-"))
  repos.push(dir)
  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir })
  git(["init", "-b", "main"])
  writeFileSync(join(dir, "a.txt"), "one\n")
  return dir
}

afterAll(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true })
})

function analysis(path: string) {
  return {
    path,
    intent: "intent",
    summary: "summary",
    walkthrough: [],
    concerns: [],
    assumptions: [],
    questions: [],
  }
}

describe("approvals", () => {
  test("an approved file survives a reload while its patch does not change", () => {
    const repo = tempRepo()
    const hash = patchHash("patch A")
    const state = setApproval(emptyState(), "src/a.ts", hash, 1234)
    saveReviewState(repo, state)

    const reloaded = loadReviewState(repo)
    expect(isApproved(reloaded, "src/a.ts", hash)).toBe(true)
    expect(reloaded.approvals["src/a.ts"].approvedAt).toBe(1234)
  })

  test("a changed patch is not approved (the old reviewed-set rule)", () => {
    const repo = tempRepo()
    const state = setApproval(emptyState(), "src/a.ts", patchHash("patch A"))
    saveReviewState(repo, state)
    const reloaded = loadReviewState(repo)
    expect(isApproved(reloaded, "src/a.ts", patchHash("patch B"))).toBe(false)
    expect(isApproved(reloaded, "src/a.ts", patchHash("patch A"))).toBe(true)
  })

  test("pruning drops approvals for changed and vanished files", () => {
    const state = emptyState()
    setApproval(state, "kept.ts", "h1")
    setApproval(state, "changed.ts", "h1")
    setApproval(state, "gone.ts", "h1")
    const dropped = pruneApprovals(
      state,
      new Map([
        ["kept.ts", "h1"],
        ["changed.ts", "h2"],
      ]),
    )
    expect(dropped).toBe(2)
    expect(approvalCount(state)).toBe(1)
    expect(isApproved(state, "kept.ts", "h1")).toBe(true)
  })

  test("an unknown state file is an empty state", () => {
    const repo = tempRepo()
    mkdirSync(dirname(statePath(repo)), { recursive: true })
    writeFileSync(statePath(repo), "{\"version\": 1, \"approvals\": 7}")
    const state = loadReviewState(repo)
    expect(approvalCount(state)).toBe(0)
    expect(state.cache).toEqual({})
  })
})

describe("walks", () => {
  test("plan and position round-trip per source", () => {
    const repo = tempRepo()
    const state = emptyState()
    const key = sourceKey("commit", "abc123")
    saveWalk(state, key, {
      harnessId: "opencode",
      forkedSessionId: "ses_fork",
      mode: "author-context",
      plan: [{ path: "a.ts", reason: "first" }],
      position: 0,
    })
    saveReviewState(repo, state)

    const walk = getWalk(loadReviewState(repo), key)
    expect(walk?.forkedSessionId).toBe("ses_fork")
    expect(walk?.mode).toBe("author-context")
    expect(walk?.plan).toEqual([{ path: "a.ts", reason: "first" }])
    expect(walk?.updatedAt).toBeGreaterThan(0)
  })

  test("source keys keep kinds apart", () => {
    expect(sourceKey("working", "")).toBe("working")
    expect(sourceKey("commit", "abc")).toBe("commit:abc")
  })
})

describe("analysis cache", () => {
  test("is keyed by session, path and patch hash", () => {
    const state = emptyState()
    putCachedAnalysis(state, "ses_1", "a.ts", "h1", analysis("a.ts"))
    expect(getCachedAnalysis(state, "ses_1", "a.ts", "h1")?.intent).toBe("intent")
    expect(getCachedAnalysis(state, "ses_2", "a.ts", "h1")).toBeUndefined()
    expect(getCachedAnalysis(state, "ses_1", "a.ts", "h2")).toBeUndefined()
  })

  test("drops the oldest entries past the cap", () => {
    const state = emptyState()
    for (let i = 0; i < 45; i++) {
      putCachedAnalysis(state, "ses_1", `f${i}.ts`, `h${i}`, analysis(`f${i}.ts`))
    }
    expect(Object.keys(state.cache)).toHaveLength(40)
    expect(getCachedAnalysis(state, "ses_1", "f0.ts", "h0")).toBeUndefined()
    expect(getCachedAnalysis(state, "ses_1", "f44.ts", "h44")).toBeDefined()
  })
})
