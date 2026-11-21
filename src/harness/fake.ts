// A harness adapter with no CLI behind it. Tests drive the walk controller,
// the repair retry and the tree guard through this, so the controller is proven
// without spending tokens or depending on an installed harness.

import type { HarnessAdapter, HarnessDetection, ReviewSession, SessionInfo, StartOptions } from "./types"

export interface FakeCall {
  kind: "start" | "ask" | "askOnce"
  sessionId?: string
  baseSessionId?: string
  request?: string
}

export interface FakeHarnessOptions {
  id?: string
  label?: string
  available?: boolean
  version?: string
  sessions?: SessionInfo[]
  /** Answer for a request. Return a JSON string in the protocol's shape. */
  answer?: (request: string, call: number) => string
  /** Runs before each answer, so a test can change the working tree. */
  beforeAsk?: (call: number) => void
  /** Throw instead of answering on these call numbers (1-based). */
  failOn?: number[]
}

export interface FakeHarness extends HarnessAdapter {
  calls: FakeCall[]
  started: number
  closed: number
}

interface FakeState {
  calls: FakeCall[]
  asks: number
  sessions: number
  closed: number
}

/** Every fake answer goes through here, so hooks and failures are uniform. */
function makeAnswer(state: FakeState, options: FakeHarnessOptions): (request: string) => string {
  return (request: string): string => {
    state.asks += 1
    options.beforeAsk?.(state.asks)
    if (options.failOn?.includes(state.asks) === true) {
      throw new Error(`fake harness refused call ${state.asks}`)
    }
    if (options.answer !== undefined) return options.answer(request, state.asks)
    return JSON.stringify({ protocol: "chert-review/1", text: "ok" })
  }
}

function makeSession(
  state: FakeState,
  options: FakeHarnessOptions,
  startOptions: StartOptions,
): ReviewSession {
  state.sessions += 1
  const mode = startOptions.baseSessionId === undefined ? "fresh" : "author-context"
  const id = `${mode === "fresh" ? "fake-new" : "fake-fork"}-${state.sessions}`
  state.calls.push({ kind: "start", sessionId: id, baseSessionId: startOptions.baseSessionId })
  const answer = makeAnswer(state, options)
  let closed = false
  return {
    id,
    mode,
    async ask(request: string): Promise<string> {
      state.calls.push({ kind: "ask", sessionId: id, request })
      return answer(request)
    },
    close(): void {
      if (closed) return
      closed = true
      state.closed += 1
    },
  }
}

export function createFakeHarness(options: FakeHarnessOptions = {}): FakeHarness {
  const state: FakeState = { calls: [], asks: 0, sessions: 0, closed: 0 }
  const answer = makeAnswer(state, options)
  const adapter = {
    id: options.id ?? "fake",
    label: options.label ?? "Fake harness",
    calls: state.calls,
    get started(): number {
      return state.sessions
    },
    get closed(): number {
      return state.closed
    },
    detect: async (): Promise<HarnessDetection> => {
      return { available: options.available ?? true, version: options.version ?? "0.0.0-fake" }
    },
    listSessions(_projectRoot: string): SessionInfo[] {
      return options.sessions ?? []
    },
    start: async (startOptions: StartOptions): Promise<ReviewSession> =>
      makeSession(state, options, startOptions),
    askOnce: async (_projectRoot: string, request: string): Promise<string> => {
      state.calls.push({ kind: "askOnce", request })
      return answer(request)
    },
  }
  return adapter
}
