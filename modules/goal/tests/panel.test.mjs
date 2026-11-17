import assert from "node:assert/strict";
import test from "node:test";
import { validatePlan } from "../src/plan.ts";
import { goalPanelJob } from "../src/panel.ts";
import { renderJobs } from "../../../shared/src/background/index.ts";
import { stripVTControlCharacters as plain } from "node:util";

const theme = { fg: (_, s) => s, bg: (_, s) => s, getBgAnsi: () => "" };
const checked = validatePlan({
  title: "Ship it", goal: "SECRET-GOAL-TEXT", references: [], rules: [], decisions: [],
  checkpoints: [
    { title: "First", dependsOn: [], todos: ["a"], verify: { tier: 1, command: "SECRET-COMMAND", expected: "ok" } },
    { title: "Second", dependsOn: [1], todos: ["b"], verify: { tier: 2, check: "look", expected: "ok" } },
  ],
});
assert.ok(checked.ok);
const plan = checked.plan;
const record = (status, entries) => ({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", status, createdAt: "2026-11-18T00:00:00.000Z", updatedAt: "2026-11-18T00:01:00.000Z", checkpoints: entries.map(([s, attempts], i) => ({ index: i + 1, status: s, attempts, log: ["SECRET-LOG"] })) });

test("running goal: progress, attempt and no plan text, command or log", () => {
  const job = goalPanelJob({ plan, record: record("running", [["done", 1], ["verifying", 2]]) });
  assert.deepEqual([job.kind, job.state, job.active, job.title, job.summary], ["goal", "running", true, "1/2", "1/2 | attempt 2/3"]);
  assert.match(job.activity, /2\/2 Second · verifying · attempt 2\/3/);
  const shown = JSON.stringify(job);
  for (const secret of ["SECRET-GOAL-TEXT", "SECRET-COMMAND", "SECRET-LOG"]) assert.ok(!shown.includes(secret));
});

test("queued and blocked stay active; finished goals do not", () => {
  assert.equal(goalPanelJob({ plan, record: record("queued", [["pending", 0], ["pending", 0]]) }).active, true);
  const blocked = goalPanelJob({ plan, record: record("blocked", [["done", 1], ["needs-human", 1]]) });
  assert.equal(blocked.active, true);
  assert.match(blocked.activity, /Needs attention · 1 checkpoint · 1\/2 done/);
  for (const status of ["done", "failed", "cancelled"]) assert.equal(goalPanelJob({ plan, record: record(status, [["done", 1], ["done", 1]]) }).active, false);
});

test("the passive panel shows a Goal count and a GL row", () => {
  const lines = renderJobs([goalPanelJob({ plan, record: record("running", [["running", 1], ["pending", 0]]) })], theme, 100).map(plain).join("\n");
  assert.match(lines, /Goal: 1/);
  assert.match(lines, /GL Ship it/);
});
