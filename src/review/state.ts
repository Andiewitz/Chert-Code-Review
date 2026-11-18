// Walk state, stored per repository at <gitdir>/chert/review-state.json.
//
// Three things live here and nowhere else:
//   - approvals: a file counts as approved only while the stored hash matches
//     the hash of its current patch. This is the one approval mechanism; the
//     old in-memory "reviewed" set used the same path+patchHash rule, so its
//     semantics carry over without a second store.
//   - walks: the plan, position and forked session per review source, so
//     reopening a review resumes where the developer stopped.
//   - cache: a validated file analysis per (session, path, patch hash), so
//     reopening or stepping back does not spend tokens again.

import { join } from "node:path"
import { readJson, writeJsonAtomic } from "../config"
import { gitDir } from "../git"
import { MAX_CACHED_ANALYSES } from "../limits"
import type { FileAnalysis } from "./protocol"
import type { PlanOrderEntry } from "./protocol"

export interface Approval {
  path: string
  approvedPatchHash: string
  approvedAt: number
}

export type WalkMode = "author-context" | "fresh"

export interface WalkRecord {
  harnessId: string
  forkedSessionId: string
  mode: WalkMode
  plan: PlanOrderEntry[]
  position: number
  updatedAt: number
}

interface CacheEntry {
  at: number
  analysis: FileAnalysis
}

export interface ReviewState {
  version: 1
  approvals: Record<string, Approval>
  walks: Record<string, WalkRecord>
  cache: Record<string, CacheEntry>
}

/** Stable identity for a patch: the approval store and the cache both key on it. */
export function patchHash(patch: string): string {
  return new Bun.CryptoHasher("sha256").update(patch).digest("hex")
}

export function statePath(root: string): string {
  return join(gitDir(root), "chert", "review-state.json")
}

export function emptyState(): ReviewState {
  return { version: 1, approvals: {}, walks: {}, cache: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readApprovals(raw: unknown): Record<string, Approval> {
  const approvals: Record<string, Approval> = {}
  if (!isRecord(raw)) return approvals
  for (const [path, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) continue
    if (typeof entry.approvedPatchHash !== "string") continue
    approvals[path] = {
      path,
      approvedPatchHash: entry.approvedPatchHash,
      approvedAt: typeof entry.approvedAt === "number" ? entry.approvedAt : 0,
    }
  }
  return approvals
}

function readWalks(raw: unknown): Record<string, WalkRecord> {
  const walks: Record<string, WalkRecord> = {}
  if (!isRecord(raw)) return walks
  for (const [key, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) continue
    if (typeof entry.forkedSessionId !== "string" || typeof entry.harnessId !== "string") continue
    const plan = Array.isArray(entry.plan)
      ? entry.plan
          .filter((item): item is PlanOrderEntry => isRecord(item) && typeof item.path === "string")
          .map((item) => ({ path: item.path, reason: typeof item.reason === "string" ? item.reason : "" }))
      : []
    walks[key] = {
      harnessId: entry.harnessId,
      forkedSessionId: entry.forkedSessionId,
      mode: entry.mode === "fresh" ? "fresh" : "author-context",
      plan,
      position: typeof entry.position === "number" ? entry.position : 0,
      updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : 0,
    }
  }
  return walks
}

function readCache(raw: unknown): Record<string, CacheEntry> {
  const cache: Record<string, CacheEntry> = {}
  if (!isRecord(raw)) return cache
  for (const [key, entry] of Object.entries(raw)) {
    if (!isRecord(entry) || !isRecord(entry.analysis)) continue
    cache[key] = {
      at: typeof entry.at === "number" ? entry.at : 0,
      analysis: entry.analysis as unknown as FileAnalysis,
    }
  }
  return cache
}

/** Read the state; a missing or malformed file is an empty state, not an error. */
export function loadReviewState(root: string): ReviewState {
  const raw = readJson<unknown>(statePath(root))
  if (!isRecord(raw)) return emptyState()
  return {
    version: 1,
    approvals: readApprovals(raw.approvals),
    walks: readWalks(raw.walks),
    cache: readCache(raw.cache),
  }
}

export function saveReviewState(root: string, state: ReviewState): void {
  writeJsonAtomic(statePath(root), state)
}

export function isApproved(state: ReviewState, path: string, hash: string): boolean {
  return state.approvals[path]?.approvedPatchHash === hash
}

/** Return the state with `path` approved for `hash`. Mutates in place. */
export function setApproval(state: ReviewState, path: string, hash: string, at = Date.now()): ReviewState {
  state.approvals[path] = { path, approvedPatchHash: hash, approvedAt: at }
  return state
}

export function clearApproval(state: ReviewState, path: string): ReviewState {
  delete state.approvals[path]
  return state
}

/** Number of changed files whose stored approval no longer matches, dropped. */
export function pruneApprovals(state: ReviewState, current: Map<string, string>): number {
  let dropped = 0
  for (const [path, approval] of Object.entries(state.approvals)) {
    const hash = current.get(path)
    if (hash === undefined || hash !== approval.approvedPatchHash) {
      delete state.approvals[path]
      dropped += 1
    }
  }
  return dropped
}

export function approvalCount(state: ReviewState): number {
  return Object.keys(state.approvals).length
}

export function cacheKey(sessionId: string, path: string, hash: string): string {
  return `${sessionId}|${path}|${hash}`
}

export function getCachedAnalysis(
  state: ReviewState,
  sessionId: string,
  path: string,
  hash: string,
): FileAnalysis | undefined {
  return state.cache[cacheKey(sessionId, path, hash)]?.analysis
}

/** Cache one analysis, dropping the oldest entries past the cap. */
export function putCachedAnalysis(
  state: ReviewState,
  sessionId: string,
  path: string,
  hash: string,
  analysis: FileAnalysis,
): void {
  state.cache[cacheKey(sessionId, path, hash)] = { at: Date.now(), analysis }
  const entries = Object.entries(state.cache)
  if (entries.length <= MAX_CACHED_ANALYSES) return
  entries
    .sort((a, b) => a[1].at - b[1].at)
    .slice(0, entries.length - MAX_CACHED_ANALYSES)
    .forEach(([key]) => delete state.cache[key])
}

/** Key used to remember a review source's plan and position. */
export function sourceKey(kind: string, detail: string): string {
  return detail === "" ? kind : `${kind}:${detail}`
}

export function getWalk(state: ReviewState, key: string): WalkRecord | undefined {
  return state.walks[key]
}

/** Record progress for a review source. Mutates in place. */
export function saveWalk(state: ReviewState, key: string, record: Omit<WalkRecord, "updatedAt">): WalkRecord {
  const saved: WalkRecord = { ...record, updatedAt: Date.now() }
  state.walks[key] = saved
  return saved
}

/** Forget a walk (the session or harness is unusable); the approvals stay. */
export function clearWalk(state: ReviewState, key: string): void {
  delete state.walks[key]
}
