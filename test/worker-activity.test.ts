import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activityPayload,
  consumeSlice,
  deriveStatus,
  emptyCounters,
  paneStatusToHint,
} from "../src/worker-activity.ts";

/**
 * Fixtures mirror a real teammate transcript (pi session JSONL, version 3):
 * one JSON object per line, `type: "message"` entries wrapping
 * `{ role, content[], usage? }`. An assistant message carries `usage.totalTokens`
 * and zero or more `toolCall` blocks; each answered call gets a following
 * `role: "toolResult"` message. Anything else on the line (session header,
 * model_change, thinking blocks) is noise the reader must skip without counting.
 */

const line = (obj: unknown) => `${JSON.stringify(obj)}\n`;

const header = () =>
  line({ type: "session", version: 3, id: "s1", timestamp: "2026-09-03T12:00:00.000Z" }) +
  line({ type: "model_change", timestamp: "2026-09-03T12:00:01.000Z", provider: "p", modelId: "m" });

const assistantToolCall = (opts: {
  at: string;
  tool: string;
  id: string;
  tokens?: number;
  thinking?: boolean;
}) =>
  line({
    type: "message",
    timestamp: opts.at,
    message: {
      role: "assistant",
      usage: opts.tokens === undefined ? undefined : { totalTokens: opts.tokens },
      content: [
        ...(opts.thinking ? [{ type: "thinking", thinking: "..." }] : []),
        { type: "toolCall", id: opts.id, name: opts.tool, arguments: {} },
      ],
    },
  });

const toolResult = (at: string) =>
  line({
    type: "message",
    timestamp: at,
    message: { role: "toolResult", content: [{ type: "text", text: "ok" }] },
  });

const assistantText = (opts: { at: string; tokens?: number }) =>
  line({
    type: "message",
    timestamp: opts.at,
    message: {
      role: "assistant",
      usage: opts.tokens === undefined ? undefined : { totalTokens: opts.tokens },
      content: [{ type: "text", text: "done" }],
    },
  });

const ts = (iso: string) => Date.parse(iso);

// ── consumeSlice ──

test("empty counters are zeroed and consume nothing", () => {
  const c = emptyCounters();
  assert.equal(c.offset, 0);
  assert.equal(c.turns, 0);
  assert.equal(c.tokens, 0);
  assert.equal(c.toolCalls, 0);
  assert.equal(c.lastToolName, null);
  assert.equal(c.pendingToolName, null);
  assert.equal(c.lastEventAt, 0);
});

test("tokens accumulate across assistant messages and ignore other roles", () => {
  const slice =
    header() +
    assistantToolCall({ at: "2026-09-03T12:00:02.000Z", tool: "read", id: "t1", tokens: 100 }) +
    toolResult("2026-09-03T12:00:03.000Z") +
    assistantText({ at: "2026-09-03T12:00:04.000Z", tokens: 250 });

  const c = consumeSlice(emptyCounters(), slice);

  assert.equal(c.tokens, 350);
});

test("tool calls are counted and the last name is kept after its result", () => {
  const slice =
    assistantToolCall({ at: "2026-09-03T12:00:02.000Z", tool: "read", id: "t1" }) +
    toolResult("2026-09-03T12:00:03.000Z") +
    assistantToolCall({ at: "2026-09-03T12:00:04.000Z", tool: "bash", id: "t2" }) +
    toolResult("2026-09-03T12:00:05.000Z");

  const c = consumeSlice(emptyCounters(), slice);

  assert.equal(c.toolCalls, 2);
  assert.equal(c.lastToolName, "bash");
  assert.equal(c.pendingToolName, null);
});

test("an unanswered tool call is reported as pending, which is how 'working' is known", () => {
  const slice =
    assistantToolCall({ at: "2026-09-03T12:00:02.000Z", tool: "read", id: "t1" }) +
    toolResult("2026-09-03T12:00:03.000Z") +
    assistantToolCall({ at: "2026-09-03T12:00:06.000Z", tool: "edit", id: "t2" });

  const c = consumeSlice(emptyCounters(), slice);

  assert.equal(c.pendingToolName, "edit");
  assert.equal(c.lastToolName, "edit");
});

test("a turn ends on an assistant message with no tool call", () => {
  const slice =
    assistantToolCall({ at: "2026-09-03T12:00:02.000Z", tool: "read", id: "t1" }) +
    toolResult("2026-09-03T12:00:03.000Z") +
    assistantText({ at: "2026-09-03T12:00:04.000Z" }) +
    assistantToolCall({ at: "2026-09-03T12:00:05.000Z", tool: "read", id: "t2" }) +
    toolResult("2026-09-03T12:00:06.000Z") +
    assistantText({ at: "2026-09-03T12:00:07.000Z" });

  const c = consumeSlice(emptyCounters(), slice);

  assert.equal(c.turns, 2);
});

test("thinking blocks never count as tool calls or turns", () => {
  const slice = assistantToolCall({
    at: "2026-09-03T12:00:02.000Z",
    tool: "read",
    id: "t1",
    thinking: true,
  });

  const c = consumeSlice(emptyCounters(), slice);

  assert.equal(c.toolCalls, 1);
  assert.equal(c.turns, 0);
});

test("lastEventAt tracks the newest entry timestamp", () => {
  const slice =
    assistantToolCall({ at: "2026-09-03T12:00:02.000Z", tool: "read", id: "t1" }) +
    toolResult("2026-09-03T12:00:09.000Z");

  const c = consumeSlice(emptyCounters(), slice);

  assert.equal(c.lastEventAt, ts("2026-09-03T12:00:09.000Z"));
});

test("offset advances by the bytes of complete lines only", () => {
  const complete = assistantToolCall({ at: "2026-09-03T12:00:02.000Z", tool: "read", id: "t1" });
  const partial = '{"type":"message","timestamp":"2026-09-03T12:00:03.0';

  const c = consumeSlice(emptyCounters(), complete + partial);

  assert.equal(c.offset, Buffer.byteLength(complete));
  assert.equal(c.toolCalls, 1);
});

test("a partial line is parsed once the rest of it arrives", () => {
  const whole = assistantToolCall({ at: "2026-09-03T12:00:02.000Z", tool: "read", id: "t1" });
  const cut = Math.floor(whole.length / 2);

  const first = consumeSlice(emptyCounters(), whole.slice(0, cut));
  assert.equal(first.offset, 0);
  assert.equal(first.toolCalls, 0);

  const second = consumeSlice(first, whole);
  assert.equal(second.offset, Buffer.byteLength(whole));
  assert.equal(second.toolCalls, 1);
});

test("counters accumulate across successive slices without recounting", () => {
  const first = assistantToolCall({ at: "2026-09-03T12:00:02.000Z", tool: "read", id: "t1", tokens: 10 });
  const rest = toolResult("2026-09-03T12:00:03.000Z") + assistantText({ at: "2026-09-03T12:00:04.000Z", tokens: 5 });

  const a = consumeSlice(emptyCounters(), first);
  const b = consumeSlice(a, rest);

  assert.equal(b.tokens, 15);
  assert.equal(b.toolCalls, 1);
  assert.equal(b.turns, 1);
  assert.equal(b.offset, Buffer.byteLength(first) + Buffer.byteLength(rest));
});

test("a malformed line is skipped without derailing the rest", () => {
  const slice =
    "{not json\n" +
    assistantToolCall({ at: "2026-09-03T12:00:02.000Z", tool: "read", id: "t1", tokens: 7 });

  const c = consumeSlice(emptyCounters(), slice);

  assert.equal(c.tokens, 7);
  assert.equal(c.toolCalls, 1);
});

test("multibyte content advances the offset by bytes, not characters", () => {
  const slice = line({
    type: "message",
    timestamp: "2026-09-03T12:00:02.000Z",
    message: { role: "assistant", usage: { totalTokens: 1 }, content: [{ type: "text", text: "héllo wörld ✨" }] },
  });

  const c = consumeSlice(emptyCounters(), slice);

  assert.equal(c.offset, Buffer.byteLength(slice));
  assert.ok(c.offset > slice.length, "byte length should exceed character length here");
});

// ── deriveStatus ──

const counters = (over: Partial<ReturnType<typeof emptyCounters>> = {}) => ({
  ...emptyCounters(),
  ...over,
});

test("an offline member is stopped whatever the transcript says", () => {
  const status = deriveStatus({
    memberOnline: false,
    paneStatus: "working",
    counters: counters({ pendingToolName: "bash", lastEventAt: 1_000 }),
    now: 1_000,
  });

  assert.equal(status, "stopped");
});

test("the pane backend's own view wins when it says working", () => {
  const status = deriveStatus({
    memberOnline: true,
    paneStatus: "working",
    counters: counters({ lastEventAt: 0 }),
    now: 10_000_000,
  });

  assert.equal(status, "streaming");
});

test("the pane backend's own view wins when it says idle", () => {
  const status = deriveStatus({
    memberOnline: true,
    paneStatus: "idle",
    counters: counters({ pendingToolName: "bash", lastEventAt: 10_000_000 }),
    now: 10_000_000,
  });

  assert.equal(status, "idle");
});

test("without a pane view, an unanswered tool call means working", () => {
  const status = deriveStatus({
    memberOnline: true,
    paneStatus: null,
    counters: counters({ pendingToolName: "bash", lastEventAt: 0 }),
    now: 10_000_000,
  });

  assert.equal(status, "streaming");
});

test("without a pane view, a recent entry means working", () => {
  const status = deriveStatus({
    memberOnline: true,
    paneStatus: null,
    counters: counters({ lastEventAt: 9_995_000 }),
    now: 10_000_000,
    recentMs: 15_000,
  });

  assert.equal(status, "streaming");
});

test("without a pane view, a stale transcript means idle", () => {
  const status = deriveStatus({
    memberOnline: true,
    paneStatus: null,
    counters: counters({ lastEventAt: 9_000_000 }),
    now: 10_000_000,
    recentMs: 15_000,
  });

  assert.equal(status, "idle");
});

test("a member with no transcript yet reads as starting, not idle", () => {
  const status = deriveStatus({
    memberOnline: true,
    paneStatus: null,
    counters: counters({ lastEventAt: 0 }),
    now: 10_000_000,
  });

  assert.equal(status, "starting");
});

test("herdr's done maps to idle, and unknown leaves the decision to the transcript", () => {
  assert.equal(paneStatusToHint("working"), "streaming");
  assert.equal(paneStatusToHint("idle"), "idle");
  assert.equal(paneStatusToHint("done"), "idle");
  assert.equal(paneStatusToHint("unknown"), null);
  assert.equal(paneStatusToHint(undefined), null);
});

// ── activityPayload ──

test("the payload matches the field names pi-agent-teams' tracker already uses", () => {
  const payload = activityPayload("impl3b", "streaming", counters({
    turns: 3,
    tokens: 1234,
    toolCalls: 42,
    lastToolName: "edit",
    pendingToolName: "bash",
    lastEventAt: 5_000,
  }));

  assert.deepEqual(payload, {
    name: "impl3b",
    source: "pane",
    status: "streaming",
    toolUseCount: 42,
    currentToolName: "bash",
    lastToolName: "edit",
    turnCount: 3,
    totalTokens: 1234,
    lastEventAt: 5_000,
  });
});

test("currentToolName is null when no call is outstanding", () => {
  const payload = activityPayload("rev1", "idle", counters({ lastToolName: "read" }));

  assert.equal(payload.currentToolName, null);
  assert.equal(payload.lastToolName, "read");
});
