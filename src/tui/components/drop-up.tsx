// A floating panel anchored above the prompt: menus and pickers open over the
// review instead of replacing it. One component for every list keeps the
// interaction identical wherever it appears.

import { Show } from "solid-js"
import { ATTR, COLORS } from "../theme"
import { RowList } from "./row-list"
import type { PickerRow } from "./row-list"

export interface DropUpProps {
  title: string
  /** Key hint on the right of the title row. */
  hint: string
  rows: () => PickerRow[]
  index: () => number
  /** Shown in place of the list when `rows` is empty. */
  empty: string
  /** Rows visible before the list windows over the selection. */
  maxRows: number
}

/**
 * Slice a list down to the rows a short panel can show, keeping the selected
 * row inside the window and at the bottom when moving down.
 */
export function listWindow(
  rows: PickerRow[],
  index: number,
  maxRows: number,
): { rows: PickerRow[]; index: number } {
  const visible = Math.min(rows.length, Math.max(1, maxRows))
  if (rows.length <= visible) return { rows, index }
  const current = Math.max(0, Math.min(index, rows.length - 1))
  const start = Math.min(Math.max(0, current - visible + 1), rows.length - visible)
  return { rows: rows.slice(start, start + visible), index: current - start }
}

export function DropUp(props: DropUpProps) {
  const count = () => props.rows().length
  const visible = () => Math.min(count(), Math.max(1, props.maxRows))
  // Borders are part of the height: one title row, one row per visible item,
  // one top and one bottom border.
  const height = () => Math.max(4, visible() + 3)
  const window = () => listWindow(props.rows(), props.index(), props.maxRows)

  return (
    <box
      position="absolute"
      left={0}
      right={0}
      bottom={5}
      height={height()}
      zIndex={50}
      flexDirection="column"
      backgroundColor={COLORS().panel}
      border
      borderColor={COLORS().purpleDim}
      paddingLeft={1}
      paddingRight={1}
    >
      <box height={1} flexShrink={0} flexDirection="row">
        <text fg={COLORS().purpleBright} attributes={ATTR.bold}>
          {props.title}
        </text>
        <box flexGrow={1} />
        <text fg={COLORS().dim} attributes={ATTR.dim}>
          {props.hint}
        </text>
      </box>
      <Show
        when={count() > 0}
        fallback={
          <text fg={COLORS().dim} attributes={ATTR.dim}>
            {props.empty}
          </text>
        }
      >
        <RowList rows={() => window().rows} index={() => window().index} baseBg={COLORS().panel} />
      </Show>
    </box>
  )
}
