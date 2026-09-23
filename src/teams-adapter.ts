import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dirname, join, basename } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { shellQuote } from "./panes-core.ts";

export interface TeamState {
  teamId: string;
  taskListId: string;
  leadName: string;
  style: string;
  refresh: () => Promise<void>;
}

export interface TaskInput {
  subject: string;
  description: string;
  owner?: string;
}

export interface TeamsAdapter extends TeamState {
  createTask(input: TaskInput): Promise<{ id: string; subject: string }>;
}

/** The state reply comes from the running teams extension, not its stale config file. */
export async function resolveTeams(pi: ExtensionAPI, root: string): Promise<TeamsAdapter> {
  const command = pi.getCommands().find((entry) =>
    entry.source === "extension" && /^team(?::\d+)?$/.test(entry.name) &&
    basename(dirname(entry.sourceInfo.path)) === "teams",
  );
  if (!command) throw new Error("The pi-agent-teams extension must be loaded before spawning pane workers.");
  const directory = dirname(command.sourceInfo.path);
  let state: TeamState | undefined;
  // This in-process bridge replies synchronously during emit; silence fails closed.
  pi.events.emit("team-panes:state-request", { reply: (value: TeamState) => { state = value; } });
  if (!state || !state.teamId || !state.taskListId || typeof state.refresh !== "function") {
    throw new Error(
      "pi-agent-teams has no live-state bridge. Install it with " +
      `node ${shellQuote(fileURLToPath(new URL("../scripts/teams-bridge.ts", import.meta.url)))} install ${shellQuote(join(directory, "../.."))}, then /reload. ` +
      "No panes or tasks were created.",
    );
  }
  const taskFile = join(directory, "task-store.ts");
  const mailboxFile = join(directory, "mailbox.ts");
  const protocolFile = join(directory, "protocol.ts");
  for (const file of [taskFile, mailboxFile, protocolFile]) {
    if (!existsSync(file)) throw new Error(`Unsupported pi-agent-teams installation: missing ${file}`);
  }
  const [{ createTask }, { writeToMailbox }, { taskAssignmentPayload }] = await Promise.all([
    import(taskFile), import(mailboxFile), import(protocolFile),
  ]);
  if (typeof createTask !== "function" || typeof writeToMailbox !== "function" || typeof taskAssignmentPayload !== "function") {
    throw new Error("Unsupported pi-agent-teams task-store/mailbox exports");
  }
  const active = state;
  const teamDir = join(root, active.teamId);
  return {
    ...active,
    async createTask(input) {
      const task = await createTask(teamDir, active.taskListId, input);
      if (input.owner) {
        const timestamp = new Date().toISOString();
        try {
          await writeToMailbox(teamDir, active.taskListId, input.owner, {
            from: active.leadName,
            text: JSON.stringify(taskAssignmentPayload(task, active.leadName)),
            timestamp,
          });
        } catch (error) {
          throw new Error(`Task #${task.id} was created, but its assignment was not delivered. Use teams task_assign to retry: ${error}`);
        }
      }
      await active.refresh();
      return task;
    },
  };
}
