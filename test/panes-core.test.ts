import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HERDR_PANE_ID_RE,
  envAssignments,
  herdrAgentStartArgs,
  herdrSplitArgs,
  isPreLaunchFailure,
  it2SplitArgs,
  leaderPane,
  paneFirstPolicy,
  parseHerdrPaneId,
  parseIt2PaneId,
  pickBackend,
  sanitizeName,
  splitPlan,
  workerCommand,
} from "../src/panes-core.ts";

test("pane id grammar accepts base36 ids past p9", () => {
  for (const id of ["w4:p1", "wG:pA", "wH:p1B", "w10:pZZ"]) {
    assert.equal(HERDR_PANE_ID_RE.test(id), true, id);
  }
  for (const id of ["", "wG", "wG:p", "p1", "338C167B-C684-452C-A972-F50AB3F55F74"]) {
    assert.equal(HERDR_PANE_ID_RE.test(id), false, id);
  }
});

test("backend selection prefers herdr, then iTerm2", () => {
  assert.equal(pickBackend({ HERDR_ENV: "1", HERDR_PANE_ID: "wG:pA" }).kind, "herdr");
  assert.equal(pickBackend({ ITERM_SESSION_ID: "w0t0p0:UUID" }).kind, "it2");
  // Inside herdr, ITERM_SESSION_ID is inherited from the hosting terminal; herdr wins.
  assert.equal(
    pickBackend({ HERDR_ENV: "1", HERDR_PANE_ID: "wG:pA", ITERM_SESSION_ID: "w0t0p0:UUID" }).kind,
    "herdr",
  );
  assert.equal(pickBackend({}).kind, null);
});

test("PI_PANES_BACKEND overrides detection and rejects junk", () => {
  const env = { HERDR_ENV: "1", HERDR_PANE_ID: "wG:pA", ITERM_SESSION_ID: "w0t0p0:UUID" };
  assert.equal(pickBackend({ ...env, PI_PANES_BACKEND: "it2" }).kind, "it2");
  assert.equal(pickBackend({ ...env, PI_PANES_BACKEND: "auto" }).kind, "herdr");
  const bad = pickBackend({ ...env, PI_PANES_BACKEND: "tmux" });
  assert.equal(bad.kind, null);
  assert.match(bad.reason, /unknown PI_PANES_BACKEND/);
});

test("leader pane comes from the active backend's own id", () => {
  assert.equal(leaderPane("herdr", { HERDR_PANE_ID: "wG:p2" }), "wG:p2");
  assert.equal(leaderPane("it2", { ITERM_SESSION_ID: "w0t0p0:ABC-123" }), "ABC-123");
  assert.equal(leaderPane("it2", {}), undefined);
});

test("layout: first worker splits right, later workers stack down", () => {
  assert.deepEqual(splitPlan({ leader: "wG:p2" }), {
    source: "wG:p2",
    direction: "right",
    vertical: true,
  });
  assert.deepEqual(splitPlan({ leader: "wG:p2", lastMember: "wG:pA" }), {
    source: "wG:pA",
    direction: "down",
    vertical: false,
  });

  assert.deepEqual(
    herdrSplitArgs({ plan: splitPlan({ leader: "wG:p2" }), cwd: "/tmp/x", env: { A: "1" } }),
    ["pane", "split", "--pane", "wG:p2", "--direction", "right", "--no-focus",
     "--cwd", "/tmp/x", "--env", "A=1"],
  );
  // No known leader: target the calling pane explicitly rather than guessing an id.
  assert.deepEqual(herdrSplitArgs({ plan: splitPlan({}), cwd: "/tmp/x" }), [
    "pane", "split", "--current", "--direction", "right", "--no-focus", "--cwd", "/tmp/x",
  ]);

  assert.deepEqual(it2SplitArgs(splitPlan({ leader: "UUID" })), [
    "session", "split", "-v", "--session", "UUID",
  ]);
  assert.deepEqual(it2SplitArgs(splitPlan({ leader: "UUID", lastMember: "UUID2" })), [
    "session", "split", "--session", "UUID2",
  ]);
});

test("pane ids are parsed from both backends and validated", () => {
  assert.equal(parseIt2PaneId("Created new pane: ABC-123\n"), "ABC-123");
  assert.throws(() => parseIt2PaneId("nope"), /Could not parse new pane id/);

  const ok = JSON.stringify({ result: { pane: { pane_id: "wG:pA" } } });
  assert.equal(parseHerdrPaneId(ok), "wG:pA");
  assert.throws(() => parseHerdrPaneId("not json"), /Could not parse herdr JSON/);
  assert.throws(
    () => parseHerdrPaneId(JSON.stringify({ result: { pane: { pane_id: 7 } } })),
    /unexpected pane id/,
  );
});

test("worker command quotes cwd and env values", () => {
  const cmd = workerCommand({
    cwd: "/tmp/it's here",
    env: { PI_TEAMS_AGENT_NAME: "sage", PI_TEAMS_STYLE: "a b" },
  });
  assert.equal(
    cmd,
    "cd '/tmp/it'\\''s here' && PI_TEAMS_AGENT_NAME='sage' PI_TEAMS_STYLE='a b' pi",
  );
  assert.equal(envAssignments({ A: "1" }), "A='1'");
});

test("agent start args carry kind, pane and timeout", () => {
  assert.deepEqual(herdrAgentStartArgs({ name: "sage", pane: "wG:pA", timeoutMs: 90000 }), [
    "agent", "start", "sage", "--kind", "pi", "--pane", "wG:pA", "--timeout", "90000",
  ]);
});

test("only pre-launch failures may fall back to a raw pane run", () => {
  for (const stderr of [
    '{"error":{"code":"agent_pane_busy"}}',
    '{"error":{"code":"agent_pane_not_found"}}',
    '{"error":{"code":"agent_name_taken"}}',
    "unsupported interactive agent kind: pi",
  ]) {
    assert.equal(isPreLaunchFailure(stderr), true, stderr);
  }
  // A timeout means pi may already be booting in that pane: never retype into it.
  for (const stderr of [
    '{"error":{"code":"agent_launch_pending"}}',
    '{"error":{"code":"agent_not_ready"}}',
    "timed out waiting for interactive readiness",
  ]) {
    assert.equal(isPreLaunchFailure(stderr), false, stderr);
  }
});

test("policy text names the active backend", () => {
  assert.match(paneFirstPolicy("herdr"), /herdr workspace/);
  assert.match(paneFirstPolicy("it2"), /iTerm2 with the `it2` CLI/);
  for (const kind of ["herdr", "it2"] as const) {
    assert.match(paneFirstPolicy(kind), /pane_workers/);
  }
});

test("worker names are sanitized", () => {
  assert.equal(sanitizeName(" Sage "), "sage");
  assert.equal(sanitizeName("A_b-1"), "a_b-1");
  assert.throws(() => sanitizeName("***"), /Invalid worker name/);
});
