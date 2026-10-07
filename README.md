# pi-team-panes

Split-pane workers for [pi-agent-teams](https://github.com/tmustier/pi-agent-teams). Each worker is a
full interactive `pi` session in its own terminal pane that joins the current team, claims shared
tasks, and answers mailbox messages, so you can watch it work and type into it directly.

Two pane backends, picked automatically:

- **herdr** when pi runs inside a [herdr](https://herdr.dev) workspace (`HERDR_ENV=1`). Workers are
  created with `herdr pane split` and started with `herdr agent start`, so each one becomes a *named*
  herdr agent with real idle/working/blocked state in the sidebar, `herdr agent list`, and
  `herdr agent prompt`.
- **it2** when pi runs inside iTerm2 with the [`it2`](https://github.com/mkusaka/it2) CLI on PATH.

Layout is the same either way: leader on the left, workers stacked in a right-hand column, each one
the same height. A single worker gets the full column; every later worker takes a fair share of it,
whether the whole team is spawned at once or the workers trickle in one at a time. On herdr the split
is sized up front (`pane split --ratio`) and the dividers are walked afterwards (`pane resize`) so the
column stays even after every spawn and close. it2 can neither size a split nor resize one, so there
each worker splits the roomiest pane, which keeps the column within a factor of two.

## Install

```bash
pi install git:github.com/dulvac/pi-team-panes
```

Requires `@tmustier/pi-agent-teams` (it provides the team the workers join) plus either herdr, or
iTerm2 with `it2` and the iTerm2 Python API enabled.

## Use

```
/panes sage grace        spawn two pane workers
/panes list              list panes spawned by this session
/panes close sage        close one worker's pane
/panes close --all       close all of them
/panes                   show usage and the active backend
```

The model drives the same machinery through the `pane_workers` tool (`spawn`, `delegate`, `list`,
`close`). `delegate` spawns any missing workers and creates shared tasks in one call; tasks are left
unassigned by default so idle workers claim them themselves.

Everything else stays on the `teams` tool: messaging, `member_status`, task mutations, `team_done`.
Pane-management commands and tools are leader-only; workers should request more teammates from the leader.
Do not pass pane-worker names to `teams delegate` or `member_spawn`, since those spawn headless RPC
workers and you would end up with two agents wearing the same name.

## Configuration

| Variable | Effect |
| --- | --- |
| `PI_PANES_BACKEND` | `herdr`, `it2`, or `auto` (default). Forces a backend. |
| `PI_PANES_DEFAULT=0` | Skip the pane-first system prompt injection. |
| `PI_PANES_START_TIMEOUT_MS` | Readiness timeout for `herdr agent start` (default 90000). |
| `PI_PANES_EQUALIZE=0` | Leave pane sizes alone instead of evening out the column (herdr). |

Worker environment (`PI_TEAMS_*`) uses the active team's IDs and style, so pane workers and
RPC teammates share one task list and one team config. Assigned tasks receive a mailbox notification;
unassigned tasks are claimed by idle workers. Existing workers keep their startup task list: close and
respawn them after `/team task use` or `/team attach` before delegating more work to them.

### Live team state bridge

The current pi-agent-teams release keeps the active team and task-list IDs in memory without exposing
an API. Its config file can be stale after `/team task use`. This package therefore requires a small
local bridge rather than guessing which task list to use.

Install it explicitly, using the directory where your pi-agent-teams package is installed:

```bash
node scripts/teams-bridge.ts install ~/.pi/agent/npm/node_modules/@tmustier/pi-agent-teams
```

Then run `/reload` in pi. Git, project-local, and local-path installs work too: pass their package
root instead. The script changes only `extensions/teams/leader.ts`, adding an in-process state
request handler and a shutdown cleanup handler. It makes no network requests and is not run
automatically. Installation is idempotent and refuses an edited bridge or unsupported source layout.
A pi-agent-teams update may remove it; rerun the installer after updating.

To remove it without discarding other edits:

```bash
node scripts/teams-bridge.ts remove ~/.pi/agent/npm/node_modules/@tmustier/pi-agent-teams
```

Reload again after removal. Without the bridge, listing and closing tracked panes still work;
spawning and delegation fail before creating panes or tasks. The tool locates task-store and mailbox
modules from the loaded extension's source metadata, not a hardcoded global npm directory.

## Notes on the herdr backend

Worker env is injected at pane creation (`herdr pane split --env`), so `herdr agent start` inherits
it without a shell prefix. If herdr cannot confirm readiness in time, the pane is left alone and the
tool says so: pi may still be booting there, and sending a command into a booting agent would type
into its prompt. Busy panes never receive a raw command. Pre-launch failures such as
`agent_name_taken` may fall back to `herdr pane run` only after another shell-readiness check.

Pane ids are base36 per workspace (`w4:p1`, `wG:pA`, `wH:p1B`). Anything that parses them must accept
letters, not just digits.

## Development

```bash
npm install
npm test         # unit tests for backend selection, arg building, output parsing
npm run typecheck
```

`src/panes-core.ts` holds the pure logic (backend choice, layout math, argument construction, parsing)
and imports nothing from pi, which is what makes it testable on its own. The layout tests drive the
planners through a model of herdr's split and resize behaviour, measured against a live herdr, so a
regression in the sizing math fails in `npm test` rather than on screen. `src/index.ts` is the pi glue:
command, tool, and the pane-first policy.

## Worker activity in the teams widget

pi-agent-teams derives the widget's status and counters from a `TeammateRpc` handle, which exists only
for teammates its leader spawned itself. A pane worker is an independent `pi` process that
self-registers into the roster, so the leader holds no handle for it: `resolveDisplayStatus` falls
through to a hardcoded `"idle"` and every counter reads zero, however busy the worker is. In a long
run that means the widget and `member_status` both report `idle · 0 tool calls · 0 turns · 0 tokens`
for workers that are editing files and committing.

This package closes that gap without a second widget. Each roster member records its own transcript
path, and a pi transcript carries everything the tracker consumes: assistant `usage.totalTokens`,
`toolCall` blocks and their `toolResult` answers, and per-entry timestamps. `src/worker-activity.ts`
folds appended bytes into counters, `src/index.ts` polls every 1.5s and publishes on the
`teams:activity` event channel, and pi-agent-teams' leader feeds those numbers into the tracker it
already has, so the existing widget, the interactive panel and `member_status` all show the truth.

Status comes from herdr's own per-pane `agent_status` when the herdr backend is active, because herdr
knows a worker is thinking during a long pause where the transcript is silent. Without that (the it2
backend), status is inferred: an unanswered tool call means working, otherwise transcript recency
decides, and a worker whose transcript is still empty reads as `starting` rather than `idle`.

The consumer half is five small edits to pi-agent-teams (verified against a pristine `0.5.5` tarball),
open upstream as [tmustier/pi-agent-teams#49](https://github.com/tmustier/pi-agent-teams/pull/49) and
kept here in `upstream/pi-agent-teams-activity.patch` until it lands:

```bash
cd ~/.pi/agent/npm/node_modules/@tmustier/pi-agent-teams
patch -p1 < /path/to/pi-team-panes/upstream/pi-agent-teams-activity.patch
```

It adds `ActivityTracker.applyExternal`, an external-activity registry consulted by
`resolveDisplayStatus` and `resolveStatus`, a `resolveLastEventAge` helper so `member_status` and
`/team info` can report how long a pane worker has been quiet, and a
`pi.events.on("teams:activity", ...)` subscription in the leader. A live RPC handle always wins over an
external report, an offline member stays `stopped`, and a stale `streaming` report degrades to
`stalled` on the existing threshold. Reapply the patch after updating pi-agent-teams; without it this
package still works, the widget just keeps showing zeros.

Measured on a live run: a pane worker went `starting` to `streaming` with its current tool named,
counters climbing 5 to 8 tool calls and 225k to 403k tokens, back to `idle` between turns, then
`stopped` with counters cleared when the pane closed.

## License

MIT
