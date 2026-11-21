// A floating list anchored above the prompt. Menus, pickers and the command
// suggestions open over the review instead of replacing it. Flat by design:
// one rule on top and the panel background behind the rows, no frame.

import { Show, type JSX } from "solid-js"
import { ATTR, COLORS } from "../theme"
import { RowList } from "./row-list"
import type { PickerRow } from "./row-list"

export interface DropUpProps {
  title: string
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

/** The shared shell: full width, opaque, flush against the prompt's rule. */
export function DropUpPanel(props: { height: number; children: JSX.Element }) {
  return (
    <box
      position="absolute"
      left={0}
      right={0}
      bottom={4}
      height={props.height}
      zIndex={50}
      flexDirection="column"
      backgroundColor={COLORS().panel}
      border={["top"]}
      borderColor={COLORS().rule}
      paddingLeft={1}
      paddingRight={1}
    >
      {props.children}
    </box>
  )
}

export function DropUp(props: DropUpProps) {
  const count = () => props.rows().length
  const visible = () => Math.min(count(), Math.max(1, props.maxRows))
  // The top rule, the title, then one row per visible item.
  const height = () => 2 + Math.max(1, visible())
  const window = () => listWindow(props.rows(), props.index(), props.maxRows)

  return (
    <DropUpPanel height={height()}>
      <text fg={COLORS().purpleBright} attributes={ATTR.bold}>
        {props.title}
      </text>
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
    </DropUpPanel>
  )
}
