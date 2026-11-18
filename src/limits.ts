// Bounds that keep chert's data and output small enough for a terminal.
// Each is a product decision in one place instead of a literal at the call site.

/** Highlights kept in <gitdir>/chert/highlights.json before the oldest AI ones are dropped. */
export const MAX_SAVED_HIGHLIGHTS = 500
/** Recent projects remembered in ~/.chert/projects.json. */
export const MAX_RECENT_PROJECTS = 20
/** Repositories listed when a /cd target is only a container of repos. */
export const MAX_CONTAINED_REPOS = 50
/** Commits offered by the /review picker. */
export const MAX_RECENT_COMMITS = 40
/** Trailing lines kept from an opencode answer. */
export const MAX_AGENT_ANSWER_LINES = 40
/** Trailing lines kept from /run or /models output. */
export const MAX_COMMAND_OUTPUT_LINES = 30
/** Trailing lines kept from a provider error body. */
export const MAX_PROVIDER_ERROR_LINES = 3

/** Concerns accepted for one file in a walk response; the rest are reported as dropped. */
export const MAX_FILE_CONCERNS = 8
/** Walkthrough notes accepted for one file. */
export const MAX_WALKTHROUGH_ITEMS = 30
/** Longest span (in lines) one anchor may cover. */
export const MAX_ANCHOR_RANGE = 30
/** Longest concern note or walkthrough explanation kept from the agent. */
export const MAX_NOTE_CHARS = 200
/** Assumptions and questions kept per file, so a chatty agent cannot flood the screen. */
export const MAX_FILE_ASSUMPTIONS = 6
export const MAX_FILE_QUESTIONS = 5
/** Diff rows sent to the agent in one request, in characters. */
export const MAX_WALK_REQUEST_CHARS = 48_000
/** Cached file analyses kept per review session. */
export const MAX_CACHED_ANALYSES = 40
/** Sessions offered by the /walk picker. */
export const MAX_HARNESS_SESSIONS = 20
