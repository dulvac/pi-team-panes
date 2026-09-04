/**
 * Activity for pane workers, read from their own transcripts.
 *
 * pi-agent-teams derives the widget's status and counters from a `TeammateRpc`
 * handle, which only exists for teammates the leader spawned itself. A pane
 * worker is an independent `pi` process that self-registers into the roster, so
 * the leader has no handle for it, `resolveDisplayStatus` falls through to a
 * hardcoded "idle", and every counter renders as zero no matter how busy the
 * worker is.
 *
 * The roster already records each member's `sessionFile`, and a pi transcript
 * holds everything the tracker consumes: assistant `usage.totalTokens`,
 * `toolCall` blocks and their `toolResult` answers, and per-entry timestamps.
 * This module turns that file into the same numbers, so the leader can publish
 * them and the existing widget can render the truth.
 *
 * Everything here is pure: the reader in index.ts owns the file handles and the
 * poll timer, which keeps this testable against fixtures instead of a live team.
 */

/** Status vocabulary pi-agent-teams already understands, minus RPC-only states. */
export type ExternalStatus = "starting" | "idle" | "streaming" | "stopped";

export interface ActivityCounters {
  /** Bytes of the transcript already folded into these counters. */
  offset: number;
  turns: number;
  tokens: number;
  toolCalls: number;
  lastToolName: string | null;
  /** A tool call with no result yet, which is the clearest "working" signal. */
  pendingToolName: string | null;
  /** Epoch ms of the newest entry seen, 0 when the transcript is still empty. */
  lastEventAt: number;
}

export interface ActivityPayload {
  name: string;
  source: "pane";
  status: ExternalStatus;
  toolUseCount: number;
  currentToolName: string | null;
  lastToolName: string | null;
  turnCount: number;
  totalTokens: number;
  lastEventAt: number;
}

/** Default window in which a fresh transcript entry still means "working". */
const RECENT_MS = 15_000;

export function emptyCounters(): ActivityCounters {
  return {
    offset: 0,
    turns: 0,
    tokens: 0,
    toolCalls: 0,
    lastToolName: null,
    pendingToolName: null,
    lastEventAt: 0,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function toolCallNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type !== "toolCall") continue;
    names.push(typeof block.name === "string" ? block.name : "?");
  }
  return names;
}

function entryTimestamp(entry: Record<string, unknown>): number {
  const raw = entry.timestamp;
  if (typeof raw !== "string") return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Fold newly appended transcript text into the counters.
 *
 * `slice` is the file's content from `prev.offset` onwards. Only whole lines are
 * consumed: a transcript is appended to while we read it, so the tail is
 * routinely half a JSON object. The returned offset advances by the *byte*
 * length of the consumed lines, because the caller seeks by bytes and a
 * transcript carries filenames and prose in any language.
 */
export function consumeSlice(prev: ActivityCounters, slice: string): ActivityCounters {
  const lastBreak = slice.lastIndexOf("\n");
  if (lastBreak < 0) return { ...prev };

  const consumed = slice.slice(0, lastBreak + 1);
  const next: ActivityCounters = { ...prev, offset: prev.offset + Buffer.byteLength(consumed) };

  for (const raw of consumed.split("\n")) {
    if (!raw.trim()) continue;

    let entry: unknown;
    try {
      entry = JSON.parse(raw);
    } catch {
      // A torn or corrupt line costs its own information, nothing more.
      continue;
    }
    if (!isRecord(entry) || entry.type !== "message") continue;

    const at = entryTimestamp(entry);
    if (at > next.lastEventAt) next.lastEventAt = at;

    const message = entry.message;
    if (!isRecord(message)) continue;

    if (message.role === "toolResult") {
      next.pendingToolName = null;
      continue;
    }

    if (message.role !== "assistant") continue;

    const usage = message.usage;
    if (isRecord(usage) && typeof usage.totalTokens === "number") {
      next.tokens += usage.totalTokens;
    }

    const names = toolCallNames(message.content);
    if (names.length === 0) {
      // An assistant message that asks for no tool is the end of a turn.
      next.turns += 1;
      continue;
    }
    next.toolCalls += names.length;
    const last = names[names.length - 1] ?? null;
    next.lastToolName = last;
    next.pendingToolName = last;
  }

  return next;
}

/**
 * Map a pane backend's own view of the agent to a status, or null when it has
 * no opinion. herdr tracks this per pane and was accurate throughout a run
 * where the teams widget was not, so it outranks anything inferred from a file.
 */
export function paneStatusToHint(paneStatus?: string | null): ExternalStatus | null {
  if (paneStatus === "working") return "streaming";
  if (paneStatus === "idle") return "idle";
  if (paneStatus === "done") return "idle";
  return null;
}

/**
 * Decide what a worker is doing.
 *
 * Order matters: the roster settles whether the worker exists at all, the pane
 * backend outranks inference, an outstanding tool call is proof of work, and
 * only then does transcript recency get a say. A worker whose transcript is
 * still empty reads as "starting" rather than "idle", because a pane takes a
 * few seconds to come up and "idle" is the lie this whole module exists to fix.
 */
export function deriveStatus(opts: {
  memberOnline: boolean;
  paneStatus?: string | null;
  counters: ActivityCounters;
  now: number;
  recentMs?: number;
}): ExternalStatus {
  const { memberOnline, paneStatus, counters, now } = opts;
  const recentMs = opts.recentMs ?? RECENT_MS;

  if (!memberOnline) return "stopped";

  const hint = paneStatusToHint(paneStatus);
  if (hint) return hint;

  if (counters.pendingToolName) return "streaming";
  if (counters.lastEventAt === 0) return "starting";
  if (now - counters.lastEventAt <= recentMs) return "streaming";
  return "idle";
}

/**
 * Shape the event pi-agent-teams consumes. Field names deliberately match its
 * `TeammateActivity` interface so the consumer is an assignment, not a
 * translation layer that can drift.
 */
export function activityPayload(
  name: string,
  status: ExternalStatus,
  counters: ActivityCounters,
): ActivityPayload {
  return {
    name,
    source: "pane",
    status,
    toolUseCount: counters.toolCalls,
    currentToolName: counters.pendingToolName,
    lastToolName: counters.lastToolName,
    turnCount: counters.turns,
    totalTokens: counters.tokens,
    lastEventAt: counters.lastEventAt,
  };
}
