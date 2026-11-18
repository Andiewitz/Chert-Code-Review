import { describe, expect, test } from "bun:test"
import { createFakeHarness } from "./fake"

describe("fake harness", () => {
  test("forks a base session once and reports author context", async () => {
    const harness = createFakeHarness({ sessions: [{ id: "ses_author", title: "wrote it", updatedAt: 5 }] })
    expect(harness.listSessions("/repo")[0].id).toBe("ses_author")

    const session = await harness.start({ projectRoot: "/repo", baseSessionId: "ses_author" })
    expect(session.mode).toBe("author-context")
    expect(session.id).not.toBe("ses_author")
    expect(harness.calls[0]).toMatchObject({ kind: "start", baseSessionId: "ses_author" })

    await session.ask("first")
    await session.ask("second")
    expect(harness.calls.slice(1).map((call) => call.sessionId)).toEqual([session.id, session.id])
  })

  test("starts fresh without a base session", async () => {
    const harness = createFakeHarness()
    const session = await harness.start({ projectRoot: "/repo" })
    expect(session.mode).toBe("fresh")
    expect(harness.detect()).toEqual({ available: true, version: "0.0.0-fake" })
  })

  test("counts closes and answers scripted requests", async () => {
    const harness = createFakeHarness({ answer: (_request, call) => `answer ${call}` })
    const session = await harness.start({ projectRoot: "/repo" })
    expect(await session.ask("one")).toBe("answer 1")
    expect(await session.ask("two")).toBe("answer 2")
    session.close()
    session.close()
    expect(harness.closed).toBe(1)
    expect(await harness.askOnce("/repo", "three")).toBe("answer 3")
  })

  test("can refuse a call", async () => {
    const harness = createFakeHarness({ failOn: [1] })
    const session = await harness.start({ projectRoot: "/repo" })
    await expect(session.ask("boom")).rejects.toThrow("refused call 1")
  })
})
