// The floating pickers: menu, review source and recent projects. Each opens
// over the review as a drop-up panel, so the screen you were reading stays
// where it was. Purely presentational: every piece of state is a prop.

import { Show } from "solid-js"
import { basename } from "node:path"
import type { SelectOption } from "@opentui/core"
import type { Suggestion } from "../commands/registry"
import { displayPath } from "../../projects"
import { shortenPath } from "../format"
import { DropUp } from "./drop-up"

export interface OverlaysProps {
  menuOpen(): boolean
  menuIndex(): number
  menuOptions(): SelectOption[]
  reviewPickerOpen(): boolean
  reviewPickerIndex(): number
  allReviewTargets(): Suggestion[]
  projectsOpen(): boolean
  projectsIndex(): number
  hasProject(): boolean
  loadRecent(): Array<{ path: string }>
  /** Rows a panel may show before it windows over the selection. */
  maxRows: number
}

export function Overlays(props: OverlaysProps) {
  const options = (list: () => SelectOption[]) => () =>
    list().map((option) => ({ label: option.name, hint: option.description }))

  return (
    <>
      <Show when={props.menuOpen()}>
        <DropUp
          title="Menu"
          rows={options(props.menuOptions)}
          index={props.menuIndex}
          empty=""
          maxRows={props.maxRows}
        />
      </Show>
      <Show when={props.reviewPickerOpen()}>
        <DropUp
          title="Review source"
          rows={() =>
            props.allReviewTargets().map((target) => ({
              label: target.label,
              hint: target.description,
            }))
          }
          index={props.reviewPickerIndex}
          empty="Nothing to review yet."
          maxRows={props.maxRows}
        />
      </Show>
      <Show when={props.projectsOpen() && props.hasProject()}>
        <DropUp
          title="Recent projects"
          rows={() =>
            props.loadRecent().map((recent) => ({
              label: basename(recent.path),
              hint: shortenPath(displayPath(recent.path), 46),
            }))
          }
          index={props.projectsIndex}
          empty="No saved projects yet \u2014 /cd <path> to open one."
          maxRows={props.maxRows}
        />
      </Show>
    </>
  )
}
