import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { promisify } from "node:util";
import * as childProcess from "node:child_process";

const calls: string[][] = [];
let serial = 1;
let closeError = false;
let activeList = "custom-list";
let busyStarts = false;
let missingPane = false;
const execute = async (_file: string, args: string[]) => {
  calls.push(args);
  if (args[1] === "split") return { stdout: _file === "herdr"
    ? JSON.stringify({ result: { pane: { pane_id: `w1:p${++serial}` } } })
    : `Created new pane: ABC-${++serial}` };
  if (args[1] === "process-info") return { stdout: JSON.stringify({ result: {process_info: {shell_pid: 1, foreground_processes: [{pid:1}]}} }) };
  if (args[0] === "agent" && busyStarts) throw new Error("agent_pane_busy");
  if (args[1] === "close" && missingPane) throw Object.assign(new Error('missing'), {stderr: JSON.stringify({error:{code:'pane_not_found'}})});
  if (args[1] === "close" && closeError) throw new Error("backend unavailable");
  return { stdout: "" };
};
const execFile = Object.assign(() => {}, { [promisify.custom]: execute });
mock.module("node:child_process", { namedExports: { ...childProcess, execFile } });
let resolveError = false;
const createdTasks: any[] = [];
mock.module("../src/teams-adapter.ts", { namedExports: {
  resolveTeams: async () => {
    if (resolveError) throw new Error("bridge unavailable");
    return { teamId: "attached", taskListId: activeList, leadName: "team-lead", style: "normal",
      refresh: async () => {},
      createTask: async (input: any) => { createdTasks.push(input); return { id: "9", subject: input.subject }; },
    };
  },
} });
const { default: register } = await import("../src/index.ts");

function harness() {
  let tool: any;
  const events = new Map<string, Function[]>();
  const commands: any[] = [];
  const pi: any = {
    on(name: string, handler: Function) {
      events.set(name, [...(events.get(name) ?? []), handler]);
    },
    registerCommand(name: string, command: any) { commands.push({ name, ...command }); },
    registerTool(value: any) { tool = value; },
    getCommands() { return []; },
    events: { emit() {}, on() { return () => {}; } },
  };
  register(pi);
  return {
    async call(params: any) {
      return tool.execute("id", params, undefined, undefined, {
        cwd: "/tmp", sessionManager: { getSessionId: () => "leader-session" },
      });
    },
  };
}

process.env.PI_PANES_BACKEND = "it2";
process.env.ITERM_SESSION_ID = "leader";

test("concurrent spawns reserve a name before splitting the terminal", async () => {
  const h = harness();
  const outcomes = await Promise.allSettled([
    h.call({ action: "spawn", names: ["same"] }),
    h.call({ action: "spawn", names: ["same"] }),
  ]);
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(calls.filter((a) => a[1] === "split").length, 1);
});

test("failed close remains tracked and can be retried", async () => {
  const h = harness();
  await h.call({ action: "spawn", names: ["close-test"] });
  closeError = true;
  await assert.rejects(h.call({ action: "close", names: ["close-test"] }), /backend unavailable/);
  assert.match((await h.call({ action: "list" })).content[0].text, /close-test/);
  closeError = false;
  await h.call({ action: "close", names: ["close-test"] });
  assert.doesNotMatch((await h.call({ action: "list" })).content[0].text, /close-test/);
});

test("delegation uses active team state and creates requested tasks", async () => {
  const h = harness();
  const result = await h.call({ action: "delegate", names: ["assigned"], tasks: [{text: "Do work", assignee: "assigned"}] });
  const command = calls.filter((args) => args[1] === "run").at(-1)![2]!;
  assert.match(command, /PI_TEAMS_TEAM_ID='attached'/);
  assert.match(command, /PI_TEAMS_TASK_LIST_ID='custom-list'/);
  assert.deepEqual(createdTasks.at(-1), {subject: 'Do work', description: 'Do work', owner: 'assigned'});
  assert.match(result.content[0].text, /Created task #9/);
});

test("unavailable team integration fails before opening a pane", async () => {
  const h = harness();
  const before = calls.length;
  resolveError = true;
  try { await assert.rejects(h.call({action:'spawn', names:['no-bridge']}), /bridge unavailable/); }
  finally { resolveError = false; }
  assert.equal(calls.length, before);
});

test("existing workers from another task list cannot silently absorb delegation", async () => {
  const h = harness();
  await h.call({action:'spawn', names:['old-list']});
  activeList = 'new-list';
  const before = createdTasks.length;
  try {
    await assert.rejects(h.call({action:'delegate', names:['old-list'], tasks:[{text:'must not disappear'}]}), /task list|namespace/);
  } finally { activeList = 'custom-list'; }
  assert.equal(createdTasks.length, before);
});

test("a busy agent-start refusal never triggers raw command injection", async () => {
  const h = harness();
  process.env.PI_PANES_BACKEND = 'herdr';
  process.env.PI_PANES_EQUALIZE = '0';
  busyStarts = true;
  const before = calls.length;
  try {
    const result = await h.call({action:'spawn', names:['busy-pane']});
    assert.match(result.content[0].text, /did not confirm readiness/);
    assert.equal(calls.slice(before).filter((args) => args[1] === 'run').length, 0);
  } finally { process.env.PI_PANES_BACKEND = 'it2'; busyStarts = false; }
});

test("a confirmed absent herdr pane can be untracked", async () => {
  const h = harness();
  process.env.PI_PANES_BACKEND = 'herdr';
  process.env.PI_PANES_EQUALIZE = '0';
  await h.call({action:'spawn', names:['already-closed']});
  missingPane = true;
  try { await h.call({action:'close', names:['already-closed']}); }
  finally {missingPane=false;process.env.PI_PANES_BACKEND='it2';}
  assert.doesNotMatch((await h.call({action:'list'})).content[0].text, /already-closed/);
});

test("workers do not expose a pane tool that needs leader-only state", () => {
  process.env.PI_TEAMS_WORKER = '1';
  const tools: unknown[] = [];
  try { register({ registerTool: (tool: unknown) => tools.push(tool), registerCommand() {}, on() {} } as any); }
  finally { delete process.env.PI_TEAMS_WORKER; }
  assert.equal(tools.length, 0);
});

test("unnamed stale workers block unassigned delegation", async () => {
  const h = harness();
  await h.call({ action: 'spawn', names: ['unnamed-stale'] });
  activeList = 'different-list';
  const before = createdTasks.length;
  try {
    await assert.rejects(h.call({ action: 'delegate', tasks: [{text: 'not for the old list'}] }), /task list|namespace/);
  } finally { activeList = 'custom-list'; }
  assert.equal(createdTasks.length, before);
});

test("invalid delegation is rejected before spawning", async () => {
  const h = harness();
  const before = calls.length;
  await assert.rejects(h.call({ action: "delegate", names: ["empty"], tasks: [] }), /tasks/);
  assert.equal(calls.length, before);
});
