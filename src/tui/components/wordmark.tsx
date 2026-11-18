// The chert wordmark, drawn in the theme's purple ramp.

import { For } from "solid-js"
import { ATTR, COLORS, WORDMARK, WORDMARK_FG } from "../theme"

export function Wordmark() {
  return (
    <For each={WORDMARK}>
      {(line, i) => (
        <text fg={WORDMARK_FG[i()] ?? COLORS().purple} attributes={ATTR.bold}>
          {line}
        </text>
      )}
    </For>
  )
}
