import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HERDR_PANE_ID_RE,
  type ColumnPane,
  columnFromLayout,
  envAssignments,
  equalizeStep,
  evenSplitRatio,
  herdrAgentStartArgs,
  herdrResizeArgs,
  herdrSplitArgs,
  isPreLaunchFailure,
  isShellAtPrompt,
  it2SplitArgs,
  leaderPane,
  paneFirstPolicy,
  parseHerdrLayout,
  parseHerdrPaneId,
  parseIt2PaneId,
  pickBackend,
  sanitizeName,
  splitPlan,
  splitSource,
  workerCommand,
} from "../src/panes-core.ts";

/**
 * Model of the two herdr geometry primitives, measured against herdr on a 67-row
 * column:
 *  - `pane split --ratio r` leaves the source with fraction r, new pane gets 1-r.
 *  - `pane resize --pane P --direction down --amount a` moves the divider below P
 *    down by `a` times the height of the split owning it (P and everything below),
 *    rounded to whole rows; `--direction up` moves the divider above P up by the
 *    same measure. The far side of the divider is rescaled proportionally.
 * The tests drive the pure planners through this model, so layout regressions fail
 * here instead of on screen.
 */
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const asColumn = (heights: number[]): ColumnPane[] =>
  heights.map((height, i) => ({ paneId: `p${i}`, height }));

function applySplit(heights: number[], index: number, ratio: number): number[] {
  const h = heights[index]!;
  const kept = Math.max(1, Math.round(h * ratio));
  const next = [...heights];
  next.splice(index, 1, kept, h - kept);
  return next;
}

function applyResize(heights: number[], index: number, direction: "up" | "down", amount: number) {
  const next = [...heights];
  const donor = direction === "down" ? index : index - 1; // pane losing rows to the move
  const container = sum(next.slice(donor));
  const grow = Math.round(amount * container) * (direction === "down" ? 1 : -1);
  const below = container - next[donor]!;
  if (below - grow < next.length - donor - 1) return next; // herdr clamps to >= 1 row
  next[donor] = next[donor]! + grow;
  const scale = (below - grow) / below;
  let left = below - grow;
  for (let j = donor + 1; j < next.length; j++) {
    const height = j === next.length - 1 ? left : Math.max(1, Math.round(next[j]! * scale));
    next[j] = height;
    left -= height;
  }
  return next;
}

/** Grow a column to `total` panes, `perCall` at a time, the way the tool does. */
function buildColumn(
  columnHeight: number,
  total: number,
  perCall: number,
  opts: { withRatio?: boolean; equalize?: boolean } = {},
): number[] {
  const withRatio = opts.withRatio ?? true;
  let heights: number[] = [];
  for (let created = 0; created < total; created++) {
    if (heights.length === 0) {
      heights = [columnHeight]; // the leader split hands the whole column to worker 1
      continue;
    }
    const remaining = perCall - (created % perCall);
    const plan = splitPlan({ leader: "L", column: asColumn(heights), remaining, withRatio });
    const index = Number(plan.source!.slice(1));
    heights = applySplit(heights, index, plan.ratio ?? 0.5);
    if (opts.equalize ?? withRatio) heights = equalize(heights);
  }
  return heights;
}

/** The equalize pass as index.ts runs it: one boundary at a time, re-measuring. */
function equalize(heights: number[]): number[] {
  let next = [...heights];
  for (let i = 0; i < heights.length - 1; i++) {
    const op = equalizeStep(asColumn(next), i);
    if (op) next = applyResize(next, Number(op.paneId.slice(1)), op.direction, op.amount);
  }
  return next;
}

const spread = (heights: number[]) => Math.max(...heights) - Math.min(...heights);

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

test("a batch of workers fills the column evenly instead of halving", () => {
  // The bug: seven workers used to get 34, 17, 8, 4, 2, 2, 2 rows of a 67-row
  // column, because each split halved the previous worker's pane.
  for (const total of [2, 3, 4, 5, 7, 8]) {
    const heights = buildColumn(67, total, total);
    assert.equal(heights.length, total);
    assert.ok(spread(heights) <= 1, `${total} workers in one call: ${heights.join(", ")}`);
  }
});

test("workers spawned one at a time end up even too", () => {
  for (const total of [2, 3, 5, 7, 8]) {
    const heights = buildColumn(67, total, 1);
    assert.equal(heights.length, total);
    assert.ok(spread(heights) <= 1, `${total} one at a time: ${heights.join(", ")}`);
  }
  // Two at a time, five times over: mixed batch sizes must not drift either.
  const mixed = buildColumn(67, 10, 2);
  assert.ok(spread(mixed) <= 1, mixed.join(", "));
});

test("without ratio or resize (it2), the column degrades to 2:1 at worst", () => {
  for (const total of [3, 5, 7]) {
    const heights = buildColumn(67, total, total, { withRatio: false, equalize: false });
    assert.equal(heights.length, total);
    // The old chain gave the last worker 67/2^(n-1) rows; the tallest-first split
    // keeps every worker within a factor of two of the fair share.
    assert.ok(
      Math.min(...heights) >= 67 / total / 2 - 1,
      `${total} it2 workers: ${heights.join(", ")}`,
    );
  }
});

test("equalize repairs a halving cascade and no-ops on an even column", () => {
  const cascade = [34, 17, 8, 8];
  assert.ok(equalizeStep(asColumn(cascade), 0));
  assert.ok(spread(equalize(cascade)) <= 1, equalize(cascade).join(", "));

  for (const even of [[17, 17, 16, 17], [67], []]) {
    for (let i = 0; i < even.length; i++) {
      assert.equal(equalizeStep(asColumn(even), i), null, `${even.join(",")} @${i}`);
    }
  }
  // A column that is off by a row is nudged back, and no further.
  assert.equal(equalizeStep(asColumn([16, 17, 17, 17]), 0)?.amount, Number((1 / 67).toFixed(4)));
  assert.equal(equalizeStep(asColumn([16, 17, 17, 17]), 0)?.paneId, "p0");
  assert.equal(spread(equalize([16, 17, 17, 17])) <= 1, true);
  assert.deepEqual(herdrResizeArgs({ paneId: "wG:pA", direction: "down", amount: 0.25 }), [
    "pane", "resize", "--pane", "wG:pA", "--direction", "down", "--amount", "0.25",
  ]);
});

test("equalize grows a pane through itself and shrinks it through its neighbour", () => {
  // "down" on P moves the divider below P; "up" on P moves the divider above P.
  // Shrinking pane i therefore has to address pane i+1, or the wrong divider moves.
  assert.deepEqual(equalizeStep(asColumn([17, 17, 33]), 0), {
    paneId: "p0",
    direction: "down",
    amount: Number((5 / 67).toFixed(4)),
  });
  assert.deepEqual(equalizeStep(asColumn([40, 14, 13]), 0), {
    paneId: "p1",
    direction: "up",
    amount: Number((18 / 67).toFixed(4)),
  });
  // The container is the split owning that divider: the pane above it and below.
  assert.equal(equalizeStep(asColumn([22, 30, 15]), 1)?.amount, Number((7 / 45).toFixed(4)));
  assert.equal(equalizeStep(asColumn([22, 30, 15]), 1)?.paneId, "p2");
  // Rows left over by an uneven division go one per pane, not all to the last.
  assert.deepEqual(equalizeStep(asColumn([10, 10, 10, 10, 10, 10, 7]), 1), {
    paneId: "p2",
    direction: "up",
    amount: Number((1 / 57).toFixed(4)),
  });
  assert.deepEqual(equalizeStep(asColumn([10, 10, 10, 10, 10, 10, 7]), 2), {
    paneId: "p3",
    direction: "up",
    amount: Number((1 / 47).toFixed(4)),
  });
});

test("the split source keeps the tree a chain, or spreads when it cannot resize", () => {
  const column = [
    { paneId: "a", height: 10 },
    { paneId: "b", height: 30 },
    { paneId: "c", height: 20 },
  ];
  assert.equal(splitSource(column, "bottom")?.paneId, "c");
  assert.equal(splitSource(column, "tallest")?.paneId, "b");
  assert.equal(splitSource([], "bottom"), undefined);
});

test("column geometry comes from the live layout, and unclean columns are skipped", () => {
  const layout = (panes: Array<[string, number, number, number, number]>) =>
    JSON.stringify({
      result: {
        layout: {
          panes: panes.map(([pane_id, x, y, width, height]) => ({
            pane_id,
            rect: { x, y, width, height },
          })),
        },
      },
    });

  // leader left, two workers stacked right: only the workers form the column.
  const clean = parseHerdrLayout(
    layout([
      ["wG:p1", 36, 1, 140, 67],
      ["wG:p2", 176, 1, 140, 34],
      ["wG:p3", 176, 35, 140, 33],
    ]),
  );
  assert.deepEqual(columnFromLayout(clean, ["wG:p2", "wG:p3"]), [
    { paneId: "wG:p2", height: 34 },
    { paneId: "wG:p3", height: 33 },
  ]);
  // An untracked pane sharing the column still counts, or the resize math lies.
  assert.equal(columnFromLayout(clean, ["wG:p2"])?.length, 2);
  // Tracked panes in different columns, or a gap in the stack: don't touch it.
  assert.equal(columnFromLayout(clean, ["wG:p1", "wG:p2"]), null);
  assert.equal(columnFromLayout(clean, ["wG:pZ"]), null);
  const gapped = parseHerdrLayout(
    layout([
      ["wG:p2", 176, 1, 140, 30],
      ["wG:p3", 176, 40, 140, 27],
    ]),
  );
  assert.equal(columnFromLayout(gapped, ["wG:p2", "wG:p3"]), null);
  assert.deepEqual(parseHerdrLayout("not json"), []);
});

test("layout: first worker splits right, later workers stack down", () => {
  assert.deepEqual(splitPlan({ leader: "wG:p2" }), {
    source: "wG:p2",
    direction: "right",
    vertical: true,
    ratio: 0.5,
  });
  assert.deepEqual(
    splitPlan({ leader: "wG:p2", column: [{ paneId: "wG:pA", height: 40 }], remaining: 1 }),
    { source: "wG:pA", direction: "down", vertical: false, ratio: 0.5 },
  );
  // it2 cannot size a split, so it gets the roomiest source and no ratio.
  assert.deepEqual(
    splitPlan({
      leader: "UUID",
      column: [{ paneId: "A", height: 30 }, { paneId: "B", height: 10 }],
      remaining: 1,
      withRatio: false,
    }),
    { source: "A", direction: "down", vertical: false },
  );

  assert.deepEqual(
    herdrSplitArgs({ plan: splitPlan({ leader: "wG:p2" }), cwd: "/tmp/x", env: { A: "1" } }),
    ["pane", "split", "--pane", "wG:p2", "--direction", "right", "--ratio", "0.5",
     "--no-focus", "--cwd", "/tmp/x", "--env", "A=1"],
  );
  // No known leader: target the calling pane explicitly rather than guessing an id.
  assert.deepEqual(herdrSplitArgs({ plan: splitPlan({}), cwd: "/tmp/x" }), [
    "pane", "split", "--current", "--direction", "right", "--ratio", "0.5",
    "--no-focus", "--cwd", "/tmp/x",
  ]);

  assert.deepEqual(it2SplitArgs(splitPlan({ leader: "UUID", withRatio: false })), [
    "session", "split", "-v", "--session", "UUID",
  ]);
  assert.deepEqual(
    it2SplitArgs(
      splitPlan({
        leader: "UUID",
        column: [{ paneId: "UUID2", height: 1 }],
        remaining: 1,
        withRatio: false,
      }),
    ),
    ["session", "split", "--session", "UUID2"],
  );
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

test("shell readiness: only a pane whose foreground is just its shell is startable", () => {
  const info = (shellPid: number, fg: number[]) =>
    JSON.stringify({
      result: {
        process_info: {
          shell_pid: shellPid,
          foreground_processes: fg.map((pid) => ({ pid, argv0: "zsh" })),
        },
      },
    });

  // At the prompt: foreground is the shell itself, or nothing.
  assert.equal(isShellAtPrompt(info(100, [100])), true);
  assert.equal(isShellAtPrompt(info(100, [])), true);
  // Freshly split pane still running rc helpers, which is what agent start rejects.
  assert.equal(isShellAtPrompt(info(100, [101, 100])), false);
  // pi already running there.
  assert.equal(isShellAtPrompt(info(100, [222])), false);
  assert.equal(isShellAtPrompt("not json"), false);
  assert.equal(isShellAtPrompt(JSON.stringify({ result: {} })), false);
});

test("worker names are sanitized", () => {
  assert.equal(sanitizeName(" Sage "), "sage");
  assert.equal(sanitizeName("A_b-1"), "a_b-1");
  assert.throws(() => sanitizeName("***"), /Invalid worker name/);
});
