// The state of a goal driven by a fake runner, with the record saved to and read back from its folder between steps, so a restart is a
// real reload.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"

const { validatePlan } = await import("../src/plan.ts")
const { createGoal, loadGoal, saveRecord, listGoals } = await import("../src/store.ts")
const state = await import("../src/state.ts")

const cwd = mkdtempSync(join(tmpdir(), "goal-state-"))
after(() => rmSync(cwd, { recursive: true, force: true }))

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/goal-plans/${name}.json`, import.meta.url), "utf8"))
const checkpoint = (title, dependsOn, verify = {}) => ({ title, dependsOn, todos: ["do it"], verify: { tier: 1, command: "npm test", expected: "passes", ...verify } })

/** A goal of these checkpoints, created on disk. */
async function newGoal(checkpoints) {
  const checked = validatePlan({ ...fixture("flat"), checkpoints })
  assert.ok(checked.ok, checked.ok ? "" : checked.errors.join("; "))
  const { dir } = await createGoal(cwd, checked.plan)
  return dir
}

/**
 * Runs the goal the way a runner will: advance, begin, verify, finish, saving after each change. `decide(index, attempt)` says what the check
 * found; `stopAfterBegin` leaves the process "killed" right after a checkpoint began.
 */
async function drive(dir, decide, { stopAfterBegin = false } = {}) {
  let { plan, record } = await loadGoal(dir)
  for (;;) {
    const step = state.advance(plan, record)
    record = step.record
    await saveRecord(dir, plan, record)
    if (step.kind !== "run") return record
    record = state.begin(record, step.index)
    await saveRecord(dir, plan, record)
    if (stopAfterBegin) return record
    record = state.startVerifying(record, step.index)
    const attempt = record.checkpoints.find((entry) => entry.index === step.index).attempts
    record = state.finish(plan, record, step.index, decide(step.index, attempt))
    await saveRecord(dir, plan, record)
  }
}
const pass = { result: "pass", log: "ok" }
const fail = { result: "fail", log: "2 errors" }
const statuses = (record) => record.checkpoints.map((entry) => entry.status)

describe("running a goal", () => {
  it("goes through the checkpoints in order and ends done, with the log and the view written", async () => {
    const dir = await newGoal([checkpoint("one", []), checkpoint("two", [1])])
    const order = []
    const record = await drive(dir, (index) => (order.push(index), pass))
    assert.deepEqual(order, [1, 2])
    assert.equal(record.status, "done")
    assert.deepEqual(record.checkpoints.map((entry) => entry.attempts), [1, 1])
    const view = readFileSync(join(dir, "plan.md"), "utf8")
    assert.match(view, /- \[x\] 1\. one/)
    assert.match(view, /attempt 1: passed/)
    assert.equal((await loadGoal(dir)).record.status, "done")
  })

  it("tries again while attempts are left, and keeps every failure in the log", async () => {
    const dir = await newGoal([checkpoint("one", [], { maxAttempts: 3 })])
    const record = await drive(dir, (_index, attempt) => (attempt < 3 ? fail : pass))
    assert.equal(record.status, "done")
    assert.equal(record.checkpoints[0].attempts, 3)
    assert.deepEqual(record.checkpoints[0].log.map((entry) => entry.split("\n")[0]), ["attempt 1: failed", "attempt 2: failed", "attempt 3: passed"])
  })

  it("fails a checkpoint at its limit, skips what depends on it, still does the rest, and ends blocked", async () => {
    const dir = await newGoal([checkpoint("one", [], { maxAttempts: 2 }), checkpoint("two", [1]), checkpoint("three", []), checkpoint("four", [2])])
    const record = await drive(dir, (index) => (index === 1 ? fail : pass))
    assert.deepEqual(statuses(record), ["failed", "skipped", "done", "skipped"])
    assert.equal(record.checkpoints[0].attempts, 2)
    assert.equal(record.status, "blocked")
  })

  it("leaves a Tier 2 checkpoint to a person: what depends on it waits, the rest goes on, and a pass lets it continue", async () => {
    const dir = await newGoal([checkpoint("one", [], { tier: 2, command: undefined, check: "open the app" }), checkpoint("two", [1]), checkpoint("three", [])])
    let record = await drive(dir, (index) => (index === 1 ? { result: "human", log: "open the app and look" } : pass))
    assert.deepEqual(statuses(record), ["needs-human", "pending", "done"])
    assert.equal(record.status, "blocked")
    const { plan } = await loadGoal(dir)
    record = state.resolveHuman(record, 1, true, "looks right")
    assert.equal(record.status, "queued")
    await saveRecord(dir, plan, record)
    record = await drive(dir, () => pass)
    assert.deepEqual(statuses(record), ["done", "done", "done"])
    assert.equal(record.status, "done")
  })

  it("ends blocked when a person says the Tier 2 check failed", async () => {
    const dir = await newGoal([checkpoint("one", [], { tier: 2, command: undefined, check: "open it" }), checkpoint("two", [1])])
    let record = await drive(dir, () => ({ result: "human", log: "look" }))
    record = state.resolveHuman(record, 1, false, "the button is missing")
    const { plan } = await loadGoal(dir)
    record = state.advance(plan, record).record
    assert.deepEqual(statuses(record), ["failed", "skipped"])
    assert.equal(record.status, "blocked")
  })
})

describe("a restart", () => {
  it("counts the checkpoint that was running as an attempt and continues from the files", async () => {
    const dir = await newGoal([checkpoint("one", []), checkpoint("two", [1])])
    const killed = await drive(dir, () => pass, { stopAfterBegin: true })
    assert.deepEqual([killed.status, killed.checkpoints[0].status, killed.checkpoints[0].attempts], ["running", "running", 1])

    // a new process: read the folder, recover, run on
    const { plan, record } = await loadGoal(dir)
    const recovered = state.recover(plan, record)
    assert.deepEqual([recovered.status, recovered.checkpoints[0].status, recovered.checkpoints[0].attempts], ["queued", "pending", 1])
    assert.match(recovered.checkpoints[0].log[0], /attempt 1: interrupted/)
    await saveRecord(dir, plan, recovered)
    const done = await drive(dir, () => pass)
    assert.equal(done.status, "done")
    assert.equal(done.checkpoints[0].attempts, 2)
  })

  it("fails a checkpoint whose last attempt was the one interrupted", async () => {
    const dir = await newGoal([checkpoint("one", [], { maxAttempts: 1 }), checkpoint("two", [1])])
    await drive(dir, () => pass, { stopAfterBegin: true })
    const { plan, record } = await loadGoal(dir)
    const settled = state.advance(plan, state.recover(plan, record)).record
    assert.deepEqual(statuses(settled), ["failed", "skipped"])
    assert.equal(settled.status, "blocked")
  })

  it("leaves a goal that is not running as it is", async () => {
    const dir = await newGoal([checkpoint("one", [])])
    const { plan, record } = await loadGoal(dir)
    assert.equal(state.recover(plan, record), record)
    const goals = await listGoals(cwd)
    assert.ok(goals.some((goal) => goal.dir === dir))
  })
})

describe("the user's actions", () => {
  it("cancel keeps what was done, puts the checkpoint in progress back, and stops the run", async () => {
    const dir = await newGoal([checkpoint("one", []), checkpoint("two", [1])])
    let { plan, record } = await loadGoal(dir)
    record = state.begin(state.advance(plan, record).record, 1)
    record = state.finish(plan, state.startVerifying(record, 1), 1, pass)
    record = state.begin(state.advance(plan, record).record, 2)
    record = state.cancel(record)
    assert.equal(record.status, "cancelled")
    assert.deepEqual(statuses(record), ["done", "pending"])
    assert.equal(state.advance(plan, record).kind, "settled")
    assert.equal(state.cancel(record), record)
  })

  it("retry gives a failed checkpoint, and what was skipped because of it, their attempts back", async () => {
    const dir = await newGoal([checkpoint("one", [], { maxAttempts: 1 }), checkpoint("two", [1]), checkpoint("three", [])])
    let record = await drive(dir, (index) => (index === 1 ? fail : pass))
    assert.equal(record.status, "blocked")
    const { plan } = await loadGoal(dir)
    record = state.retry(plan, record, 1)
    assert.equal(record.status, "queued")
    assert.deepEqual(statuses(record), ["pending", "pending", "done"])
    assert.deepEqual(record.checkpoints.map((entry) => entry.attempts), [0, 0, 1])
    await saveRecord(dir, plan, record)
    record = await drive(dir, () => pass)
    assert.deepEqual([record.status, ...statuses(record)], ["done", "done", "done", "done"])
  })

  it("refuses an action that does not fit the state", async () => {
    const dir = await newGoal([checkpoint("one", []), checkpoint("two", [1])])
    const { plan, record } = await loadGoal(dir)
    assert.throws(() => state.retry(plan, record, 1), /only a blocked goal/)
    assert.throws(() => state.startVerifying(record, 1), /not running/)
    assert.throws(() => state.begin(state.begin(record, 1), 1), /not pending/)
    assert.throws(() => state.resolveHuman(record, 1, true, ""), /not needs-human/)
    assert.throws(() => state.begin(record, 9), /no checkpoint 9/)
  })
})
