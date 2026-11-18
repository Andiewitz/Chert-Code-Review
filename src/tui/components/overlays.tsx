// The overlay screens: the menu, the all-files list, the review-source picker,
// the highlight menu and the recent-projects home screen. Purely presentational:
// every piece of state is read through a prop getter.

import { Show } from "solid-js"
import type { ScrollBoxRenderable, SelectOption } from "@opentui/core"
import type { Highlight } from "../../highlights"
import type { Suggestion } from "../commands/registry"
import { ATTR, COLORS } from "../theme"
import { HomeScreen } from "./home-screen"
import { RowList } from "./row-list"
import { Wordmark } from "./wordmark"

export interface OverlaysProps {
  menuOpen(): boolean
  menuIndex(): number
  menuOptions(): SelectOption[]
  allFilesOpen(): boolean
  allFilesIndex(): number
  allFilesOptions(): SelectOption[]
  fileCount(): number
  onAllFilesScroll(el: ScrollBoxRenderable): void
  reviewPickerOpen(): boolean
  reviewPickerIndex(): number
  allReviewTargets(): Suggestion[]
  onReviewPickerScroll(el: ScrollBoxRenderable): void
  highlightMenuOpen(): boolean
  highlightMenuIndex(): number
  highlightForRowIndex(index: number): Highlight | undefined
  codeCursorRow(): number
  projectsOpen(): boolean
  projectsIndex(): number
  loadRecent(): Array<{ path: string }>
}

export function Overlays(props: OverlaysProps) {
  return (
    <>
      <Show when={props.menuOpen()}>
        <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingRight={2}>
          <box height={1} flexShrink={0} />
          <Wordmark />
          <box height={1} flexShrink={0} />
          <text fg={COLORS().dim} attributes={ATTR.dim}>
            {"menu"}
          </text>
          <box height={1} flexShrink={0} />
          <RowList
            rows={() => props.menuOptions().map((o) => ({ label: o.name, hint: o.description }))}
            index={() => props.menuIndex()}
          />
          <box flexGrow={1} />
        </box>
      </Show>
      <Show when={props.allFilesOpen()}>
        <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingRight={2}>
          <box height={1} flexShrink={0} />
          <text fg={COLORS().purple} attributes={ATTR.bold}>{`All files (${props.fileCount()})`}</text>
          <box height={1} flexShrink={0} />
          <scrollbox
            ref={(el: ScrollBoxRenderable) => {
              props.onAllFilesScroll(el)
            }}
            flexGrow={1}
            backgroundColor={COLORS().bg}
          >
            <RowList
              rows={() => props.allFilesOptions().map((o) => ({ label: o.name, hint: o.description }))}
              index={() => props.allFilesIndex()}
            />
          </scrollbox>
          <box flexGrow={1} />
        </box>
      </Show>
      <Show when={props.reviewPickerOpen()}>
        <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingRight={2}>
          <box height={1} flexShrink={0} />
          <text fg={COLORS().purple} attributes={ATTR.bold}>
            {"Review source"}
          </text>
          <box height={1} flexShrink={0} />
          <scrollbox
            ref={(el: ScrollBoxRenderable) => {
              props.onReviewPickerScroll(el)
            }}
            flexGrow={1}
            backgroundColor={COLORS().bg}
          >
            <RowList
              rows={() => props.allReviewTargets().map((s) => ({ label: s.label, hint: s.description }))}
              index={() => props.reviewPickerIndex()}
            />
          </scrollbox>
          <box flexGrow={1} />
        </box>
      </Show>
      <Show when={props.highlightMenuOpen()}>
        <box flexGrow={1} flexDirection="column" paddingLeft={1}>
          <text fg={COLORS().bright}>Highlight</text>
          <box height={1} />
          <text
            fg={props.highlightMenuIndex() === 0 ? COLORS().bright : COLORS().dim}
          >{`${props.highlightMenuIndex() === 0 ? "▸ " : "  "}Ask the AI about these lines`}</text>
          <text
            fg={props.highlightMenuIndex() === 1 ? COLORS().bright : COLORS().dim}
          >{`${props.highlightMenuIndex() === 1 ? "▸ " : "  "}Edit note`}</text>
          <text
            fg={props.highlightMenuIndex() === 2 ? COLORS().bright : COLORS().dim}
          >{`${props.highlightMenuIndex() === 2 ? "▸ " : "  "}${props.highlightForRowIndex(props.codeCursorRow())?.by === "ai" ? "Dismiss" : "Remove"}`}</text>
          <text
            fg={props.highlightMenuIndex() === 3 ? COLORS().bright : COLORS().dim}
          >{`${props.highlightMenuIndex() === 3 ? "▸ " : "  "}Close`}</text>
        </box>
      </Show>
      <Show when={props.projectsOpen()}>
        <HomeScreen recents={() => props.loadRecent()} index={() => props.projectsIndex()} />
      </Show>
    </>
  )
}
