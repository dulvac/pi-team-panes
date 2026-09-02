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

Layout is the same either way: leader on the left, workers stacked in a right-hand column.

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
Do not pass pane-worker names to `teams delegate` or `member_spawn`, since those spawn headless RPC
workers and you would end up with two agents wearing the same name.

## Configuration

| Variable | Effect |
| --- | --- |
| `PI_PANES_BACKEND` | `herdr`, `it2`, or `auto` (default). Forces a backend. |
| `PI_PANES_DEFAULT=0` | Skip the pane-first system prompt injection. |
| `PI_PANES_START_TIMEOUT_MS` | Readiness timeout for `herdr agent start` (default 90000). |

Worker environment (`PI_TEAMS_*`) mirrors what `/team env <name>` produces, so pane workers and
RPC teammates share one task list and one team config.

## Notes on the herdr backend

Worker env is injected at pane creation (`herdr pane split --env`), so `herdr agent start` inherits
it without a shell prefix. If herdr cannot confirm readiness in time, the pane is left alone and the
tool says so: pi may still be booting there, and sending a command into a booting agent would type
into its prompt. Only failures that happen *before* launch (`agent_pane_busy`,
`agent_pane_not_found`, `agent_name_taken`) fall back to a plain `herdr pane run`.

Pane ids are base36 per workspace (`w4:p1`, `wG:pA`, `wH:p1B`). Anything that parses them must accept
letters, not just digits.

## Development

```bash
npm install
npm test         # unit tests for backend selection, arg building, output parsing
npm run typecheck
```

`src/panes-core.ts` holds the pure logic (backend choice, layout, argument construction, parsing) and
imports nothing from pi, which is what makes it testable on its own. `src/index.ts` is the pi glue:
command, tool, and the pane-first policy.

## License

MIT
