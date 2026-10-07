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
  // Names end up as positional arguments (`herdr agent start <name>`), where a
  // leading hyphen would be read as an option instead.
  if (!name || name.startsWith("-")) throw new Error(`Invalid worker name: "${raw}"`);
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
  /** Fraction of the source pane the source keeps (herdr only). */
  ratio?: number;
}

export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PaneGeometry {
  paneId: string;
  rect: PaneRect;
}

/** A worker column, top to bottom. Heights are rows for herdr, shares for it2. */
export interface ColumnPane {
  paneId: string;
  height: number;
}

/** Panes of the tab holding `--pane`, as reported by `herdr pane layout`. */
export function parseHerdrLayout(stdout: string): PaneGeometry[] {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    return [];
  }
  const panes = (payload as { result?: { layout?: { panes?: unknown } } })?.result?.layout?.panes;
  if (!Array.isArray(panes)) return [];
  const geometry: PaneGeometry[] = [];
  for (const pane of panes as Array<{ pane_id?: unknown; rect?: Partial<PaneRect> } | null>) {
    if (!pane || typeof pane !== "object") continue;
    const { pane_id: paneId, rect } = pane;
    if (typeof paneId !== "string" || !rect || typeof rect !== "object") continue;
    const { x, y, width, height } = rect;
    if ([x, y, width, height].some((v) => typeof v !== "number")) continue;
    geometry.push({ paneId, rect: { x: x!, y: y!, width: width!, height: height! } });
  }
  return geometry;
}

/**
 * The worker column as one contiguous vertical stack, or null when the panes no
 * longer look like the layout this extension builds (worker panes in different
 * columns, a gap, a pane moved or zoomed by hand, a pane this extension does not
 * own sharing the column).
 *
 * The untracked case is the subtle one. Resize amounts are fractions of the
 * split that owns a divider, which is only predictable while the column is the
 * right-leaning chain the spawn path builds. Rectangles say where panes sit on
 * screen, not how the split tree nests, so a pane we did not create could be
 * nested in a way that makes those fractions address the wrong boundary. Refuse
 * the column instead of guessing, and let the caller fall back to its own
 * tracked shares.
 */
export function columnFromLayout(
  panes: PaneGeometry[],
  trackedIds: string[],
): ColumnPane[] | null {
  const tracked = panes.filter((pane) => trackedIds.includes(pane.paneId));
  if (tracked.length === 0) return null;
  const { x, width } = tracked[0]!.rect;
  if (!tracked.every((pane) => pane.rect.x === x && pane.rect.width === width)) return null;

  const column = panes
    .filter((pane) => pane.rect.x === x && pane.rect.width === width)
    .sort((a, b) => a.rect.y - b.rect.y);
  if (column.length !== tracked.length) return null;
  for (let i = 1; i < column.length; i++) {
    const above = column[i - 1]!.rect;
    if (column[i]!.rect.y !== above.y + above.height) return null;
  }
  return column.map((pane) => ({ paneId: pane.paneId, height: pane.rect.height }));
}

/**
 * Pane to carve the next worker out of.
 *
 * "bottom" keeps the split tree a right-leaning chain, which is what makes a
 * resize amount predictable (the enclosing split of boundary i is then exactly
 * panes i..n-1); the ratio below plus the equalize pass keep the column even.
 * "tallest" is for backends that can neither size a split nor resize afterwards:
 * spreading over the roomiest pane caps the imbalance at 2:1 instead of letting
 * worker n collapse to a 1/2^n sliver.
 */
export function splitSource(
  column: ColumnPane[],
  mode: "bottom" | "tallest",
): ColumnPane | undefined {
  if (column.length === 0) return undefined;
  if (mode === "bottom") return column[column.length - 1];
  let best = column[0]!;
  for (const pane of column) if (pane.height >= best.height) best = pane;
  return best;
}

/**
 * Fraction of the source pane the source keeps, so that a batch of `remaining`
 * workers (including the one being created) ends up evenly sized.
 *
 * The new pane takes the space the workers after it still need, capped at a fair
 * share of the source so an already tight column never starves the donor: for a
 * fresh column this is exact (1/n each), and for a late arrival it takes one
 * slot's worth out of the roomiest pane.
 */
export function evenSplitRatio(opts: {
  sourceHeight: number;
  columnHeight: number;
  columnCount: number;
  remaining: number;
}): number {
  const { sourceHeight, columnHeight, columnCount } = opts;
  const remaining = Math.max(1, opts.remaining);
  if (sourceHeight <= 0 || columnHeight <= 0 || columnCount <= 0) return 0.5;
  const target = columnHeight / (columnCount + remaining);
  const newHeight = Math.min(
    remaining * target,
    (sourceHeight * remaining) / (remaining + 1),
  );
  return clamp((sourceHeight - newHeight) / sourceHeight, 0.05, 0.95);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface ResizeOp {
  paneId: string;
  direction: "up" | "down";
  /** Fraction of the enclosing split to move the boundary by. */
  amount: number;
}

/**
 * One boundary move that brings column pane `index` to its even height, or null
 * when it is already there.
 *
 * Measured herdr semantics: `pane resize --pane P --direction down` moves the
 * divider below P downwards (P grows, the panes below shrink), and `--direction
 * up` moves the divider above P upwards (P grows, the pane above shrinks). Either
 * way `amount` is a fraction of the split that owns that divider, which in a
 * chain is the pane above the divider plus everything below it, and the far side
 * is rescaled proportionally. So pane `index` is grown through itself and shrunk
 * through its lower neighbour.
 *
 * Rows are integers and a column rarely divides evenly, so each pane aims at its
 * share of the *cumulative* height rather than at total/n. That spreads the
 * leftover rows one per pane instead of dumping the whole remainder on the last
 * worker, and absorbs herdr's own rounding as the pass walks down.
 */
export function equalizeStep(column: ColumnPane[], index: number): ResizeOp | null {
  if (index < 0 || index >= column.length - 1) return null;
  const heights = column.map((pane) => pane.height);
  const total = heights.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const container = heights.slice(index).reduce((a, b) => a + b, 0);
  const above = heights.slice(0, index).reduce((a, b) => a + b, 0);
  const target = Math.round(((index + 1) * total) / column.length) - above;
  const diff = target - heights[index]!;
  if (Math.abs(diff) < 1 || container <= 0) return null;
  const amount = Number((Math.abs(diff) / container).toFixed(4));
  if (amount <= 0) return null;
  return diff > 0
    ? { paneId: column[index]!.paneId, direction: "down", amount }
    : { paneId: column[index + 1]!.paneId, direction: "up", amount };
}

/**
 * Column layout: the first worker splits the leader side by side, later workers
 * carve space out of the column. Leader | [w1 / w2 / ...].
 */
export function splitPlan(opts: {
  leader?: string;
  /** Live worker column, top to bottom; empty on the first worker. */
  column?: ColumnPane[];
  /** Workers still to create in this batch, including this one. */
  remaining?: number;
  /** Backend can size a split and resize afterwards (herdr can, it2 cannot). */
  withRatio?: boolean;
}): SplitPlan {
  const withRatio = opts.withRatio ?? true;
  const column = opts.column ?? [];
  const source = splitSource(column, withRatio ? "bottom" : "tallest");
  if (!source) {
    const plan: SplitPlan = { source: opts.leader, direction: "right", vertical: true };
    if (withRatio) plan.ratio = 0.5;
    return plan;
  }
  const plan: SplitPlan = { source: source.paneId, direction: "down", vertical: false };
  if (withRatio) {
    plan.ratio = evenSplitRatio({
      sourceHeight: source.height,
      columnHeight: column.reduce((a, pane) => a + pane.height, 0),
      columnCount: column.length,
      remaining: opts.remaining ?? 1,
    });
  }
  return plan;
}

export function herdrSplitArgs(opts: {
  plan: SplitPlan;
  cwd: string;
  env?: Record<string, string>;
}): string[] {
  const args = ["pane", "split"];
  if (opts.plan.source) args.push("--pane", opts.plan.source);
  else args.push("--current");
  args.push("--direction", opts.plan.direction);
  if (opts.plan.ratio !== undefined) args.push("--ratio", String(opts.plan.ratio));
  args.push("--no-focus", "--cwd", opts.cwd);
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    args.push("--env", `${key}=${value}`);
  }
  return args;
}

export function herdrResizeArgs(op: ResizeOp): string[] {
  return ["pane", "resize", "--pane", op.paneId, "--direction", op.direction,
    "--amount", String(op.amount)];
}

export function herdrLayoutArgs(pane?: string): string[] {
  return pane ? ["pane", "layout", "--pane", pane] : ["pane", "layout", "--current"];
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

export function herdrProcessInfoArgs(pane: string): string[] {
  return ["pane", "process-info", "--pane", pane];
}

/**
 * True when a pane sits at its interactive shell prompt, which is what
 * `herdr agent start` requires. A freshly split pane briefly runs rc-file
 * helpers (an extra `bash` in the foreground), and starting an agent then fails
 * with agent_pane_busy.
 *
 * Readiness has to be readable from the response: a payload without a shell pid
 * or without a foreground list is reported as not-ready, so the caller polls
 * again rather than starting an agent against a pane it cannot see into.
 */
export function isShellAtPrompt(processInfoStdout: string): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(processInfoStdout);
  } catch {
    return false;
  }
  const info = (payload as {
    result?: { process_info?: { shell_pid?: unknown; foreground_processes?: unknown } };
  })?.result?.process_info;
  const shellPid = info?.shell_pid;
  if (typeof shellPid !== "number") return false;
  const foreground = info?.foreground_processes;
  if (!Array.isArray(foreground)) return false;
  return (foreground as Array<{ pid?: unknown } | null>).every((proc) => proc?.pid === shellPid);
}

export function herdrCloseArgs(pane: string): string[] {
  return ["pane", "close", pane];
}

export function herdrSnapshotArgs(): string[] {
  return ["api", "snapshot"];
}

/**
 * Map pane id to herdr's own view of the agent running there (`working`,
 * `idle`, `done`, `unknown`).
 *
 * herdr tracks this per pane for its sidebar and it stayed accurate through a
 * run where the teams widget showed every worker as idle, so it is the better
 * status source whenever the herdr backend is in use. A worker deep in a long
 * thinking pause writes nothing to its transcript, and only herdr can tell
 * that apart from a worker that has finished.
 */
export function parseHerdrPaneStatuses(snapshotStdout: string): Map<string, string> {
  const statuses = new Map<string, string>();
  let payload: unknown;
  try {
    payload = JSON.parse(snapshotStdout);
  } catch {
    return statuses;
  }
  const panes = (payload as { result?: { snapshot?: { panes?: unknown } } })?.result?.snapshot?.panes;
  const list = Array.isArray(panes) ? panes : panes && typeof panes === "object" ? Object.values(panes) : [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const { pane_id: paneId, agent_status: status } = entry as { pane_id?: unknown; agent_status?: unknown };
    if (typeof paneId !== "string" || typeof status !== "string") continue;
    statuses.set(paneId, status);
  }
  return statuses;
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
 * with a plain `pane run` is safe. Timeouts, detection failures and a busy pane
 * are excluded: in all three something may already own the pane's foreground
 * (pi booting, a racing start, a leftover process), and typing a command there
 * would land in that program's input rather than at a shell prompt.
 */
export function isPreLaunchFailure(stderr: string): boolean {
  return [
    "agent_pane_not_found",
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
