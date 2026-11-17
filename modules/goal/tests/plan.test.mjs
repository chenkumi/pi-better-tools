// The plan `plan_submit` delivers: the checks that let a goal start. The fixtures are what a real model planned with the
// create-plan skill (gpt-6.1-terra, a scratch project, 2026-11-17), written as the structure the tool takes.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const { validatePlan } = await import("../src/plan.ts")

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/goal-plans/${name}.json`, import.meta.url), "utf8"))
const errorsOf = (input) => {
  const result = validatePlan(input)
  assert.ok(!result.ok, "the plan should be refused")
  return result.errors.join("\n")
}
const changed = (name, change) => {
  const plan = fixture(name)
  change(plan)
  return plan
}

describe("validatePlan", () => {
  it("accepts a plan with checkpoints and numbers them, with the default attempts", () => {
    const result = validatePlan(fixture("multi"))
    assert.ok(result.ok, result.ok ? "" : result.errors.join("; "))
    assert.deepEqual(result.plan.checkpoints.map((checkpoint) => [checkpoint.index, checkpoint.dependsOn, checkpoint.verify.maxAttempts]), [[1, [], 3], [2, [1], 3]])
    assert.equal(result.plan.decisions.length, 2)
  })

  it("accepts a plan of one checkpoint and no decisions", () => {
    const result = validatePlan(fixture("flat"))
    assert.ok(result.ok)
    assert.equal(result.plan.checkpoints.length, 1)
  })

  it("keeps an attempts limit that was given", () => {
    const result = validatePlan(changed("flat", (plan) => (plan.checkpoints[0].verify.maxAttempts = 5)))
    assert.ok(result.ok)
    assert.equal(result.plan.checkpoints[0].verify.maxAttempts, 5)
  })

  it("refuses a plan that is not complete or well formed", () => {
    assert.match(errorsOf(changed("multi", (plan) => delete plan.goal)), /goal/)
    assert.match(errorsOf(changed("multi", (plan) => (plan.checkpoints = []))), /checkpoints/)
    assert.match(errorsOf(changed("multi", (plan) => (plan.checkpoints[0].verify.tier = 4))), /tier/)
    assert.match(errorsOf(changed("multi", (plan) => delete plan.checkpoints[1].verify.expected)), /expected/)
    assert.match(errorsOf(changed("multi", (plan) => delete plan.rules)), /rules/)
    assert.match(errorsOf(changed("multi", (plan) => (plan.checkpoints[0].verify.maxAttempts = 0))), /maxAttempts/)
    assert.match(errorsOf(changed("multi", (plan) => (plan.checkpoints[0].todos = []))), /todos/)
  })

  it("takes no rules, one rule or several", () => {
    assert.ok(validatePlan(fixture("flat")).ok)
    assert.deepEqual(validatePlan(fixture("multi")).plan.rules.length, 2)
    assert.match(errorsOf(changed("multi", (plan) => (plan.rules = [""]))), /rules/)
  })

  it("wants a command on an automatic check and the steps on the others", () => {
    assert.match(errorsOf(changed("multi", (plan) => delete plan.checkpoints[0].verify.command)), /Tier 1 check needs a command/)
    assert.match(errorsOf(changed("multi", (plan) => (plan.checkpoints[0].verify.command = "  "))), /Tier 1 check needs a command/)
    assert.match(errorsOf(changed("multi", (plan) => (plan.checkpoints[1].verify.tier = 2))), /Tier 2 check needs the steps/)
    assert.ok(validatePlan(changed("multi", (plan) => Object.assign(plan.checkpoints[1].verify, { tier: 2, check: "Run the CLI by hand with sample input." }))).ok)
  })

  it("has no place for an open question", () => {
    assert.match(errorsOf(changed("multi", (plan) => (plan.openQuestions = ["which key?"]))), /additional properties/)
  })

  it("refuses a dependency that is not an earlier checkpoint", () => {
    assert.match(errorsOf(changed("multi", (plan) => (plan.checkpoints[1].dependsOn = [2]))), /number 2.*not an earlier checkpoint/)
    assert.match(errorsOf(changed("multi", (plan) => (plan.checkpoints[0].dependsOn = [1]))), /number 1.*not an earlier checkpoint/)
    assert.match(errorsOf(changed("multi", (plan) => (plan.checkpoints[1].dependsOn = [1, 1]))), /twice/)
  })

  it("wants a note on a static review", () => {
    const review = (note) => changed("multi", (plan) => Object.assign(plan.checkpoints[1].verify, { tier: 3, check: "Read src/cli.js.", note }))
    assert.match(errorsOf(review(undefined)), /Tier 3 review needs a note/)
    assert.match(errorsOf(review("  ")), /Tier 3 review needs a note/)
    assert.ok(validatePlan(review("not run: the CLI is only read")).ok)
  })
})
