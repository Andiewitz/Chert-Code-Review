# Connecting an opencode session to chert

`/walk` gives the reviewer the context of the agent that wrote the code: chert
forks an opencode session, then drives the review file by file. This page covers
the connection itself: which opencode install chert calls, which session it
forks, and how to point it at a server.

Verified against opencode `2.3.2`.

## What chert needs

1. The `opencode` CLI on `PATH` (`opencode --version` must work).
2. A model configured for opencode. chert passes no model and no API key; it
   uses whatever opencode already uses.
3. A session in the same project directory. opencode records a session's
   `directory` per project, and `opencode session list` only returns sessions for
   the current project, so run chert from the repository root (or a subfolder;
   chert opens the repo root).

## Default: let opencode start its own service

Nothing to start. Every call is a plain `opencode run`:

```
opencode run --format json --agent plan …        # + --session / --fork as needed
```

The CLI talks to its own background service (that is opencode's default; a
private per-call server is the opt-in `--standalone`). One process still owns
sessions and tool state, and there is no password to manage. This is the
recommended setup for a single user on one machine.

Start a review in chert:

```
/walk            # fork the newest session opencode lists for this project
/walk <id>       # fork a specific session
/walk fresh      # no author context; still a guided review
```

## Explicit: attach to a server you run

Use this when you already keep `opencode serve` running, or want the review and
another client to share one process.

```
# terminal 1
OPENCODE_PASSWORD=chert-dev opencode serve --port 4096

# terminal 2 (the one that runs chert)
export OPENCODE_PASSWORD=chert-dev
export CHERT_OPENCODE_SERVER=http://127.0.0.1:4096
bun dev
```

With `CHERT_OPENCODE_SERVER` set, every call becomes:

```
opencode run --format json --agent plan --server http://127.0.0.1:4096 …
```

`CHERT_OPENCODE_SERVER` accepts a full URL or a bare `host:port`; chert adds
`http://` when the scheme is missing. A standalone `opencode serve` prints a
random password on startup, so either start it with a known `OPENCODE_PASSWORD`
(as above) or copy the printed one into chert's environment. Without the
password, opencode answers `Server at … requires a password`.

Before forking, chert probes the configured address. If nothing answers, `/walk`
stops before forking and reports `No opencode server at …`.

## Connect a specific author session

List sessions for the current project:

```
opencode session list --format json --max-count 5
```

Each entry has `id`, `title`, `updated`, `created`, `projectId` and `directory`.
Use the id with `/walk <id>`. With no argument, chert takes the newest entry
(`updated` descending).

The fork is created once, with `--fork`; chert refuses to continue if opencode
returns the original id, because that would write into the author's conversation.
Every later request resumes the fork with `--session <forked-id>`. The original
session is never written to.

## Verify the connection by hand

```
# 1. the CLI works
opencode --version

# 2. a session exists for this directory
opencode session list --format json --max-count 1

# 3. the exact call shape chert uses (fresh session, read-only agent)
opencode run --format json --agent plan "Reply with exactly: CONNECTED"

# 4. fork that session (replace the id)
opencode run --format json --agent plan --session <id> --fork "Reply with exactly: FORKED"
```

The last command must print a `sessionID` different from `<id>`. In chert, a
successful `/walk` prints `Forking opencode session …`, then the agent's reading
order, and the done screen shows the forked session id.

## Gotchas

- **No `--attach`.** opencode 2.x uses `--server <url>` for an explicit server;
  `--attach` is rejected as an unknown flag.
- **Password is per server.** A standalone server is not authenticated by
  `~/.config/opencode/service.json`; that file belongs to the default background
  service. Set `OPENCODE_PASSWORD` for both processes.
- **Forks appear in the list.** A chert review fork is a normal top-level session
  with the title `Review: … (fork #N)`, so `/walk` with no argument may fork the
  previous review fork rather than the author's original. Use `/walk <id>` when
  that matters; the author context is still carried through the fork.
- **Writes are denied, not trusted.** The review runs `--agent plan`, which
  denies edits, and a tree guard hashes the working tree around every call.
  Never add `--auto` or an equivalent.
