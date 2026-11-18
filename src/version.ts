// Single source of truth for the version: read from package.json so the CLI,
// the built binary and the published package can never disagree.

import packageJson from "../package.json" with { type: "json" }

export const VERSION: string = packageJson.version
