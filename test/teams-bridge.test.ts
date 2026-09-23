import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("bridge installs once, returns live state, and removes without discarding other edits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panes-bridge-"));
  try {
    const leader = join(dir, "extensions/teams/leader.ts");
    await mkdir(join(dir, "extensions/teams"), { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@tmustier/pi-agent-teams", type: "module" }));
    const original = `export function runLeader(pi: any) {
 const currentCtx = {};
 let currentTeamId = 'attached-team';
 let taskListId = 'custom-list';
 let style = 'normal';
 const teamConfig = { leadName: 'captain' };
 const refreshTasks = async () => {};
 const renderWidget = () => {};
 const restoreWidget = () => {};
 const bridgeTest = () => { taskListId = 'changed-list'; };
 registerTeamsTool({ pi });
 return bridgeTest;
}
function registerTeamsTool(_: any) {}
`;
    await writeFile(leader, original);
    const run = (action: string) => spawnSync(process.execPath, ["scripts/teams-bridge.ts", action, dir], { encoding: "utf8" });
    let result = run("install");
    assert.equal(result.status, 0, result.stderr);
    const once = await readFile(leader, "utf8");
    result = run("install");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(leader, "utf8"), once);
    const handlers = new Map<string, Function>();
    const { runLeader } = await import(leader);
    const change = runLeader({ events: { on: (name: string, handler: Function) => { handlers.set(name, handler); return () => {}; } }, on() {} });
    let value: any;
    handlers.get("team-panes:state-request")!({ reply: (state: any) => { value = state; } });
    assert.equal(value.teamId, "attached-team");
    assert.equal(value.taskListId, "custom-list");
    assert.equal(value.leadName, "captain");
    change();
    handlers.get("team-panes:state-request")!({ reply: (state: any) => { value = state; } });
    assert.equal(value.taskListId, "changed-list");
    await writeFile(leader, once + "// unrelated edit\n");
    result = run("remove");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(leader, "utf8"), original + "// unrelated edit\n");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
