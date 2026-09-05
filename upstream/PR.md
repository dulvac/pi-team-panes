# Report activity for teammates the leader did not spawn

## The problem

The widget, the interactive panel and `member_status` all derive a teammate's
status and counters from its `TeammateRpc` handle. That handle is created in one
place, `spawnTeammate` (`extensions/teams/leader.ts:547`), so it exists only for
teammates the leader spawned itself.

Any teammate that joins another way has no handle, and today that produces a
confidently wrong readout rather than a blank one:

- `resolveDisplayStatus` returns a hardcoded `"idle"` for an online member with
  no RPC (`extensions/teams/teams-ui-shared.ts:96-97`).
- `tracker.get(name)` returns `emptyActivity()`, so tool calls, turns and tokens
  render as zero (`extensions/teams/activity-tracker.ts:378-380`).
- `member_status` shows `last event: (unknown)` and `time in state: (unknown)`,
  because both are computed only when `rpc` is truthy.

Manual workers created with `/team env <name>` land in exactly this state, and
so does anything that runs a worker in a terminal the leader does not own. In a
long run the effect is a widget that reports `idle · 0 tool calls · 0 turns ·
0 tokens` for workers that are editing files and committing. I drove a
three-task run that way and ended up tracking progress by polling `git log`
instead of reading the widget.

Two things make this hard to work around outside the package. There is no
`pi.events` integration to feed, and the leader re-sets the `pi-teams` widget id
on a 1 s timer (`extensions/teams/leader.ts:761-772`), so a second extension
that renders over it flaps once per second.

## The change

Accept activity from a source that has no RPC handle, and keep everything else
as it was.

- `ActivityTracker.applyExternal(name, activity)` assigns counters
  field-by-field, so a partial report cannot blank out what an earlier, richer
  one established.
- A module-level external-activity registry in `teams-ui-shared.ts`, with
  `setExternalActivity` / `getExternalActivity` / `clearExternalActivity`.
  `resolveDisplayStatus` and `resolveStatus` consult it only when there is no
  RPC handle and the roster says the member is online.
- `resolveLastEventAge(rpc, cfg)`, used by `member_status` and `/team info`, so
  a quiet external worker reports how long it has been quiet instead of
  `(unknown)`. That field is how an operator tells thinking from wedged.
- The leader subscribes to `pi.events.on("teams:activity", ...)`, validates the
  payload, and folds it into the same tracker the RPC path feeds, then renders.

Deliberate properties:

- **An RPC handle always wins.** The subscription returns early when
  `teammates.has(name)`, so a live handle is never second-guessed.
- **The roster still decides existence.** An offline member stays `stopped`
  whatever was last reported.
- **Stall detection extends to external sources.** A `streaming` report older
  than `PI_TEAMS_STALL_THRESHOLD_MS` degrades to `stalled`, same rule as RPC.
- **A `stopped` report clears the row**, so a closed worker leaves no ghost.
- **No behaviour change without a publisher.** With nothing emitting on the
  channel, every code path resolves exactly as it does today.

The event payload uses `TeammateActivity`'s own field names, so the consumer is
an assignment rather than a translation layer that can drift:

```jsonc
{
  "name": "impl3b",
  "status": "streaming",        // starting | idle | streaming | stopped | error
  "toolUseCount": 67,
  "currentToolName": "bash",
  "lastToolName": "bash",
  "turnCount": 3,
  "totalTokens": 6471550,
  "lastEventAt": 1788441978652
}
```

## Who publishes it

[pi-team-panes](https://github.com/dulvac/pi-team-panes) runs workers in split
panes (herdr or iTerm2). Each is a full `pi` process that self-registers into
the roster, so it never had a handle. It now reads each member's `sessionFile`
from the roster, folds appended transcript bytes into counters, and publishes on
this channel every 1.5 s. Status comes from herdr's own per-pane `agent_status`
where available, since that stays accurate through a long thinking pause when
the transcript is silent.

Nothing in this PR depends on that package. Any publisher works, including a
future headless-but-detached worker mode.

## Testing

On the publisher side, 26 unit tests cover the transcript reader and status
derivation, including partial trailing lines, multibyte offsets, and
recovery after a rotated transcript.

On this side, I exercised the resolution paths directly against the patched
files: no report gives today's `idle` and zeros; a live report gives `streaming`
with real counters and the current tool; a six-minute-old `streaming` report
degrades to `stalled`; an RPC handle overrides any external report; an offline
member stays `stopped`; a cleared report returns to zeros. For
`resolveLastEventAge`: no report is `null`, a 42 s-old report reads 42 s, an
empty transcript stays `null`, and an RPC handle still wins.

End to end against `0.5.5` with a pane worker doing five slow steps, watched
through `member_status`: `streaming` with its current tool named, counters
climbing 5 to 8 tool calls and 225k to 403k tokens, `idle` between turns, then
`stopped` with counters cleared when the pane closed. Before the change the same
worker read `idle · 0 · 0 · 0` throughout.

## Notes

- Five files touched, no signatures changed, so all nine `resolveDisplayStatus`
  call sites benefit without edits.
- The registry is module-level mutable state, which is the one thing here I'd
  happily change. It buys the no-call-site-churn property; if you'd rather it
  hang off the leader and be passed through `WidgetDeps`, I'll rework it.
- Happy to split the `resolveLastEventAge` part into its own commit or drop it
  if you consider it scope creep.
