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
a chat history browser, new LLM providers, per-file prompt configuration,
settings screens, telemetry. The direct-API connectors keep serving plain-text
prompts; `/walk` requires a harness.

## Harnesses

| harness       | detection          | session discovery            | isolation                                  |
| ------------- | ------------------ | ---------------------------- | ------------------------------------------ |
| `opencode`    | `opencode --version` | `opencode session list --format json` | `--agent plan` (edits denied)     |
| `claude-code` | `claude --version`   | typed id, else newest via `--continue` | `--tools "Read,Grep,Glob"`      |

Verified against opencode 2.3.0 and the Claude Code CLI reference. Each adapter
spawns its CLI in exactly one place (`src/harness/opencode.ts`,
`src/harness/claude.ts`). No adapter ever passes an auto-approve or
skip-permissions flag; `bun run check` fails if one appears.

The session is forked **once** at review start (`--fork` / `--fork-session`), the
forked id is stored, and every later call resumes that fork. The original session
is never written to. The forked id is shown on the done screen so the discussion
can be resumed by hand.

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
Space.

Highlights, notes and review exports keep their existing files.

## Hand-back

After the review, if you flagged anything, chert writes
`<gitdir>/chert/handback.md` with your notes and the file/line references, and
prints the command that resumes the **original** session with it. chert never
writes into that session itself.
