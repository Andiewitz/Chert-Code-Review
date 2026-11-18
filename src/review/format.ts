// How a validated analysis is shown to the human. The agent's JSON never
// reaches the screen raw: anchors became highlights, and this is the prose that
// stays in the answer pane.

import type { WalkFileResult } from "./walk"

function lineRef(start: number, end: number, side: string): string {
  const where = start === end ? `L${start}` : `L${start}-${end}`
  return side === "old" ? `${where} old` : where
}

/** The pane text: intent, summary, walkthrough, concerns, questions, drop note. */
export function analysisText(result: WalkFileResult): string {
  const { analysis, dropped } = result
  const lines = [analysis.intent, analysis.summary].filter((line) => line !== "")
  if (analysis.walkthrough.length > 0) {
    lines.push("", "Walkthrough:")
    for (const item of analysis.walkthrough) {
      lines.push(`- ${lineRef(item.anchor.start, item.anchor.end, item.anchor.side)}: ${item.explanation}`)
    }
  }
  if (analysis.concerns.length > 0) {
    lines.push("", "Concerns:")
    for (const concern of analysis.concerns) {
      const where = lineRef(concern.anchor.start, concern.anchor.end, concern.anchor.side)
      lines.push(`- ${concern.level} ${where}: ${concern.note}`)
    }
  }
  if (analysis.assumptions.length > 0) {
    lines.push("", "Assumptions:")
    for (const assumption of analysis.assumptions) lines.push(`- ${assumption}`)
  }
  if (analysis.questions.length > 0) {
    lines.push("", "Questions for you:")
    for (const question of analysis.questions) lines.push(`- ${question}`)
  }
  if (dropped > 0) {
    lines.push("", `(${dropped} note${dropped === 1 ? "" : "s"} dropped: the line did not match the diff)`)
  }
  return lines.join("\n")
}
