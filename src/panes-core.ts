/**
 * Pure helpers for team-panes: argument construction, backend selection, output
 * parsing, pane-id grammar. No pi or child_process imports, so this module can
 * be unit-tested standalone (`npm test`).
 */

export type BackendKind = "herdr" | "it2";
export type Direction = "right" | "down";
export type Env = Record<string, string | undefined>;

/**
 * Herdr pane ids are base36 per workspace: w4:p1, wG:pA, wH:p1B. Matching only
 * decimal digits here once caused a shim to mistake wG:pA for "not a pane id"
 * and act on the caller instead, killing a live agent pane.
 */
export const HERDR_PANE_ID_RE = /^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/;

/** it2 pane ids are iTerm2 session UUIDs. */
export const IT2_PANE_ID_RE = /^[0-9A-Fa-f-]{8,}$/;

export interface BackendChoice {
  kind: BackendKind | null;
  reason: string;
}

/** Which pane backend to use: explicit override first, then environment. */
export function pickBackend(env: Env): BackendChoice {
  const override = env.PI_PANES_BACKEND?.trim().toLowerCase();
  if (override === "herdr" || override === "it2") {
    return { kind: override, reason: `PI_PANES_BACKEND=${override}` };
  }
  if (override && override !== "auto") {
    return { kind: null, reason: `unknown PI_PANES_BACKEND="${override}" (use herdr, it2 or auto)` };
  }
  if (env.HERDR_ENV === "1" && env.HERDR_PANE_ID) {
    return { kind: "herdr", reason: `herdr pane ${env.HERDR_PANE_ID}` };
  }
  if (env.ITERM_SESSION_ID) {
    return { kind: "it2", reason: "iTerm2 session (it2 CLI)" };
  }
  return { kind: null, reason: "not running inside herdr or iTerm2" };
}

export function sanitizeName(raw: string): string {
  const name = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!name) throw new Error(`Invalid worker name: "${raw}"`);
  return name;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `K='v' K2='v2'` prefix for a shell command line. */
export function envAssignments(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
}

/** The pane pi itself runs in, as the active backend names it. */
export function leaderPane(kind: BackendKind, env: Env): string | undefined {
  if (kind === "herdr") return env.HERDR_PANE_ID;
  const raw = env.ITERM_SESSION_ID;
  if (!raw) return undefined;
  const idx = raw.indexOf(":");
  return idx >= 0 ? raw.slice(idx + 1) : raw;
}

export interface SplitPlan {
  /** Pane to split; undefined means "the backend's current/active pane". */
  source?: string;
  direction: Direction;
  /** it2 spelling of direction=right. */
  vertical: boolean;
}

/**
 * Column layout: the first worker splits the leader side by side, later workers
 * stack under the previous worker. Leader | [w1 / w2 / ...].
 */
export function splitPlan(opts: { leader?: string; lastMember?: string }): SplitPlan {
  if (opts.lastMember) {
    return { source: opts.lastMember, direction: "down", vertical: false };
  }
  return { source: opts.leader, direction: "right", vertical: true };
}

export function herdrSplitArgs(opts: {
  plan: SplitPlan;
  cwd: string;
  env?: Record<string, string>;
}): string[] {
  const args = ["pane", "split"];
  if (opts.plan.source) args.push("--pane", opts.plan.source);
  else args.push("--current");
  args.push("--direction", opts.plan.direction, "--no-focus", "--cwd", opts.cwd);
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    args.push("--env", `${key}=${value}`);
  }
  return args;
}

export function herdrAgentStartArgs(opts: {
  name: string;
  pane: string;
  timeoutMs: number;
}): string[] {
  return [
    "agent", "start", opts.name,
    "--kind", "pi",
    "--pane", opts.pane,
    "--timeout", String(opts.timeoutMs),
  ];
}

export function herdrRunArgs(pane: string, command: string): string[] {
  return ["pane", "run", pane, command];
}

export function herdrCloseArgs(pane: string): string[] {
  return ["pane", "close", pane];
}

export function herdrRenameArgs(pane: string, title: string): string[] {
  return ["pane", "rename", pane, title];
}

export function it2SplitArgs(plan: SplitPlan): string[] {
  const args = ["session", "split"];
  if (plan.vertical) args.push("-v");
  if (plan.source) args.push("--session", plan.source);
  return args;
}

export function it2RunArgs(pane: string, command: string): string[] {
  return ["session", "run", command, "--session", pane];
}

export function it2CloseArgs(pane: string): string[] {
  return ["session", "close", "--force", "--session", pane];
}

export function parseIt2PaneId(stdout: string): string {
  const match = stdout.match(/Created new pane:\s*(\S+)/);
  if (!match) throw new Error(`Could not parse new pane id from it2 output: "${stdout.trim()}"`);
  return match[1]!;
}

export function parseHerdrPaneId(stdout: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error(`Could not parse herdr JSON response: "${stdout.trim().slice(0, 200)}"`);
  }
  const paneId = (payload as { result?: { pane?: { pane_id?: unknown } } })?.result?.pane?.pane_id;
  if (typeof paneId !== "string" || !HERDR_PANE_ID_RE.test(paneId)) {
    throw new Error(`herdr returned an unexpected pane id: ${JSON.stringify(paneId)}`);
  }
  return paneId;
}

/** Command that turns a fresh shell pane into a team worker. */
export function workerCommand(opts: { cwd: string; env: Record<string, string> }): string {
  return `cd ${shellQuote(opts.cwd)} && ${envAssignments(opts.env)} pi`;
}

/**
 * True when `herdr agent start` failed before launching anything, so retrying
 * with a plain `pane run` is safe. Timeouts and detection failures are excluded:
 * pi may be booting in that pane, and typing a command into it would land in the
 * agent's prompt.
 */
export function isPreLaunchFailure(stderr: string): boolean {
  return [
    "agent_pane_not_found",
    "agent_pane_busy",
    "agent_name_taken",
    "unsupported interactive agent kind",
    "invalid_agent_argument",
  ].some((marker) => stderr.includes(marker));
}

const POLICY_BACKEND_LINE: Record<BackendKind, string> = {
  herdr: "pi is running inside a herdr workspace, so pane workers are real herdr panes tracked in the sidebar.",
  it2: "pi is running inside iTerm2 with the `it2` CLI available, so pane workers are iTerm2 split panes.",
};

export function paneFirstPolicy(kind: BackendKind): string {
  return [
    "## Pane-first team policy (team-panes)",
    POLICY_BACKEND_LINE[kind],
    "For multi-agent/team work, DEFAULT to visible split-pane workers without the user asking:",
    "- Spawn workers and create shared tasks with the `pane_workers` tool, action `delegate`",
    "  (tasks are created unassigned by default; pane workers poll and auto-claim them).",
    "- Keep using the `teams` tool for everything else: `message_dm`/`message_broadcast`, `member_status`,",
    "  `task_assign`/`task_set_status`/`task_dep_add`, and `team_done`.",
    "- NEVER pass pane-worker names to the `teams` actions `delegate` or `member_spawn` — those spawn",
    "  headless RPC workers and would create duplicate agents with the same names.",
    "- Use headless `teams` `delegate`/`member_spawn` only when the user explicitly asks for headless",
    "  workers, or when `contextMode: \"branch\"` or `workspaceMode: \"worktree\"` is required (pane",
    "  workers are always fresh-context, shared-workspace). Mention the trade-off when you do.",
  ].join("\n");
}
