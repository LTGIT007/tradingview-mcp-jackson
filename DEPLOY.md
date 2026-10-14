# Deploying this MCP server (and rolling back)

The server runs straight from a git checkout: the MCP client config points at
`node <checkout>/src/server.js`, and every new client session spawns a fresh server
process from whatever that checkout contains. That checkout (the **live checkout**)
is therefore production. Change it only with the procedure below.

Rules:

- Never develop, test or switch branches in the live checkout. Use a separate
  worktree: `git worktree add ../tv-mcp-dev -b my-fix <remote>/<operational-branch>`.
- The live checkout tracks one **operational branch**. A change reaches it only as a
  reviewed PR merged into that branch, with tests green.
- Deploy between automation windows, when no scheduled or interactive session is
  using the server. Sessions that are already running keep the old code until they
  restart.

## Deploy

Run in the live checkout:

```sh
# 1. Preconditions: clean tree, on the operational branch
git status --porcelain              # must print nothing
git branch --show-current           # must be the operational branch

# 2. Record a rollback point (local tag, never pushed)
PREV=$(git rev-parse HEAD)
TAG="deployed/$(date -u +%Y%m%dT%H%M%SZ)-prev"
git tag -a "$TAG" -m "rollback point before deploy" "$PREV"

# 3. Fast-forward only. A non-fast-forward means the branch was rewritten: stop.
git fetch <remote>
git merge --ff-only <remote>/<operational-branch>

# 4. Reinstall dependencies only when the lockfile changed
git diff --quiet "$PREV" HEAD -- package-lock.json || npm ci

# 5. Verify
npm run test:unit                   # offline unit tests (the "pine check" CLI tests
                                    # need TradingView's compile service and may fail offline)
node src/cli/index.js tab list      # read-only smoke against the running app
```

Then start a new client session (or reconnect the MCP server) and call
`tv_health_check` before the next automated run.

## Roll back

Run in the live checkout:

```sh
git tag -l 'deployed/*' --sort=-creatordate | head   # newest rollback point first
git status --porcelain                               # must print nothing
git switch --detach <rollback-tag>                   # non-destructive; branch untouched
node src/cli/index.js tab list                       # read-only smoke
```

Restart or reconnect client sessions so they spawn the rolled-back server. To return
to the operational branch later (e.g. once a fix is merged), run
`git switch <operational-branch>` and follow **Deploy** again.

Rollback never rewrites history, deletes tags, or uses `reset --hard`.

## Tab selection after this change

`tab_select { chart_id, title_contains? }` selects the single open tab whose URL is
`/chart/<chart_id>/`. It brings that tab to the front, **pins** the CDP connection to
it (reconnects stay on that tab and fail fast if it closes), and verifies the
**live** page URL (and optional title text). Only `status: "VERIFIED"` means the
chart may be used; `MISSING`, `AMBIGUOUS` and `MISMATCH` mean it may not. The CLI
equivalent `tv tab select --chart-id <id> [--title <text>]` exits 3 unless VERIFIED.

`tab_switch` now also pins and reconnects, but it does not verify which layout the
tab holds. `layout_switch` is unchanged: it loads a layout into the current tab and
can dismiss an unsaved-changes dialog, so automations should prefer persistent tabs
plus `tab_select`.
