// The walk protocol: one versioned JSON contract between chert and a coding
// harness. Hand-written validators (no new dependency), because the whole point
// is to reject anything we cannot place on a line of the diff.
//
// Unknown fields are ignored; a missing `protocol` is read as version 1 so a
// terse model answer is not thrown away, but any other version is an error.

import {
  MAX_ANCHOR_RANGE,
  MAX_FILE_ASSUMPTIONS,
  MAX_FILE_CONCERNS,
  MAX_FILE_QUESTIONS,
  MAX_NOTE_CHARS,
  MAX_WALKTHROUGH_ITEMS,
} from "../limits"

export const PROTOCOL = "chert-review/1"

export type RequestType = "plan" | "file" | "ask"
export type AnchorSide = "new" | "old"
export type ConcernLevel = "high" | "medium" | "low"

/** A range in the diff. `quote` is the exact text of its first line. */
export interface Anchor {
  side: AnchorSide
  start: number
  end: number
  quote: string
}

export interface PlanOrderEntry {
  path: string
  reason: string
}

export interface PlanResponse {
  overview: string
  order: PlanOrderEntry[]
}

export interface WalkthroughItem {
  anchor: Anchor
  explanation: string
}

export interface Concern {
  anchor: Anchor
  level: ConcernLevel
  note: string
}

export interface FileAnalysis {
  path: string
  intent: string
  summary: string
  walkthrough: WalkthroughItem[]
  concerns: Concern[]
  assumptions: string[]
  questions: string[]
}

export interface AskResponse {
  text: string
  anchors: Anchor[]
}

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A trimmed string, or "" for anything that is not a string. */
function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/** Keep at most `max` characters; notes are clipped rather than rejected. */
function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

function checkProtocol(raw: Record<string, unknown>, errors: string[]): void {
  const declared = raw.protocol
  if (declared === undefined) return
  if (declared !== PROTOCOL) {
    errors.push(`protocol must be "${PROTOCOL}"`)
  }
}

function readAnchor(raw: unknown, where: string, errors: string[]): Anchor | null {
  if (!isRecord(raw)) {
    errors.push(`${where} must be an object`)
    return null
  }
  const side = raw.side === "old" ? "old" : raw.side === "new" ? "new" : null
  if (side === null) errors.push(`${where}.side must be "new" or "old"`)
  const start = typeof raw.start === "number" ? raw.start : NaN
  const end = typeof raw.end === "number" ? raw.end : start
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    errors.push(`${where} needs integer lines with start >= 1 and end >= start`)
    return null
  }
  if (end - start + 1 > MAX_ANCHOR_RANGE) {
    errors.push(`${where} spans ${end - start + 1} lines (max ${MAX_ANCHOR_RANGE})`)
    return null
  }
  const quote = textOf(raw.quote)
  if (quote === "") {
    errors.push(`${where}.quote must be the exact text of the first line`)
    return null
  }
  if (side === null) return null
  // Only the first line is compared, so a multi-line quote is reduced to it.
  return { side, start, end, quote: quote.split("\n")[0] }
}

function readPlanOrder(raw: unknown, errors: string[]): PlanOrderEntry[] {
  if (!Array.isArray(raw)) {
    errors.push("order must be an array")
    return []
  }
  const order: PlanOrderEntry[] = []
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      errors.push(`order[${index}] must be an object`)
      continue
    }
    const path = textOf(entry.path)
    if (path === "") {
      errors.push(`order[${index}].path is required`)
      continue
    }
    order.push({ path, reason: clip(textOf(entry.reason), MAX_NOTE_CHARS) })
  }
  return order
}

export function validatePlan(raw: unknown): Validated<PlanResponse> {
  if (!isRecord(raw)) return { ok: false, errors: ["response must be a JSON object"] }
  const errors: string[] = []
  checkProtocol(raw, errors)
  const overview = clip(textOf(raw.overview), MAX_NOTE_CHARS)
  if (overview === "") errors.push("overview is required")
  const order = readPlanOrder(raw.order, errors)
  // Reported alongside other errors: the repair retry gets every problem at once.
  if (order.length === 0) errors.push("order is empty")
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { overview, order } }
}

function readWalkthrough(raw: unknown, errors: string[]): WalkthroughItem[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    errors.push("walkthrough must be an array")
    return []
  }
  const items: WalkthroughItem[] = []
  const slice = raw.slice(0, MAX_WALKTHROUGH_ITEMS)
  for (const [index, entry] of slice.entries()) {
    if (!isRecord(entry)) {
      errors.push(`walkthrough[${index}] must be an object`)
      continue
    }
    const anchor = readAnchor(entry.anchor, `walkthrough[${index}].anchor`, errors)
    const explanation = clip(textOf(entry.explanation), MAX_NOTE_CHARS)
    if (explanation === "") errors.push(`walkthrough[${index}].explanation is required`)
    if (anchor !== null && explanation !== "") items.push({ anchor, explanation })
  }
  return items
}

function readConcerns(raw: unknown, errors: string[]): Concern[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    errors.push("concerns must be an array")
    return []
  }
  if (raw.length > MAX_FILE_CONCERNS) {
    errors.push(`concerns has ${raw.length} entries (max ${MAX_FILE_CONCERNS})`)
    return []
  }
  const concerns: Concern[] = []
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      errors.push(`concerns[${index}] must be an object`)
      continue
    }
    const anchor = readAnchor(entry.anchor, `concerns[${index}].anchor`, errors)
    const level = entry.level
    if (level !== "high" && level !== "medium" && level !== "low") {
      errors.push(`concerns[${index}].level must be high, medium or low`)
      continue
    }
    const note = clip(textOf(entry.note), MAX_NOTE_CHARS)
    if (note === "") errors.push(`concerns[${index}].note is required`)
    if (anchor !== null && note !== "") concerns.push({ anchor, level, note })
  }
  return concerns
}

function readStrings(raw: unknown, max: number, where: string, errors: string[]): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    errors.push(`${where} must be an array`)
    return []
  }
  return raw
    .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    .slice(0, max)
    .map((entry) => clip(entry.trim(), MAX_NOTE_CHARS))
}

export function validateFile(raw: unknown): Validated<FileAnalysis> {
  if (!isRecord(raw)) return { ok: false, errors: ["response must be a JSON object"] }
  const errors: string[] = []
  checkProtocol(raw, errors)
  const path = textOf(raw.path)
  if (path === "") errors.push("path is required")
  const intent = clip(textOf(raw.intent), MAX_NOTE_CHARS)
  if (intent === "") errors.push("intent is required")
  const summary = clip(textOf(raw.summary), MAX_NOTE_CHARS * 2)
  const walkthrough = readWalkthrough(raw.walkthrough, errors)
  const concerns = readConcerns(raw.concerns, errors)
  const assumptions = readStrings(raw.assumptions, MAX_FILE_ASSUMPTIONS, "assumptions", errors)
  const questions = readStrings(raw.questions, MAX_FILE_QUESTIONS, "questions", errors)
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { path, intent, summary, walkthrough, concerns, assumptions, questions } }
}

export function validateAsk(raw: unknown): Validated<AskResponse> {
  if (!isRecord(raw)) return { ok: false, errors: ["response must be a JSON object"] }
  const errors: string[] = []
  checkProtocol(raw, errors)
  const text = textOf(raw.text)
  if (text === "") errors.push("text is required")
  const anchors: Anchor[] = []
  if (raw.anchors !== undefined) {
    if (!Array.isArray(raw.anchors)) {
      errors.push("anchors must be an array")
    } else {
      for (const [index, entry] of raw.anchors.slice(0, MAX_FILE_CONCERNS).entries()) {
        const anchor = readAnchor(entry, `anchors[${index}]`, errors)
        if (anchor !== null) anchors.push(anchor)
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { text, anchors } }
}

/** Pull the JSON object out of a model answer: fenced block, prose, or both. */
export function parseModelJson(answer: string): Validated<unknown> {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(answer)
  const candidate = (fenced?.[1] ?? answer).trim()
  const first = candidate.indexOf("{")
  const last = candidate.lastIndexOf("}")
  const body = first === -1 || last <= first ? candidate : candidate.slice(first, last + 1)
  if (body === "") return { ok: false, errors: ["answer contained no JSON object"] }
  try {
    return { ok: true, value: JSON.parse(body) as unknown }
  } catch (error) {
    return { ok: false, errors: [`invalid JSON: ${error instanceof Error ? error.message : String(error)}`] }
  }
}

const ANCHOR_SCHEMA = {
  type: "object",
  properties: {
    side: { enum: ["new", "old"] },
    start: { type: "integer", minimum: 1 },
    end: { type: "integer", minimum: 1 },
    quote: { type: "string" },
  },
  required: ["side", "start", "end", "quote"],
}

const PROTOCOL_PROPERTY = { protocol: { type: "string", enum: [PROTOCOL] } }

function planSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      ...PROTOCOL_PROPERTY,
      overview: { type: "string" },
      order: {
        type: "array",
        items: {
          type: "object",
          properties: { path: { type: "string" }, reason: { type: "string" } },
          required: ["path", "reason"],
        },
      },
    },
    required: ["protocol", "overview", "order"],
  }
}

function askSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      ...PROTOCOL_PROPERTY,
      text: { type: "string" },
      anchors: { type: "array", items: ANCHOR_SCHEMA },
    },
    required: ["protocol", "text"],
  }
}

function fileSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      ...PROTOCOL_PROPERTY,
      path: { type: "string" },
      intent: { type: "string" },
      summary: { type: "string" },
      walkthrough: {
        type: "array",
        items: {
          type: "object",
          properties: { anchor: ANCHOR_SCHEMA, explanation: { type: "string" } },
          required: ["anchor", "explanation"],
        },
      },
      concerns: {
        type: "array",
        items: {
          type: "object",
          properties: {
            anchor: ANCHOR_SCHEMA,
            level: { enum: ["high", "medium", "low"] },
            note: { type: "string" },
          },
          required: ["anchor", "level", "note"],
        },
      },
      assumptions: { type: "array", items: { type: "string" } },
      questions: { type: "array", items: { type: "string" } },
    },
    required: ["protocol", "path", "intent", "summary", "concerns"],
  }
}

/** The JSON schema for a request type, for harnesses with schema output. */
export function jsonSchemaFor(type: RequestType): Record<string, unknown> {
  if (type === "plan") return planSchema()
  if (type === "ask") return askSchema()
  return fileSchema()
}

/** Validate one harness answer for a request type. */
export function validateFor(type: RequestType, raw: unknown): Validated<unknown> {
  if (type === "plan") return validatePlan(raw)
  if (type === "file") return validateFile(raw)
  return validateAsk(raw)
}
