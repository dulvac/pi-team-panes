/**
 * team-panes — Claude-Code-style split-pane workers for pi-agent-teams.
 *
 * Spawns pi-agent-teams "manual workers" in real terminal panes, each running a
 * full interactive `pi` session that self-registers into the current team, polls
 * and auto-claims shared tasks, and takes part in mailbox DMs/broadcasts, while
 * staying directly watchable and typeable.
 *
 * Two pane backends, picked automatically (override with PI_PANES_BACKEND):
 *  - herdr  when running inside a herdr workspace (HERDR_ENV=1). Workers become
 *           named herdr agents, so herdr tracks their idle/working/blocked state.
 *  - it2    when running inside iTerm2 with the `it2` CLI on PATH.
 *
 * Layout in both cases: leader left, members stacked in an evenly sized right-hand
 * column, whether the team is spawned in one call or trickles in one worker at a
 * time.
 *
 * Commands:
 *  /panes sage grace     spawn two pane workers
 *  /panes list           list panes spawned by this session
 *  /panes close sage     close a worker's pane (--all for every one)
 *
 * The model drives panes through the `pane_workers` tool (spawn/delegate/list/close).
 *
 * Env:
 *  PI_PANES_BACKEND=herdr|it2|auto   force a backend (default auto)
 *  PI_PANES_DEFAULT=0                do not inject the pane-first system prompt
 *  PI_PANES_START_TIMEOUT_MS         readiness timeout for herdr agent start
 *  PI_PANES_EQUALIZE=0               leave pane sizes alone (herdr)
 */
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as fs from "node:fs";

import {
  type BackendKind,
  type ColumnPane,
  columnFromLayout,
  equalizeStep,
  herdrAgentStartArgs,
  herdrCloseArgs,
  herdrLayoutArgs,
  herdrProcessInfoArgs,
  herdrResizeArgs,
  herdrRunArgs,
  herdrSnapshotArgs,
  herdrSplitArgs,
  isPreLaunchFailure,
  isShellAtPrompt,
  it2CloseArgs,
  it2RunArgs,
  it2SplitArgs,
  leaderPane,
  paneFirstPolicy,
  parseHerdrLayout,
  parseHerdrPaneId,
  parseHerdrPaneStatuses,
  parseIt2PaneId,
  pickBackend,
  sanitizeName,
  splitPlan,
  workerCommand,
} from "./panes-core.ts";
import {
  activityPayload,
  consumeSlice,
  deriveStatus,
  emptyCounters,
  type ActivityCounters,
  type ActivityPayload,
} from "./worker-activity.ts";

const execFileP = promisify(execFile);

/**
 * Panes spawned by this leader session: worker name -> pane, backend, and a
 * modelled height share (fraction of the column) used when the backend cannot
 * report real geometry.
 */
const panes = new Map<string, { paneId: string; backend: BackendKind; share: number }>();

// ---- Pane-worker activity -------------------------------------------------
// pi-agent-teams derives the widget's status and counters from a TeammateRpc
// handle, which exists only for teammates its leader spawned itself. A pane
// worker is an independent pi process, so there is no handle,
// resolveDisplayStatus falls through to a hardcoded "idle", and every counter
// reads zero however busy the worker is. Each worker's transcript holds the same
// facts, so we read those and publish them on pi.events for the widget.

const ACTIVITY_CHANNEL = "teams:activity";
const ACTIVITY_POLL_MS = 1_500;
const PANE_STATUS_TTL_MS = 5_000;

interface RosterMember {
  name: string;
  status?: string;
  sessionFile?: string;
}

const activity = new Map<string, ActivityCounters>();
const publishedActivity = new Map<string, string>();
let activityTimer: ReturnType<typeof setInterval> | null = null;
let activityTeamId: string | null = null;
let bus: { emit(channel: string, data: unknown): void } | null = null;
let paneStatusAt = 0;
let paneStatusCache = new Map<string, string>();

/** Members as the roster file has them; we need sessionFile and status. */
function rosterMembers(teamId: string): Map<string, RosterMember> {
  const found = new Map<string, RosterMember>();
  try {
    const raw = fs.readFileSync(path.join(teamsRootDir(), teamId, "config.json"), "utf8");
    const parsed = JSON.parse(raw) as { members?: unknown };
    if (!Array.isArray(parsed.members)) return found;
    for (const member of parsed.members) {
      if (typeof member !== "object" || member === null) continue;
      const { name } = member as RosterMember;
      if (typeof name === "string") found.set(name, member as RosterMember);
    }
  } catch {
    // No roster yet, or a write in flight: the next poll picks it up.
  }
  return found;
}

/** herdr's own per-pane agent state, cached because each call spawns a CLI. */
async function livePaneStatuses(backend: BackendKind): Promise<Map<string, string>> {
  if (backend !== "herdr") return new Map();
  const now = Date.now();
  if (now - paneStatusAt < PANE_STATUS_TTL_MS) return paneStatusCache;
  paneStatusAt = now;
  try {
    paneStatusCache = parseHerdrPaneStatuses(await run("herdr", herdrSnapshotArgs()));
  } catch {
    paneStatusCache = new Map();
  }
  return paneStatusCache;
}

/**
 * Read whatever was appended past `offset`.
 *
 * A shrunken file means the transcript was rotated or replaced, so the caller
 * starts over rather than reading from a stale offset. A tail ending
 * mid-character is harmless: only whole lines are consumed, so those bytes get
 * re-read from their real start on the next poll.
 */
function readAppended(file: string, offset: number): { text: string; reset: boolean } {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { text: "", reset: false };
  }
  if (size < offset) return { text: "", reset: true };
  if (size === offset) return { text: "", reset: false };
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(size - offset);
    const read = fs.readSync(fd, buf, 0, buf.length, offset);
    return { text: buf.subarray(0, read).toString("utf8"), reset: false };
  } finally {
    fs.closeSync(fd);
  }
}

/** Publish only on change, so an idle team does not emit twice a second. */
function publishActivity(payload: ActivityPayload): void {
  const encoded = JSON.stringify(payload);
  if (publishedActivity.get(payload.name) === encoded) return;
  publishedActivity.set(payload.name, encoded);
  bus?.emit(ACTIVITY_CHANNEL, payload);
}

async function pollActivity(): Promise<void> {
  if (!bus || !activityTeamId) return;
  if (panes.size === 0) {
    stopActivityPoller();
    return;
  }
  const members = rosterMembers(activityTeamId);
  const now = Date.now();
  for (const [name, entry] of panes) {
    const member = members.get(name);
    const statuses = await livePaneStatuses(entry.backend);
    let counters = activity.get(name) ?? emptyCounters();
    if (member?.sessionFile) {
      const { text, reset } = readAppended(member.sessionFile, counters.offset);
      if (reset) counters = emptyCounters();
      else if (text) counters = consumeSlice(counters, text);
    }
    activity.set(name, counters);
    publishActivity(
      activityPayload(
        name,
        deriveStatus({
          memberOnline: member?.status === "online",
          paneStatus: statuses.get(entry.paneId),
          counters,
          now,
        }),
        counters,
      ),
    );
  }
}

function startActivityPoller(teamId: string): void {
  activityTeamId = teamId;
  if (activityTimer) return;
  activityTimer = setInterval(() => void pollActivity(), ACTIVITY_POLL_MS);
  // Never keep a pi process alive just to report on panes.
  activityTimer.unref?.();
  void pollActivity();
}

function stopActivityPoller(): void {
  if (!activityTimer) return;
  clearInterval(activityTimer);
  activityTimer = null;
}

/** A closed pane leaves no ghost row: say stopped once, then forget it. */
function forgetActivity(name: string): void {
  const counters = activity.get(name) ?? emptyCounters();
  activity.delete(name);
  publishedActivity.delete(name);
  bus?.emit(ACTIVITY_CHANNEL, activityPayload(name, "stopped", counters));
}

const CLI: Record<BackendKind, string> = { herdr: "herdr", it2: "it2" };
const INSTALL_HINT: Record<BackendKind, string> = {
  herdr: "`herdr` not found on PATH. Install from https://herdr.dev",
  it2: "`it2` not found on PATH. Install with: uv tool install it2",
};

async function run(kind: BackendKind, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP(CLI[kind], args, { timeout: 120_000 });
    return stdout.trim();
  } catch (err: any) {
    if (err?.code === "ENOENT") throw new Error(INSTALL_HINT[kind]);
    const detail = (err?.stderr || err?.message || "").trim();
    throw new Error(`${CLI[kind]} ${args.slice(0, 2).join(" ")} failed: ${detail}`);
  }
}

/** Cached availability probe per backend. */
const availability = new Map<BackendKind, boolean>();
async function isAvailable(kind: BackendKind): Promise<boolean> {
  const cached = availability.get(kind);
  if (cached !== undefined) return cached;
  const probe = kind === "herdr" ? ["status", "client"] : ["--version"];
  let ok = true;
  try {
    await execFileP(CLI[kind], probe, { timeout: 5_000 });
  } catch (err: any) {
    ok = err?.code !== "ENOENT";
  }
  availability.set(kind, ok);
  return ok;
}

/** Resolve the backend for this session, or throw with the reason. */
function activeBackend(): BackendKind {
  const { kind, reason } = pickBackend(process.env);
  if (!kind) {
    throw new Error(
      `No pane backend available: ${reason}. Run pi inside herdr or iTerm2, ` +
        "or set PI_PANES_BACKEND=herdr|it2.",
    );
  }
  return kind;
}

function teamsRootDir(): string {
  const override = process.env.PI_TEAMS_ROOT_DIR?.trim();
  if (override) return path.isAbsolute(override) ? override : path.join(getAgentDir(), override);
  return path.join(getAgentDir(), "teams");
}

/** Same env a `/team env <name>` manual worker gets. */
function workerEnv(name: string, teamId: string): Record<string, string> {
  return {
    PI_TEAMS_ROOT_DIR: teamsRootDir(),
    PI_TEAMS_WORKER: "1",
    PI_TEAMS_TEAM_ID: teamId,
    PI_TEAMS_TASK_LIST_ID: process.env.PI_TEAMS_TASK_LIST_ID ?? teamId,
    PI_TEAMS_AGENT_NAME: name,
    PI_TEAMS_LEAD_NAME: process.env.PI_TEAMS_LEAD_NAME ?? "team-lead",
    PI_TEAMS_STYLE: process.env.PI_TEAMS_STYLE ?? "normal",
    PI_TEAMS_AUTO_CLAIM: (process.env.PI_TEAMS_DEFAULT_AUTO_CLAIM ?? "1") === "1" ? "1" : "0",
  };
}

/**
 * Reuse the installed pi-agent-teams task-store so tasks created here land in the
 * same shared list the workers poll and the teams widget renders.
 */
async function loadTaskStore(): Promise<{
  createTask: (
    teamDir: string,
    taskListId: string,
    input: { subject: string; description: string; owner?: string },
  ) => Promise<{ id: string; subject: string }>;
}> {
  const base = path.join(
    getAgentDir(),
    "npm", "node_modules", "@tmustier", "pi-agent-teams",
    "extensions", "teams", "task-store.ts",
  );
  if (!fs.existsSync(base)) {
    throw new Error(
      `pi-agent-teams task-store not found at ${base} — is the pi-agent-teams package installed?`,
    );
  }
  return await import(base);
}

function startTimeoutMs(): number {
  const raw = Number(process.env.PI_PANES_START_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 90_000;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The worker column as it looks right now, top to bottom.
 *
 * herdr reports real pane rects, which also picks up panes the user resized,
 * closed or added by hand. it2 exposes no usable geometry (its session list
 * truncates ids), so there we fall back to the modelled shares, in spawn order:
 * that backend only needs the heights, since it can neither size nor resize.
 */
async function workerColumn(backend: BackendKind, leader?: string): Promise<ColumnPane[]> {
  const tracked = [...panes.values()].filter((entry) => entry.backend === backend);
  if (tracked.length === 0) return [];
  if (backend === "herdr") {
    const live = await liveColumn(leader, tracked.map((entry) => entry.paneId));
    if (live) return live;
  }
  return tracked.map((entry) => ({ paneId: entry.paneId, height: entry.share }));
}

async function liveColumn(
  leader: string | undefined,
  trackedIds: string[],
): Promise<ColumnPane[] | null> {
  try {
    const layout = parseHerdrLayout(await run("herdr", herdrLayoutArgs(leader)));
    return columnFromLayout(layout, trackedIds);
  } catch {
    return null; // layout unavailable: fall back to modelled shares
  }
}

/** Keep the modelled shares in step with a split, and return the new pane's. */
function trackShare(source: string | undefined, ratio: number, firstWorker: boolean): number {
  if (firstWorker) return 1;
  const donor = [...panes.values()].find((entry) => entry.paneId === source);
  if (!donor) return 1;
  const before = donor.share;
  donor.share = before * ratio;
  return before * (1 - ratio);
}

/**
 * Even out the worker column: every worker gets the same height, and a lone
 * worker gets the whole column.
 *
 * Split ratios alone cannot do it, because workers usually arrive one at a time
 * and a split can only divide the pane it targets, so after each spawn or close
 * the dividers get walked from the top. herdr rounds a move to whole rows, hence
 * the re-measure between moves. Skipped when the column no longer looks like the
 * layout this extension builds, or via PI_PANES_EQUALIZE=0.
 */
async function equalizeColumn(backend: BackendKind, leader?: string): Promise<void> {
  if (backend !== "herdr" || process.env.PI_PANES_EQUALIZE === "0") return;
  const trackedIds = [...panes.values()]
    .filter((entry) => entry.backend === backend)
    .map((entry) => entry.paneId);
  if (trackedIds.length < 2) return;

  let column = await liveColumn(leader, trackedIds);
  for (let i = 0; column && i < column.length - 1; i++) {
    const op = equalizeStep(column, i);
    if (!op) continue;
    try {
      await run("herdr", herdrResizeArgs(op));
    } catch {
      return; // a stale pane id or a clamped boundary: leave the rest alone
    }
    column = await liveColumn(leader, trackedIds);
  }
}

/**
 * Wait until a freshly split pane is back at its interactive shell prompt.
 * `herdr agent start` refuses a pane whose foreground still runs the shell's own
 * startup helpers, and that refusal looks identical to a genuinely busy pane.
 */
async function waitForShellPrompt(pane: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (isShellAtPrompt(await run("herdr", herdrProcessInfoArgs(pane)))) return true;
    } catch {
      /* transient: the pane may not be queryable yet */
    }
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
}

/** Start pi as a named herdr agent, retrying once if the pane is still settling. */
async function startHerdrAgent(name: string, pane: string): Promise<void> {
  await waitForShellPrompt(pane);
  const args = herdrAgentStartArgs({ name, pane, timeoutMs: startTimeoutMs() });
  try {
    await run("herdr", args);
  } catch (err: any) {
    if (!String(err?.message ?? err).includes("agent_pane_busy")) throw err;
    await sleep(1_000);
    await run("herdr", args);
  }
}

async function spawnPaneWorker(
  name: string,
  teamId: string,
  cwd: string,
  remaining = 1,
): Promise<{ paneId: string; note?: string }> {
  const existing = panes.get(name);
  if (existing) throw new Error(`Pane worker "${name}" already exists (${existing.paneId})`);

  const backend = activeBackend();
  const leader = leaderPane(backend, process.env);
  const column = await workerColumn(backend, leader);
  const plan = splitPlan({ leader, column, remaining, withRatio: backend === "herdr" });
  const share = trackShare(plan.source, plan.ratio ?? 0.5, column.length === 0);
  const env = workerEnv(name, teamId);

  if (backend === "it2") {
    const paneId = parseIt2PaneId(await run("it2", it2SplitArgs(plan)));
    await run("it2", it2RunArgs(paneId, workerCommand({ cwd, env })));
    panes.set(name, { paneId, backend, share });
    startActivityPoller(teamId);
    return { paneId };
  }

  // herdr: inject the worker env at pane creation, then let herdr launch and
  // name the agent so its lifecycle state shows up in the sidebar and CLI.
  const paneId = parseHerdrPaneId(await run("herdr", herdrSplitArgs({ plan, cwd, env })));
  panes.set(name, { paneId, backend, share });
  startActivityPoller(teamId);
  // Size the column before pi boots, so the worker starts at its final size.
  await equalizeColumn(backend, leader);
  try {
    await startHerdrAgent(name, paneId);
    return { paneId };
  } catch (err: any) {
    const detail = String(err?.message ?? err);
    if (!isPreLaunchFailure(detail)) {
      // pi may still be booting in that pane; typing into it would hit its prompt.
      return {
        paneId,
        note: `herdr did not confirm readiness for "${name}" (${detail}); the pane is up, ` +
          "check it directly if the worker does not appear.",
      };
    }
    await run("herdr", herdrRunArgs(paneId, workerCommand({ cwd, env })));
    return { paneId, note: `started "${name}" without herdr agent registration (${detail})` };
  }
}

async function closePaneWorker(name: string): Promise<void> {
  const entry = panes.get(name);
  if (!entry) throw new Error(`No pane tracked for "${name}"`);
  const args = entry.backend === "herdr" ? herdrCloseArgs(entry.paneId) : it2CloseArgs(entry.paneId);
  await run(entry.backend, args).catch(() => {
    /* pane may already be closed by hand */
  });
  panes.delete(name);
  forgetActivity(name);
  if (panes.size === 0) stopActivityPoller();
  // The closed pane's rows go to one neighbour; hand them round instead.
  await equalizeColumn(entry.backend, leaderPane(entry.backend, process.env));
}

function listText(): string {
  if (panes.size === 0) return "No pane workers spawned by this session.";
  return [...panes.entries()]
    .map(([name, { paneId, backend }]) => `${name} → ${backend} pane ${paneId}`)
    .join("\n");
}

function paneFirstConfigured(): boolean {
  return (
    process.env.PI_PANES_DEFAULT !== "0" &&
    process.env.PI_TEAMS_WORKER !== "1" // never inject into workers themselves
  );
}

/** Hoisted so typebox's inference stays shallow enough for `tsc --noEmit`. */
const TASK_SCHEMA = Type.Object({
  text: Type.String({ description: "Task / TODO text" }),
  assignee: Type.Optional(
    Type.String({
      description:
        "Optional owner. Omit to leave unassigned (recommended: auto-claimed by idle pane workers)",
    }),
  ),
});

const PANE_WORKERS_PARAMS = Type.Object({
  action: StringEnum(["spawn", "delegate", "list", "close"] as const),
  names: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Worker names (required for spawn/close; for delegate: pane workers to ensure exist)",
    }),
  ),
  tasks: Type.Optional(
    Type.Array(TASK_SCHEMA, { description: "Tasks to create (action=delegate)" }),
  ),
});

export default function (pi: ExtensionAPI) {
  // Channel for pane-worker activity, consumed by the teams widget.
  bus = pi.events;

  // ---- Pane-first default: inject policy so the model prefers panes ---------
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!paneFirstConfigured()) return;
    const { kind } = pickBackend(process.env);
    if (!kind) return;
    if (!(await isAvailable(kind))) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${paneFirstPolicy(kind)}` };
  });

  // ---- /panes command ------------------------------------------------------
  pi.registerCommand("panes", {
    description: "Spawn/close pi-agent-teams workers in split panes (herdr or iTerm2)",
    handler: async (args, ctx) => {
      const argv = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const rest = argv.filter((a) => a !== "-v"); // -v accepted but ignored (auto layout)
      const sub = rest[0];

      try {
        if (!sub || sub === "help") {
          const { kind, reason } = pickBackend(process.env);
          ctx.ui.notify(
            "Usage: /panes <name> [name2 ...] | /panes list | /panes close <name>|--all\n" +
              `Backend: ${kind ?? "none"} (${reason})`,
            "info",
          );
          return;
        }
        if (sub === "list") {
          ctx.ui.notify(listText(), "info");
          return;
        }
        if (sub === "close") {
          const targets = rest[1] === "--all" ? [...panes.keys()] : rest.slice(1).map(sanitizeName);
          if (targets.length === 0) {
            ctx.ui.notify("Usage: /panes close <name> | /panes close --all", "error");
            return;
          }
          for (const target of targets) await closePaneWorker(target);
          ctx.ui.notify(`Closed pane(s): ${targets.join(", ")}`, "info");
          return;
        }

        const teamId = process.env.PI_TEAMS_TEAM_ID ?? ctx.sessionManager.getSessionId();
        const spawned: string[] = [];
        const notes: string[] = [];
        const wanted = rest.map(sanitizeName);
        for (const [index, name] of wanted.entries()) {
          const { paneId, note } = await spawnPaneWorker(
            name,
            teamId,
            ctx.cwd,
            wanted.length - index,
          );
          spawned.push(`${name} (pane ${paneId})`);
          if (note) notes.push(note);
        }
        ctx.ui.notify(
          [
            `Spawned pane worker(s): ${spawned.join(", ")}`,
            `They join team ${teamId} and auto-claim tasks.`,
            ...notes,
          ].join("\n"),
          "info",
        );
      } catch (err: any) {
        ctx.ui.notify(err?.message ?? String(err), "error");
      }
    },
  });

  // ---- LLM-callable tool ---------------------------------------------------
  pi.registerTool({
    name: "pane_workers",
    label: "Pane Workers",
    description:
      "Manage pi-agent-teams manual workers running in visible split panes (herdr panes when pi runs " +
      "inside herdr, iTerm2 panes via the it2 CLI otherwise). Action 'spawn' creates pane workers; " +
      "'delegate' spawns any missing pane workers AND creates shared tasks (unassigned by default — " +
      "pane workers poll and auto-claim them; pass a task assignee only when a specific worker must " +
      "own it). 'list'/'close' manage panes. Workers self-register into the current team; use the " +
      "teams tool for messaging, status, task mutations, and team_done. Panes use a fixed layout: " +
      "leader left, members stacked in an evenly sized right-hand column.",
    parameters: PANE_WORKERS_PARAMS,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { action, names = [], tasks = [] } = params;

      if (action === "list") {
        return { content: [{ type: "text", text: listText() }], details: {} };
      }

      if (action === "close") {
        if (names.length === 0) {
          return {
            content: [{ type: "text", text: '"names" is required for action=close' }],
            isError: true,
            details: {},
          };
        }
        for (const raw of names) await closePaneWorker(sanitizeName(raw));
        return {
          content: [{ type: "text", text: `Closed pane(s): ${names.join(", ")}` }],
          details: {},
        };
      }

      const teamId = process.env.PI_TEAMS_TEAM_ID ?? ctx.sessionManager.getSessionId();
      const lines: string[] = [];

      if (action === "spawn" && names.length === 0) {
        return {
          content: [{ type: "text", text: '"names" is required for action=spawn' }],
          isError: true,
          details: {},
        };
      }
      const wanted = names
        .map(sanitizeName)
        .filter((name) => !(action === "delegate" && panes.has(name)));
      for (const [index, name] of wanted.entries()) {
        const { paneId, note } = await spawnPaneWorker(
          name,
          teamId,
          ctx.cwd,
          wanted.length - index,
        );
        lines.push(`Spawned "${name}" in pane ${paneId} (team ${teamId}).`);
        if (note) lines.push(note);
      }

      if (action === "delegate") {
        if (tasks.length === 0) {
          return {
            content: [{ type: "text", text: '"tasks" is required for action=delegate' }],
            isError: true,
            details: {},
          };
        }
        const { createTask } = await loadTaskStore();
        const teamDir = path.join(teamsRootDir(), teamId);
        const taskListId = process.env.PI_TEAMS_TASK_LIST_ID ?? teamId;
        for (const task of tasks) {
          const text = task.text.trim();
          if (!text) continue;
          const subject = (text.split("\n")[0] ?? "").slice(0, 120);
          const owner = task.assignee ? sanitizeName(task.assignee) : undefined;
          const created = await createTask(teamDir, taskListId, {
            subject,
            description: text,
            owner,
          });
          lines.push(
            `Created task #${created.id}: ${subject}${owner ? ` → ${owner}` : " (unassigned)"}`,
          );
        }
        lines.push(
          "Pane workers poll the shared task list and auto-claim unassigned, unblocked tasks once " +
            "their pi session is up (a few seconds). Monitor via the teams tool (member_status) or /tw.",
        );
      } else {
        lines.push(
          "Workers appear in the team widget once their pi session starts (a few seconds). " +
            "They auto-claim unassigned tasks; use the teams tool to assign tasks or send messages.",
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });
}
