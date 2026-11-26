// Command and theme suggestions. They use the same drop-up shell as the menu,
// so the list appears above the prompt instead of pushing the layout around.

import { For, Show } from "solid-js"
import type { Suggestion } from "../commands/registry"
import { COLORS, THEMES } from "../theme"
import type { ThemeName } from "../theme"
import { DropUpPanel } from "./drop-up"

export interface SuggestionBoxProps {
  items: Suggestion[]
  /** First item of the visible window. */
  offset: number
  /** Highlighted item in the full list. */
  index: number
  /** Ctrl+P: label the box, since the prompt is empty. */
  pickerOpen: boolean
  /** Colour each row with its own theme palette. */
  themePreview: boolean
}

export function SuggestionBox(props: SuggestionBoxProps) {
  // Top rule, the optional label, then one row per suggestion.
  const height = () => 1 + (props.pickerOpen ? 1 : 0) + props.items.length
  const activeIndex = () => Math.min(props.index, Math.max(0, props.items.length - 1))

  return (
    <DropUpPanel height={height()}>
      <Show when={props.pickerOpen}>
        <text fg={COLORS().dim}>commands (Ctrl+P)</text>
      </Show>
      <For each={props.items}>
        {(cmd, i) => {
          const active = () => props.offset + i() === activeIndex()
          const pal = () => (props.themePreview ? (THEMES[cmd.key as ThemeName] ?? null) : null)
          const bg = () =>
            pal()
              ? active()
                ? pal()!.selectedBg
                : pal()!.bg
              : active()
                ? COLORS().selectedBg
                : COLORS().panel
          const labelFg = () =>
            pal()
              ? active()
                ? pal()!.bright
                : pal()!.accent
              : active()
                ? COLORS().bright
                : COLORS().accent
          const descFg = () =>
            pal() ? (active() ? pal()!.text : pal()!.dim) : active() ? COLORS().text : COLORS().dim
          return (
            <box height={1} flexDirection="row" backgroundColor={bg()}>
              <text fg={labelFg()}>{`${active() ? "▸ " : "  "}${cmd.label}`.padEnd(36)}</text>
              <text fg={descFg()}>{cmd.description}</text>
            </box>
          )
        }}
      </For>
    </DropUpPanel>
  )
}
