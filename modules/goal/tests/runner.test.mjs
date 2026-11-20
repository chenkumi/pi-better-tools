// GoalRunner against a fake GoalHost: the loop of implement, check and save, with the files read back after every run.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"

const { validatePlan } = await import("../src/plan.ts")
const { createGoal, loadGoal, saveRecord } = await import("../src/store.ts")
const { parseVerdict } = await import("../src/review.ts")
const { GoalRunner, taskPrompt } = await import("../src/runner.ts")
const state = await import("../src/state.ts")

const cwd = mkdtempSync(join(tmpdir(), "goal-runner-"))
after(() => rmSync(cwd, { recursive: true, force: true }))

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/goal-plans/${name}.json`, import.meta.url), "utf8"))
const checkpoint = (title, dependsOn, verify = {}) => ({ title, dependsOn, todos: [`do ${title}`], verify: { tier: 1, command: `check ${title}`, expected: "passes", ...verify } })

async function newGoal(checkpoints, extra = {}) {
  const checked = validatePlan({ ...fixture("multi"), ...extra, checkpoints })
  assert.ok(checked.ok, checked.ok ? "" : checked.errors.join("; "))
  return (await createGoal(cwd, checked.plan)).dir
}

/** A host that records what it was asked and answers with what the test says. */
function fakeHost({ trusted = true, implement = () => ({ ok: true, summary: "changed things" }), review = () => ({ ok: true, summary: "Looks right.\nVERDICT: PASS" }), check = () => ({ exitCode: 0, output: "ok" }) } = {}) {
  const calls = { implement: [], review: [], check: [] }
  return {
    calls,
    trusted: async () => trusted,
    implement: async (task, signal) => (calls.implement.push(task), implement(task, signal)),
    review: async (task, signal) => (calls.review.push(task), review(task, signal)),
    check: async (command, signal) => (calls.check.push(command), check(command, signal)),
  }
}
const statuses = (record) => record.checkpoints.map((entry) => entry.status)

describe("GoalRunner", () => {
  it("implements and checks each checkpoint in order and ends done, telling the session what it needs", async () => {
    const dir = await newGoal([checkpoint("one", []), checkpoint("two", [1])])
    const host = fakeHost()
    const changes = []
    const record = await new GoalRunner(host, (_dir, next) => changes.push(next.status)).start(dir)
    assert.equal(record.status, "done")
    assert.deepEqual(host.calls.implement.map((task) => [task.index, task.attempt]), [[1, 1], [2, 1]])
    assert.deepEqual(host.calls.check, ["check one", "check two"])
    assert.ok(changes.includes("running") && changes.at(-1) === "done")
    const prompt = host.calls.implement[1].prompt
    for (const part of ["Goal: Add tested word transformations", "add no dependency", "What is a word? → A nonempty sequence", "Already done", "1. one", "Your checkpoint: 2. two", "`check two`", "Do not submit plans"]) assert.ok(prompt.includes(part), part)
    assert.equal((await loadGoal(dir)).record.status, "done")
    assert.match(readFileSync(join(dir, "plan.md"), "utf8"), /- \[x\] 2\. two/)
  })

  it("retries a failed check with what went wrong in the prompt, and gives up at the limit", async () => {
    const dir = await newGoal([checkpoint("one", [], { maxAttempts: 2 }), checkpoint("two", [1])])
    const host = fakeHost({ check: () => ({ exitCode: 1, output: "2 tests failed" }) })
    const record = await new GoalRunner(host).start(dir)
    assert.deepEqual([record.status, ...statuses(record)], ["blocked", "failed", "skipped"])
    assert.equal(host.calls.implement.length, 2)
    assert.ok(!host.calls.implement[0].prompt.includes("Earlier attempts"))
    assert.match(host.calls.implement[1].prompt, /Earlier attempts[\s\S]*attempt 1: failed[\s\S]*2 tests failed/)
    assert.match(record.checkpoints[0].log[0], /\$ check one\nexit code 1\n2 tests failed/)
  })

  it("counts an implementation that did not complete or threw as a failed attempt, without running the check", async () => {
    const dir = await newGoal([checkpoint("one", [], { maxAttempts: 2 })])
    let calls = 0
    const host = fakeHost({ implement: () => { if (++calls === 1) throw new Error("no API key"); return { ok: false, summary: "stopped" } } })
    const record = await new GoalRunner(host).start(dir)
    assert.equal(record.checkpoints[0].status, "failed")
    assert.equal(host.calls.check.length, 0)
    assert.match(record.checkpoints[0].log.join("\n"), /implementation failed: no API key[\s\S]*did not complete\.\nstopped/)
  })

  it("leaves Tier 2 to a person and goes on with the rest", async () => {
    const dir = await newGoal([
      checkpoint("ui", [], { tier: 2, command: undefined, check: "open the app" }),
      checkpoint("after ui", [1]),
      checkpoint("review", [], { tier: 3, command: undefined, check: "read it", note: "not run" }),
      checkpoint("free", []),
    ])
    const host = fakeHost()
    const record = await new GoalRunner(host).start(dir)
    assert.deepEqual([record.status, ...statuses(record)], ["blocked", "needs-human", "pending", "done", "done"])
    assert.deepEqual(host.calls.check, ["check free"])
    assert.match(record.checkpoints[0].log[0], /To check: open the app/)
  })

  it("passes a Tier 3 checkpoint on a review verdict and records it as reviewed, not run", async () => {
    const dir = await newGoal([checkpoint("docs", [], { tier: 3, command: undefined, check: "read the README", note: "not run" })])
    const host = fakeHost({ review: () => ({ ok: true, summary: "The README covers all three commands.\nVERDICT: PASS" }) })
    const record = await new GoalRunner(host).start(dir)
    assert.deepEqual([record.status, ...statuses(record)], ["done", "done"])
    assert.deepEqual(host.calls.check, [])
    assert.equal(host.calls.review.length, 1)
    for (const part of ["Review scope: read the README", "It passes when: passes", "Not verified by running anything", "VERDICT: PASS"]) assert.ok(host.calls.review[0].prompt.includes(part), part)
    assert.match(record.checkpoints[0].log[0], /Reviewed, not run: PASS\nScope: read the README\nExpected: passes\nNot verified: not run\nThe README covers/)
  })

  it("counts a failed review as a failed attempt and tells the next attempt what the reviewer found", async () => {
    const dir = await newGoal([checkpoint("docs", [], { tier: 3, command: undefined, check: "read the README", note: "not run", maxAttempts: 2 })])
    let reviews = 0
    const host = fakeHost({ review: () => ({ ok: true, summary: ++reviews === 1 ? "README.md line 4 names a command that does not exist.\nVERDICT: FAIL" : "Fixed.\nVERDICT: PASS" }) })
    const record = await new GoalRunner(host).start(dir)
    assert.deepEqual([record.status, record.checkpoints[0].attempts], ["done", 2])
    assert.match(host.calls.implement[1].prompt, /Earlier attempts[\s\S]*attempt 1: failed[\s\S]*Reviewed, not run: FAIL[\s\S]*line 4 names a command/)
  })

  it("leaves a review that gave no verdict, or could not run, to a person", async () => {
    for (const review of [() => ({ ok: true, summary: "I think it is fine." }), () => ({ ok: false, summary: "stopped" }), () => { throw new Error("no key") }]) {
      const dir = await newGoal([checkpoint("docs", [], { tier: 3, command: undefined, check: "read it", note: "not run" })])
      const record = await new GoalRunner(fakeHost({ review })).start(dir)
      assert.deepEqual([record.status, ...statuses(record)], ["blocked", "needs-human"])
      assert.match(record.checkpoints[0].log[0], /a person has to look/)
    }
  })

  it("refuses to start in a project that is not trusted, and runs nothing", async () => {
    const dir = await newGoal([checkpoint("one", [])])
    const host = fakeHost({ trusted: false })
    await assert.rejects(new GoalRunner(host).start(dir), /not trusted/)
    assert.equal(host.calls.implement.length, 0)
    assert.equal((await loadGoal(dir)).record.status, "queued")
  })

  it("continues a goal after a restart from its files", async () => {
    const dir = await newGoal([checkpoint("one", []), checkpoint("two", [1])])
    // the process died while checkpoint 1 was being implemented
    const { plan, record } = await loadGoal(dir)
    await saveRecord(dir, plan, state.begin(state.advance(plan, record).record, 1))
    const host = fakeHost()
    const done = await new GoalRunner(host).start(dir)
    assert.equal(done.status, "done")
    assert.deepEqual(done.checkpoints.map((entry) => entry.attempts), [2, 1])
    assert.match(done.checkpoints[0].log.join("\n"), /attempt 1: interrupted/)
    assert.match(host.calls.implement[0].prompt, /Earlier attempts[\s\S]*interrupted/)
  })

  it("cancels: the session in progress is stopped, what was done stays done, nothing else runs", async () => {
    const dir = await newGoal([checkpoint("one", []), checkpoint("two", [1])])
    let started
    const hasStarted = new Promise((resolve) => (started = resolve))
    const host = fakeHost({
      implement: (task, signal) => {
        if (task.index === 1) return { ok: true, summary: "done" }
        started()
        return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, summary: "aborted" })))
      },
    })
    const runner = new GoalRunner(host)
    const running = runner.start(dir)
    await hasStarted
    assert.equal(runner.isRunning(dir), true)
    const cancelled = await runner.cancel(dir)
    assert.equal(cancelled.status, "cancelled")
    assert.deepEqual(statuses(cancelled), ["done", "pending"])
    assert.deepEqual((await running).status, "cancelled")
    assert.equal(runner.isRunning(dir), false)
    assert.deepEqual(host.calls.check, ["check one"])
    assert.equal((await loadGoal(dir)).record.status, "cancelled")
  })

  it("pauses at once: the work in progress is stopped, the attempt does not count, and resume continues with a note about the unfinished work", async () => {
    const dir = await newGoal([checkpoint("one", [], { maxAttempts: 1 }), checkpoint("two", [1])])
    let started
    const hasStarted = new Promise((resolve) => (started = resolve))
    let first = true
    const host = fakeHost({ implement: (_task, signal) => { if (!first) return { ok: true, summary: "finished" }; first = false; started(); return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, summary: "stopped" }))) } })
    const runner = new GoalRunner(host)
    const running = runner.start(dir)
    await hasStarted
    const paused = await runner.pause(dir)
    assert.equal(paused.status, "paused")
    assert.deepEqual(statuses(paused), ["pending", "pending"])
    assert.equal(paused.checkpoints[0].attempts, 0, "a pause is not an attempt, so maxAttempts 1 is not used up")
    assert.match(paused.checkpoints[0].log.at(-1), /paused by the user/)
    assert.equal((await running).status, "paused")
    assert.equal(runner.isRunning(dir), false)
    assert.deepEqual(host.calls.check, [])
    assert.equal((await loadGoal(dir)).record.status, "paused")
    assert.equal((await new GoalRunner(fakeHost()).start(dir)).status, "paused", "a start does not wake a paused goal")
    assert.equal((await runner.resume(dir)).status, "queued")
    const record = await runner.start(dir)
    assert.equal(record.status, "done")
    assert.match(host.calls.implement[1].prompt, /paused by the user part-way/)
    assert.doesNotMatch(host.calls.implement[2].prompt, /paused by the user part-way/)
  })

  it("pausing while a check runs stops the check and redoes the checkpoint on resume", async () => {
    const dir = await newGoal([checkpoint("one", [])])
    let started
    const hasStarted = new Promise((resolve) => (started = resolve))
    let checks = 0
    const host = fakeHost({ check: (_command, signal) => { if (checks++ > 0) return { exitCode: 0, output: "ok" }; started(); return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ exitCode: null, output: "" }))) } })
    const runner = new GoalRunner(host)
    const running = runner.start(dir)
    await hasStarted
    assert.equal((await runner.pause(dir)).status, "paused")
    assert.equal((await running).status, "paused")
    await runner.resume(dir)
    assert.equal((await runner.start(dir)).status, "done")
    assert.equal(host.calls.implement.length, 2)
  })

  it("pausing a goal that is not running changes its record, twice changes nothing, and a cancel still works", async () => {
    const dir = await newGoal([checkpoint("one", [])])
    const runner = new GoalRunner(fakeHost())
    assert.equal((await runner.pause(dir)).status, "paused")
    assert.equal((await runner.pause(dir)).status, "paused")
    await assert.rejects(runner.retry(dir, 1), /only a blocked goal/)
    assert.equal((await runner.cancel(dir)).status, "cancelled")
    await assert.rejects(runner.pause(dir), /only a queued or running goal/)
    await assert.rejects(runner.resume(dir), /only a paused goal/)
  })

  it("a cancel that follows a pause is still a cancel", async () => {
    const dir = await newGoal([checkpoint("one", [])])
    let started
    const hasStarted = new Promise((resolve) => (started = resolve))
    const host = fakeHost({ implement: (_task, signal) => (started(), new Promise((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, summary: "stopped" })))) })
    const runner = new GoalRunner(host)
    const running = runner.start(dir)
    await hasStarted
    void runner.pause(dir)
    assert.equal((await runner.cancel(dir)).status, "cancelled")
    assert.equal((await running).status, "cancelled")
  })

  it("cancels a goal that is not running by changing its record", async () => {
    const dir = await newGoal([checkpoint("one", [])])
    const runner = new GoalRunner(fakeHost())
    assert.equal((await runner.cancel(dir)).status, "cancelled")
    assert.equal((await loadGoal(dir)).record.status, "cancelled")
  })

  it("leaves a goal as it is when the host stops, and the next host continues it without counting a failure", async () => {
    const dir = await newGoal([checkpoint("one", []), checkpoint("two", [1])])
    let started
    const hasStarted = new Promise((resolve) => (started = resolve))
    const first = fakeHost({ implement: (_task, signal) => (started(), new Promise((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, summary: "stopped with the host" })))) })
    const runner = new GoalRunner(first)
    const running = runner.start(dir)
    await hasStarted
    await runner.stopAll()
    const left = await running
    assert.deepEqual([left.status, ...statuses(left)], ["running", "running", "pending"])
    assert.equal(first.calls.check.length, 0)
    assert.deepEqual((await loadGoal(dir)).record.checkpoints[0].log, [])

    const second = fakeHost()
    const done = await new GoalRunner(second).start(dir)
    assert.equal(done.status, "done")
    assert.deepEqual(done.checkpoints.map((entry) => entry.attempts), [2, 1])
    assert.ok(!done.checkpoints[0].log.join("\n").includes("did not complete"))
  })

  it("retries a failed checkpoint of a blocked goal, and the goal runs again when started", async () => {
    const dir = await newGoal([checkpoint("one", [], { maxAttempts: 1 })])
    let healthy = false
    const host = fakeHost({ check: () => ({ exitCode: healthy ? 0 : 1, output: "x" }) })
    const runner = new GoalRunner(host)
    assert.equal((await runner.start(dir)).status, "blocked")
    healthy = true
    assert.equal((await runner.retry(dir, 1)).status, "queued")
    await runner.start(dir)
    const { record } = await loadGoal(dir)
    assert.deepEqual([record.status, record.checkpoints[0].attempts], ["done", 1])
  })

  it("lets a person settle a Tier 2 checkpoint, and the goal goes on when started", async () => {
    const dir = await newGoal([checkpoint("ui", [], { tier: 2, command: undefined, check: "look" }), checkpoint("after", [1])])
    const host = fakeHost()
    const runner = new GoalRunner(host)
    assert.equal((await runner.start(dir)).status, "blocked")
    assert.equal((await runner.resolve(dir, 1, true, "looks fine")).status, "queued")
    await runner.start(dir)
    const { record } = await loadGoal(dir)
    assert.deepEqual([record.status, ...statuses(record)], ["done", "done", "done"])
    assert.match(record.checkpoints[0].log.join("\n"), /checked by a person: passed\nlooks fine/)
  })

  it("does not run a goal twice at once", async () => {
    const dir = await newGoal([checkpoint("one", [])])
    let release
    const host = fakeHost({ implement: () => new Promise((resolve) => (release = () => resolve({ ok: true, summary: "x" }))) })
    const runner = new GoalRunner(host)
    const first = runner.start(dir)
    while (!release) await new Promise((resolve) => setTimeout(resolve, 5))
    const second = runner.start(dir)
    release()
    assert.equal((await first).status, "done")
    assert.equal((await second).status, "done")
    assert.equal(host.calls.implement.length, 1)
  })
})

describe("parseVerdict", () => {
  it("reads the verdict from the last line, whatever dresses it, and takes the text before it as the reasons", () => {
    assert.deepEqual(parseVerdict("All good.\nVERDICT: PASS"), { verdict: "pass", reasons: "All good." })
    assert.deepEqual(parseVerdict("Line 3 is wrong.\n\n**Verdict: FAIL**\n"), { verdict: "fail", reasons: "Line 3 is wrong." })
    assert.equal(parseVerdict("`VERDICT: PASS`.")?.verdict, "pass")
  })

  it("does not take a verdict that is not the last line, or no verdict at all", () => {
    assert.equal(parseVerdict("VERDICT: PASS\nbut wait, one more thing"), undefined)
    assert.equal(parseVerdict("It passes, I think."), undefined)
    assert.equal(parseVerdict("VERDICT: MAYBE"), undefined)
    assert.equal(parseVerdict(""), undefined)
  })
})

describe("taskPrompt", () => {
  it("omits the parts a plan does not have", async () => {
    const dir = await newGoal([checkpoint("one", [])], { rules: [], decisions: [], references: [] })
    const { plan, record } = await loadGoal(dir)
    const prompt = taskPrompt(plan, record, plan.checkpoints[0])
    for (const part of ["Rules", "Decisions already made", "References", "Already done", "Earlier attempts"]) assert.ok(!prompt.includes(part), part)
  })
  it("a review stopped by the user is not handed to a person, and the goal is cancelled", async () => {
    const dir = await newGoal([checkpoint("one", [], { tier: 3, command: undefined, check: "read it", note: "not run" })])
    const runner = new GoalRunner(fakeHost({ review: async () => { void runner.cancel(dir); await new Promise((resolve) => setTimeout(resolve, 5)); return { ok: false, summary: "stopped" } } }))
    const record = await runner.start(dir)
    assert.equal(record.status, "cancelled")
    assert.ok(!statuses(record).includes("needs-human"))
  })

  it("a resolve made while the goal runs is applied by the run, not undone by its next save", async () => {
    const dir = await newGoal([checkpoint("one", [], { tier: 2, command: undefined, check: "look" }), checkpoint("two", [])])
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const host = fakeHost({ implement: async (task) => { if (task.index === 2) await gate; return { ok: true, summary: "done" } } })
    const runner = new GoalRunner(host)
    const run = runner.start(dir)
    while (!host.calls.implement.some((task) => task.index === 2)) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal((await loadGoal(dir)).record.checkpoints[0].status, "needs-human")
    await runner.resolve(dir, 1, true, "looked fine")
    release()
    const record = await run
    assert.deepEqual([record.status, ...statuses(record)], ["done", "done", "done"])
  })

  it("starts no verification command when paused while the verifying state is being saved", async () => {
    const dir = await newGoal([checkpoint("one", [])])
    const host = fakeHost()
    const runner = new GoalRunner(host, (_dir, next) => { if (next.checkpoints[0].status === "verifying") runner.pause(dir).catch(() => {}) })
    const record = await runner.start(dir)
    assert.deepEqual(host.calls.check, [], "the abort that arrived during the save is honoured before the command is dispatched")
    assert.equal(record.status, "paused")
  })
})
