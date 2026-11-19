import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters as plain } from "node:util";
import { validatePlan } from "../src/plan.ts";
import { describe as describeResult, GoalsBody, performAction, retryTarget } from "../src/manage.ts";

const style = { fg: (_, s) => s };
const checked = validatePlan({
  title: "Ship it", goal: "goal", references: [], rules: [], decisions: [],
  checkpoints: [
    { title: "First", dependsOn: [], todos: ["a"], verify: { tier: 1, command: "true", expected: "ok" } },
    { title: "Second", dependsOn: [1], todos: ["b"], verify: { tier: 1, command: "true", expected: "ok" } },
  ],
});
assert.ok(checked.ok);
const plan = checked.plan;
const row = (id, status, entries) => ({ plan, record: { id, status, createdAt: "2026-11-18T00:00:00.000Z", updatedAt: "2026-11-18T00:00:00.000Z", checkpoints: entries.map(([s, attempts], i) => ({ index: i + 1, status: s, attempts, log: [] })) } });
const A = "01ARZ3NDEKTSV4RRFFQ69G5FAV", B = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

function body(rows, focus) {
  const actions = [];
  const view = new GoalsBody(() => rows, style, () => 40, (action) => actions.push(action), focus);
  return { view, actions, text: () => plain(view.render(100).join("\n")) };
}

test("the list shows each goal and the keys", () => {
  const { text } = body([row(A, "running", [["running", 1], ["pending", 0]])]);
  assert.match(text(), /running\s+Ship it · 0\/2/);
  assert.match(text(), /p pause {2}r resume {2}t retry {2}x cancel/);
});

test("p, r, x and t pick the action for the selected goal; arrows move the selection; Esc closes", () => {
  const { view, actions } = body([row(A, "running", [["running", 1], ["pending", 0]]), row(B, "paused", [["pending", 0], ["pending", 0]])]);
  view.handleInput("p");
  view.handleInput("\x1b[B");
  view.handleInput("r");
  view.handleInput("x");
  view.handleInput("t");
  view.handleInput("\x1b");
  assert.deepEqual(actions, [{ type: "pause", goalId: A }, { type: "resume", goalId: B }, { type: "cancel", goalId: B }, { type: "retry", goalId: B }, null]);
});

test("Enter opens the details of the selected goal and Esc goes back to the list", () => {
  const { view, actions, text } = body([row(A, "paused", [["done", 1], ["pending", 0]])]);
  view.handleInput("\r");
  assert.match(text(), /Goal ID: 01ARZ3NDEKTSV4RRFFQ69G5FAV/);
  view.handleInput("\x1b");
  assert.deepEqual(actions, []);
  assert.match(text(), /Ship it/);
});

test("an empty list says how to start a goal, and keys do nothing but Esc", () => {
  const { view, actions, text } = body([]);
  assert.match(text(), /No goals yet/);
  view.handleInput("p");
  assert.deepEqual(actions, []);
});

test("retry targets the first failed or skipped checkpoint", () => {
  assert.equal(retryTarget(row(A, "blocked", [["done", 1], ["failed", 3]])), 2);
  assert.equal(retryTarget(row(A, "blocked", [["failed", 3], ["skipped", 0]])), 1);
  assert.equal(retryTarget(row(A, "running", [["running", 1], ["pending", 0]])), undefined);
});

test("actions go through the goal_* tools and report their first line", async () => {
  const calls = [];
  const deps = { rows: () => [row(A, "blocked", [["failed", 3], ["skipped", 0]])], call: async (tool, params) => (calls.push([tool, params]), `{"status":"paused","note":"kept"}`) };
  assert.equal(await performAction({ type: "pause", goalId: A }, deps, {}), "Ship it: paused. kept");
  await performAction({ type: "resume", goalId: A }, deps, {});
  await performAction({ type: "retry", goalId: A }, deps, {});
  assert.deepEqual(calls, [["goal_pause", { goalId: A }], ["goal_resume", { goalId: A }], ["goal_retry", { goalId: A, index: 1 }]]);
  const none = { rows: () => [row(A, "running", [["running", 1], ["pending", 0]])], call: async () => { throw new Error("must not be called"); } };
  assert.match(await performAction({ type: "retry", goalId: A }, none, {}), /nothing to retry/);
});

test("a tool result is shown as its status and note, or its first line when it is not JSON", () => {
  assert.equal(describeResult('{"goalId":"G","status":"queued"}'), "queued");
  assert.equal(describeResult('{"status":"paused","note":"files stay"}'), "paused. files stay");
  assert.equal(describeResult("plain\nsecond"), "plain");
});
