import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeHarness } from "../harness/fake"
import type { ReviewFile } from "../git"
import { PROTOCOL } from "./protocol"
import type { Anchor } from "./protocol"
import { emptyState } from "./state"
import type { ReviewState, WalkRecord } from "./state"
import { createWalk } from "./walk"

const repos: string[] = []

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "chert-walk-"))
  repos.push(dir)
  const git = (args: string[]) => {
    const proc = Bun.spawnSync(["git", ...args], { cwd: dir })
    if (proc.exitCode !== 0) throw new Error(proc.stderr.toString())
  }
  git(["init", "-b", "main"])
  git(["config", "user.email", "walk@example.com"])
  git(["config", "user.name", "walk"])
  writeFileSync(join(dir, "a.ts"), "const a = 1\nconst b = 2\n")
  git(["add", "."])
  git(["commit", "-m", "base"])
  writeFileSync(join(dir, "a.ts"), "const a = 1\nconst b = 20\n")
  return dir
}

afterAll(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true })
})

const FILES: ReviewFile[] = [{ path: "a.ts", status: "modified", additions: 1, deletions: 1 }]

const GOOD: Anchor = { side: "new", start: 2, end: 2, quote: "const b = 20" }
const BAD: Anchor = { side: "new", start: 2, end: 2, quote: "not in the diff" }

function planAnswer(order: string[]): string {
  return JSON.stringify({
    protocol: PROTOCOL,
    overview: "renames b",
    order: order.map((path) => ({ path, reason: `why ${path}` })),
  })
}

function fileAnswer(): string {
  return JSON.stringify({
    protocol: PROTOCOL,
    path: "a.ts",
    intent: "rename b",
    summary: "one value changed",
    walkthrough: [{ anchor: BAD, explanation: "this note has no line" }],
    concerns: [{ anchor: GOOD, level: "high", note: "check the default" }],
    assumptions: ["b is unused"],
    questions: ["why 20?"],
  })
}

interface Recorded {
  errors: string[]
  statuses: string[]
  plans: string[]
  files: { dropped: number; concerns: number; highlights: number }[]
  asks: string[]
}

function setup(options: { answer?: (request: string, call: number) => string; beforeAsk?: (call: number) => void } = {}) {
  const root = tempRepo()
  const harness =
    options.answer === undefined && options.beforeAsk === undefined
      ? createFakeHarness()
      : createFakeHarness(options)
  const state: ReviewState = emptyState()
  const recorded: Recorded = { errors: [], statuses: [], plans: [], files: [], asks: [] }
  const walk = createWalk({
    harness,
    projectRoot: root,
    files: FILES,
    source: { kind: "working" },
    sourceLabel: "working tree",
    walkKey: "working",
    baseSessionId: "ses_author",
    state,
    persist: () => undefined,
    callbacks: {
      status: (text) => recorded.statuses.push(text),
      error: (message) => recorded.errors.push(message),
      plan: (plan) => recorded.plans.push(plan.order.map((entry) => entry.path).join(",")),
      file: (result) =>
        recorded.files.push({
          dropped: result.dropped,
          concerns: result.analysis.concerns.length,
          highlights: result.highlights.length,
        }),
      ask: (answer, highlights) => recorded.asks.push(`${answer.text}|${highlights.length}`),
    },
  })
  return { root, harness, state, walk, recorded }
}

function answerByKind(valid: { plan: string; file: string; ask?: string }) {
  return (request: string): string => {
    if (request.includes("· plan")) return valid.plan
    if (request.includes("· file")) return valid.file
    return valid.ask ?? JSON.stringify({ protocol: PROTOCOL, text: "an answer", anchors: [GOOD] })
  }
}

describe("walk plan", () => {
  test("forks once, keeps the agent's order and stores progress", async () => {
    const { harness, state, walk, recorded } = setup({ answer: answerByKind({ plan: planAnswer(["a.ts"]), file: fileAnswer() }) })
    await walk.start()

    expect(walk.mode()).toBe("author-context")
    expect(walk.sessionId()).toBe("fake-fork-1")
    expect(recorded.plans).toEqual(["a.ts"])
    expect(recorded.errors).toEqual([])
    const walkRecord = state.walks.working as WalkRecord
    expect(walkRecord.forkedSessionId).toBe("fake-fork-1")
    expect(walkRecord.harnessId).toBe("fake")
    expect(harness.calls[0]).toMatchObject({ kind: "start", baseSessionId: "ses_author" })
  })

  test("appends a file the agent forgot instead of losing it", async () => {
    const files: ReviewFile[] = [
      ...FILES,
      { path: "b.ts", status: "added", additions: 3, deletions: 0 },
    ]
    const harness = createFakeHarness({ answer: answerByKind({ plan: planAnswer(["a.ts"]), file: fileAnswer() }) })
    const recorded: string[] = []
    const walk = createWalk({
      harness,
      projectRoot: tempRepo(),
      files,
      source: { kind: "working" },
      sourceLabel: "working tree",
      walkKey: "working",
      baseSessionId: "ses_author",
      state: emptyState(),
      persist: () => undefined,
      callbacks: {
        status: () => undefined,
        error: () => undefined,
        plan: (plan) => recorded.push(plan.order.map((entry) => `${entry.path}:${entry.reason}`).join(",")),
        file: () => undefined,
        ask: () => undefined,
      },
    })
    await walk.start()
    expect(recorded[0]).toBe("a.ts:why a.ts,b.ts:not in the agent's plan")
  })
})

describe("walk repair", () => {
  test("feeds validation errors back once and accepts the second answer", async () => {
    const { harness, walk, recorded } = setup({
      answer: (request) => {
        // The repair request quotes the problem, so it is answered correctly.
        if (request.includes("not valid")) return planAnswer(["a.ts"])
        if (request.includes("· plan")) return "not json at all"
        return fileAnswer()
      },
    })
    await walk.start()
    expect(recorded.plans).toEqual(["a.ts"])
    expect(harness.calls.filter((call) => call.kind === "ask")).toHaveLength(2)
    expect(recorded.errors).toEqual([])
  })

  test("reports a plan that is still invalid after the repair", async () => {
    const { walk, recorded } = setup({ answer: () => '{"protocol":"chert-review/1"}' })
    await walk.start()
    expect(recorded.plans).toEqual([])
    expect(recorded.errors[0]).toContain("The plan was not usable")
  })
})

describe("walk files", () => {
  test("verifies anchors, drops the ones that miss and caches the analysis", async () => {
    const { harness, walk, recorded } = setup({ answer: answerByKind({ plan: planAnswer(["a.ts"]), file: fileAnswer() }) })
    await walk.start()
    const first = await walk.analyze("a.ts")

    expect(first?.analysis.intent).toBe("rename b")
    expect(first?.analysis.assumptions).toEqual(["b is unused"])
    expect(recorded.files[0]).toEqual({ dropped: 1, concerns: 1, highlights: 1 })
    expect(first?.highlights[0]).toMatchObject({ path: "a.ts", start: 2, end: 2, level: "high", note: "check the default" })

    const asksBefore = harness.calls.filter((call) => call.kind === "ask").length
    await walk.analyze("a.ts")
    expect(harness.calls.filter((call) => call.kind === "ask")).toHaveLength(asksBefore)
  })

  test("prefetch warms the cache and the ask queue waits for it", async () => {
    const { harness, walk, recorded } = setup({ answer: answerByKind({ plan: planAnswer(["a.ts"]), file: fileAnswer() }) })
    await walk.start()
    walk.prefetch("a.ts")
    await walk.ask("is this safe?", "a.ts")
    // The ask ran after the prefetch, so the answer is there...
    expect(recorded.asks).toHaveLength(1)
    const asksBefore = harness.calls.filter((call) => call.kind === "ask").length
    // ...and the file it fetched is reused rather than asked for again.
    await walk.analyze("a.ts")
    expect(harness.calls.filter((call) => call.kind === "ask")).toHaveLength(asksBefore)
  })

  test("reports an answer whose anchors do not match the diff", async () => {
    const { walk, recorded } = setup({
      answer: answerByKind({
        plan: planAnswer(["a.ts"]),
        file: fileAnswer(),
        ask: JSON.stringify({ protocol: PROTOCOL, text: "look here", anchors: [BAD] }),
      }),
    })
    await walk.start()
    const answer = await walk.ask("why?")
    expect(answer?.text).toBe("look here")
    expect(recorded.asks).toEqual(["look here|0"])
  })
})

describe("walk tree guard", () => {
  test("stops the agent when the working tree changes during a call", async () => {
    const { root, walk, recorded } = setup({
      answer: answerByKind({ plan: planAnswer(["a.ts"]), file: fileAnswer() }),
      beforeAsk: (call) => {
        if (call === 1) writeFileSync(join(root, "a.ts"), "const a = 1\nconst b = 999\n")
      },
    })
    await walk.start()
    expect(recorded.errors[0]).toContain("the working tree changed")
    expect(recorded.plans).toEqual([])

    const after = await walk.analyze("a.ts")
    expect(after).toBeNull()
    expect(recorded.errors[1]).toContain("chert stopped the agent")
  })
})
