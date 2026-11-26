# Guided review (`/walk`)

`/walk` turns chert into a review driver for the coding harness you already use.
It forks your harness session, so the reviewer keeps the model and the context
of the agent that wrote the code, and then walks you through the changed files
one at a time. The agent explains and flags; you decide.

## Principles

1. **The human decides.** No agent output can approve, reject or mark a file.
   Approval exists only as a keypress (Space) and is stored with the patch hash
   it was given for.
2. **chert drives, the agent narrates.** chert owns order, state and UI. The
   agent answers structured requests and nothing else.
3. **The reviewer is read-only toward the repo.** The harness is started with a
   read-only agent and no auto-approve flag, and a tree guard hashes the working
   tree before and after every call.
4. **Never show a note on the wrong line.** Anchors are verified against the
   parsed diff; a line number that is wrong but whose quote matches exactly once
   is relocated, anything else is dropped and reported.
5. **Fast.** The diff renders before the agent is asked. The next unapproved file
   is prepared while you read the current one.
6. **One system each.** One approval store, one highlight store, one
   agent-output path (the protocol). The old free-text highlight block is gone.

## Not building

Auto-fix or write access for the reviewer, GitHub/PR integration, multi-reviewer,
a persistent chat-history browser, new LLM providers, per-file prompt
configuration, settings screens, telemetry. The direct-API connectors keep
serving plain-text prompts; `/walk` requires a harness.

## Harnesses

| harness       | detection                                      | session discovery                     | isolation                     |
| ------------- | ---------------------------------------------- | ------------------------------------- | ----------------------------- |
| `opencode`    | `opencode --version` (+ server probe when set) | `opencode session list --format json` | `--agent plan` (edits denied) |
| `claude-code` | `claude --version`                             | typed id (`/walk <id>`)               | `--tools "Read,Grep,Glob"`    |

By default every opencode call is `opencode run …` with no server flag, so the
CLI uses its own background service: one process owns sessions, configuration and
tool state, and there is nothing for the user to start. To use a server you
manage yourself, set `CHERT_OPENCODE_SERVER` (a URL or `host:port`); every call
then becomes `opencode run --server <url> …`. A standalone server needs
`OPENCODE_PASSWORD` in the environment of both the server and chert:

```
OPENCODE_PASSWORD=chert-dev opencode serve --port 4096
export OPENCODE_PASSWORD=chert-dev
export CHERT_OPENCODE_SERVER=http://127.0.0.1:4096
```

chert probes that address before forking. If nothing answers, `/walk` stops
before forking and says so. If `CHERT_OPENCODE_SERVER` is unset, there is no
probe: the background service starts on demand.

Verified against opencode 2.3.2 and the Claude Code CLI reference. Each adapter
spawns its CLI in exactly one place (`src/harness/opencode.ts`,
`src/harness/claude.ts`). No adapter ever passes an auto-approve or
skip-permissions flag; `bun run check` fails if one appears.

## Starting a walk

`/walk` forks the newest session opencode lists for this project. `/walk <id>`
forks a session you name; `/walk fresh` starts without author context. Claude
Code has no session-list command, so there it is `/walk <id>` or `/walk fresh`.
`/walk opencode [model]` names the harness and can override opencode's saved pin
for that walk only; the pin itself is unchanged. Typing `/walk ` shows the
opencode model and `fresh` as suggestions. Nothing is forked until you run the
command: no review work happens in the background.

A run that exits nonzero but printed a usable answer is still an answer: the CLI
reports some warnings that way, and chert keeps the text instead of failing the
file.

The session is forked **once** at review start (`--fork` / `--fork-session`), the
forked id is stored, and every later call resumes that fork. The original session
is never written to. The forked id is shown on the done screen so the discussion
can be resumed by hand.

The plan becomes the review order: the file list, the arrow keys and Back/Next
all follow it, and the band says why the file is next. Reaching a file asks the
agent for that file automatically — the overview notice names the whole change,
and each file keeps its own explanation. Moving away from a file keeps its
answer; coming back restores it instead of spending tokens again. The next
unapproved file is warmed while you read.

## Protocol (`chert-review/1`)

JSON only, validated by hand in `src/review/protocol.ts`; the exported schema is
handed to harnesses that support structured output.

- **plan** — request: source and file metadata. Response: `overview` plus an
  `order` of files with a one-line reason each. chert keeps the final order and
  appends any file the agent forgot.
- **file** — request: file metadata and numbered diff rows. Response: `intent`,
  `summary`, `walkthrough` (anchor + explanation), `concerns` (anchor + level +
  note), `assumptions`, `questions`.
- **ask** — request: a question, the file and an optional selection. Response:
  prose plus optional anchors.

An anchor is `{ side, start, end, quote }`, where `quote` is the exact text of the
first line of the range. Limits: 8 concerns per file, 30 lines per anchor, 200
characters per note.

Invalid output gets exactly one automatic repair attempt that feeds back the
validation errors. A second failure shows the raw text with a clear notice — it
never crashes and never disappears silently.

Diff and file content are untrusted data: they are delimited and the preamble
tells the agent to ignore instructions inside them.

## State

`<gitdir>/chert/review-state.json` holds approvals (`path`, `approvedPatchHash`,
`approvedAt`), the plan and position per review source, and a response cache keyed
by `(forkedSessionId, path, patchHash)`. A file counts as approved only while the
hash matches its current patch; otherwise it shows as changed and needs a fresh
Space. Reopening a review reuses the stored approvals and plan; a new `/walk`
fork is a new conversation, so nothing is inherited from the old one.

Highlights, notes and review exports keep their existing files.

## Hand-back

After the review, if you flagged anything, chert writes
`<gitdir>/chert/handback.md` with your notes and the file/line references, and
the done screen shows the approval count and the id of the forked session.
`Back to the files` (or `Esc`) returns to the review without ending the walk.
Handing the notes back is yours to do: chert never writes into the original
session, and it never resumes one on its own.
