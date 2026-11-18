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
