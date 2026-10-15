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

Run in the live checkout, in a shell that stops on the first error (`set -e`):

```sh
set -e
# 1. Preconditions: clean tree, on the operational branch
git status --porcelain              # must print nothing
git branch --show-current           # must be the operational branch

# 2. Record a rollback point (lightweight local tag: needs no git identity; never pushed)
PREV=$(git rev-parse HEAD)
TAG="deployed/$(date -u +%Y%m%dT%H%M%SZ)-prev"
git tag "$TAG" "$PREV"
test "$(git rev-parse "$TAG^{commit}")" = "$PREV"   # do not continue without a rollback point

# 3. Fast-forward only. A non-fast-forward means the branch was rewritten: stop.
git fetch <remote>
git merge --ff-only <remote>/<operational-branch>

# 4. Reinstall dependencies only when the lockfile changed
git diff --quiet "$PREV" HEAD -- package-lock.json || npm ci

# 5. Verify
npm run test:unit                   # unit + cross-process tests (the "pine check" CLI tests
                                    # call TradingView's compile service and need network)
node src/cli/index.js tab list      # read-only smoke against the running app
```

Then start a new client session (or reconnect the MCP server) and call
`tv_health_check` before the next automated run.

## Roll back

Run in the live checkout:

```sh
git tag -l 'deployed/*' --sort=-refname | head      # newest rollback point first (UTC in name)
git status --porcelain                               # must print nothing
git switch --detach <rollback-tag>                   # non-destructive; branch untouched
node src/cli/index.js tab list                       # read-only smoke
```

Restart or reconnect client sessions so they spawn the rolled-back server. To return
to the operational branch later (e.g. once a fix is merged), run
`git switch <operational-branch>` and follow **Deploy** again.

Rollback never rewrites history, deletes tags, or uses `reset --hard`.

## Tab selection and verification

### Pins are per process

`tab_select` / `tab_switch` pin the CDP connection **inside the current Node
process only**. Every CLI invocation (`tv ...`) and every MCP server start is a new
process that begins unpinned and unverified. So `tv tab select` followed by a
separate `tv pane list` does **not** read the selected tab: the second process
attaches to the first chart tab again. For a scripted check use one process:

```sh
tv tab preflight --chart-id <id> --resolutions 240,60 [--layout-id <n>] [--title <text>]
```

It selects and verifies the tab, reads its panes and re-checks the live identity
through one pinned connection. Every non-READY result, including `PANES_MISMATCH`,
blocks chart access in that process until a later selection verifies. Exit code 0 only for `status: "READY"`; otherwise 3
(`MISSING`, `AMBIGUOUS`, `MISMATCH`, `PANES_MISMATCH`, `ERROR`). The MCP tool
`tab_preflight` does the same inside a server process.

### Fail closed

- `tab_select` returns `VERIFIED` only if exactly one open tab has URL
  `/chart/<chart_id>/` and, read through the new connection, the page's **live** URL
  carries that id, its live title contains `title_contains` (if given) and the saved
  layout `layout_id` (if given) maps to that short id. Tab activation alone is never
  treated as proof.
- Any other result, an error, a closed pinned tab, or a later change of the pinned
  page's live URL (checked on every liveness check and reconnect) **blocks all chart
  access** in that process until a new `tab_select` verifies. Reconnects never fall
  back to another tab.
- `TV_REQUIRE_VERIFIED_TAB=1` (for automation): the process refuses every chart
  read/write until `tab_select` (or `tab_preflight`) has verified in that process.
  Without it, a process that never selects a tab behaves as before (first chart tab).

### Saved layout ids vs chart short ids (verified against TradingView Desktop)

`TradingViewApi.getSavedCharts()` lists each saved layout with a numeric `id` and a
`url` field that **is** the chart short id seen in the tab URL `/chart/<short_id>/`.

- Stable: both are assigned when the layout is created and stay the same while the
  layout is edited and re-saved (layouts created years earlier keep their short id).
- Not stable / not identity: the page title (current symbol, price and change, then
  the layout name; the name is user-editable), the registry's saved `symbol` and
  `resolution` (the last saved state, not the live chart), and a tab's URL when a
  different layout is loaded into that tab in place. "Save as"/copy creates a new
  layout with a new id and short id; deleting a layout removes both.
- Safe failure: a renamed layout fails only an optional `title_contains` check; a
  replaced, copied or deleted layout yields `MISSING` or `MISMATCH`; an unavailable
  registry fails an optional `layout_id` check. All of these block chart access.

`layout_switch` is unchanged: it loads a layout into the current tab and can dismiss
an unsaved-changes dialog, so automations should prefer persistent tabs plus
`tab_select`.

### Test hooks

`TV_CDP_HOST` / `TV_CDP_PORT` override the DevTools endpoint (default
`localhost:9222`); the cross-process tests point them at a local fake.
