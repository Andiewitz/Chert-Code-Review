// Launch/home screen: recent projects below the wordmark and prompt.

import { Show } from "solid-js"
import { basename } from "node:path"
import { displayPath } from "../../projects"
import { shortenPath } from "../format"
import { ATTR, COLORS } from "../theme"
import { RowList } from "./row-list"

export function HomeScreen(props: { recents: () => Array<{ path: string }>; index: () => number }) {
  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1}>
      <text fg={COLORS().purple} attributes={ATTR.bold}>
        {"Recent projects"}
      </text>
      <box height={1} flexShrink={0} />
      <Show
        when={props.recents().length > 0}
        fallback={
          <text fg={COLORS().dim} attributes={ATTR.dim}>
            {"Nothing here yet — type /cd <path> to open a project."}
          </text>
        }
      >
        <RowList
          rows={() =>
            props.recents().map((recent) => ({
              label: basename(recent.path),
              hint: shortenPath(displayPath(recent.path), 38),
            }))
          }
          index={props.index}
        />
      </Show>
      <box flexGrow={1} />
    </box>
  )
}
