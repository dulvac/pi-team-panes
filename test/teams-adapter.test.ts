import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The adapter must use loaded-extension provenance and live state, not env guesses.
test("adapter resolves a local installation and sends assigned tasks to its active namespace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panes-adapter-"));
  try {
    const teams = join(dir, "extensions/teams");
    await mkdir(teams, { recursive: true });
    await writeFile(join(teams, "index.ts"), "");
    await writeFile(join(teams, "task-store.ts"), `export async function createTask(teamDir, taskListId, input) {
      return { id: '7', ...input, teamDir, taskListId };
    }`);
    await writeFile(join(teams, "protocol.ts"), `export function taskAssignmentPayload(task, assignedBy) {
      return {type:'task_assignment',taskId:task.id,subject:task.subject,description:task.description,assignedBy,timestamp:'2026-01-01T00:00:00Z'};
    }`);
    await writeFile(join(teams, "mailbox.ts"), `export async function writeToMailbox(teamDir, namespace, owner, message) {
      globalThis.__paneMessage = { teamDir, namespace, owner, message };
    }`);
    let refreshed = false;
    const pi: any = {
      getCommands: () => [{ name: 'team', source: 'extension', sourceInfo: { path: join(teams, 'index.ts') } }],
      events: { emit: (_name: string, request: any) => request.reply({
        teamId: 'attached', taskListId: 'custom', leadName: 'team-lead', style: 'normal',
        refresh: async () => { refreshed = true; },
      }) },
    };
    const { resolveTeams } = await import('../src/teams-adapter.ts');
    const adapter = await resolveTeams(pi, dir);
    assert.equal(adapter.teamId, 'attached');
    assert.equal(adapter.taskListId, 'custom');
    await adapter.createTask({ subject: 'Work', description: 'Do work', owner: 'sage' });
    const delivered = (globalThis as any).__paneMessage;
    assert.equal(delivered.teamDir, join(dir, 'attached'));
    assert.equal(delivered.namespace, 'custom');
    assert.equal(delivered.owner, 'sage');
    assert.deepEqual(JSON.parse(delivered.message.text), {
      type: 'task_assignment', taskId: '7', subject: 'Work', description: 'Do work', assignedBy: 'team-lead', timestamp: '2026-01-01T00:00:00Z',
    });
    assert.equal(refreshed, true);
  } finally { delete (globalThis as any).__paneMessage; await rm(dir, {recursive:true, force:true}); }
});

test("missing-bridge instructions name the installer by absolute path", async () => {
  const { resolveTeams } = await import('../src/teams-adapter.ts');
  const pi = {
    getCommands: () => [{ name: 'team', source: 'extension', sourceInfo: {path: '/some/package/extensions/teams/index.ts'} }],
    events: { emit() {} },
  };
  await assert.rejects(resolveTeams(pi as any, '/tmp'), (error: Error) => {
    assert.match(error.message, /node '\/[^\n]+\/scripts\/teams-bridge\.ts' install/);
    return true;
  });
});

test("adapter fails before mutation when live state is unavailable", async () => {
  const { resolveTeams } = await import('../src/teams-adapter.ts');
  await assert.rejects(resolveTeams({ getCommands: () => [], events: { emit() {} } } as any, '/tmp'), /pi-agent-teams|bridge/);
});
