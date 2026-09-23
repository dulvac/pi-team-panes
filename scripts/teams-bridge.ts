import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const START = "  // team-panes state bridge: begin\n";
const END = "  // team-panes state bridge: end\n";
const BLOCK = START + `  const stopPaneStateBridge = pi.events.on("team-panes:state-request", (request: unknown) => {
    const reply = (request as { reply?: unknown })?.reply;
    if (typeof reply !== "function" || !currentCtx || !currentTeamId) return;
    // Reply synchronously: the requester checks state immediately after emit.
    reply({
      teamId: currentTeamId,
      taskListId: taskListId ?? currentTeamId,
      leadName: teamConfig?.leadName ?? "team-lead",
      style,
      refresh: async () => { await refreshTasks(); restoreWidget(); },
    });
  });
  pi.on("session_shutdown", () => { stopPaneStateBridge(); });
` + END;

async function main() {
  const [action, root] = process.argv.slice(2);
  if (!root || !["install", "remove"].includes(action ?? "")) {
    throw new Error("Usage: node scripts/teams-bridge.ts install|remove <pi-agent-teams-package-dir>");
  }
  const dir = resolve(root);
  const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  if (manifest.name !== "@tmustier/pi-agent-teams") throw new Error("Not a pi-agent-teams package");
  const file = join(dir, "extensions/teams/leader.ts");
  const source = await readFile(file, "utf8");
  const start = source.indexOf(START);
  if (start >= 0) {
    const end = source.indexOf(END, start);
    if (end < 0 || source.slice(start, end + END.length) !== BLOCK) {
      throw new Error("Existing bridge was modified; refusing to overwrite it");
    }
    if (action === "remove") {
      await writeFile(file, source.slice(0, start) + source.slice(end + END.length));
      console.log(`Removed bridge from ${file}. Reload pi.`);
    } else console.log(`Bridge already installed in ${file}.`);
    return;
  }
  if (action === "remove") { console.log("No bridge installed."); return; }
  const anchor = /^(\s*)registerTeamsTool\(\{/m;
  if (!anchor.test(source) || ["currentCtx", "currentTeamId", "taskListId", "teamConfig", "style", "refreshTasks", "restoreWidget"].some((name) => !source.includes(name))) {
    throw new Error("Unsupported pi-agent-teams source layout; no files changed");
  }
  await writeFile(file, source.replace(anchor, (match) => BLOCK + match));
  console.log(`Installed bridge in ${file}. Reload pi. Remove with this script's remove action.`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
