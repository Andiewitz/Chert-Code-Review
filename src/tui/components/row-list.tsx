// A keyboard-driven list: arrows move the cursor, Enter acts on it.

import { For, Show } from "solid-js"
import { ATTR, COLORS } from "../theme"

export interface PickerRow {
  label: string
  hint?: string
}

export function RowList(props: { rows: () => PickerRow[]; index: () => number; baseBg?: string }) {
  return (
    <For each={props.rows()}>
      {(row, i) => {
        const active = () => i() === props.index()
        return (
          <box
            flexDirection="row"
            height={1}
            flexShrink={0}
            backgroundColor={active() ? COLORS().selectedBg : (props.baseBg ?? COLORS().bg)}
          >
            <text fg={active() ? COLORS().purpleBright : COLORS().rule}>{active() ? "  ▸ " : "    "}</text>
            <text
              fg={active() ? COLORS().bright : COLORS().text}
              attributes={active() ? ATTR.bold : ATTR.none}
            >
              {row.label}
            </text>
            <box flexGrow={1} />
            <Show when={row.hint !== undefined}>
              <text fg={active() ? COLORS().dim : COLORS().rule} attributes={ATTR.dim}>
                {row.hint ?? ""}
              </text>
            </Show>
          </box>
        )
      }}
    </For>
  )
}
