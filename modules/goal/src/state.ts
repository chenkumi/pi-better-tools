// The states of a goal and what moves them (README). Pure: a record goes in, a new record comes out, so a runner (real or
// fake) only decides what happened and this file decides what that means. The record is the only thing that survives a restart.
import type { Plan } from "./plan.ts"
import type { CheckpointStatus, GoalRecord } from "./store.ts"

type Entry = GoalRecord["checkpoints"][number]

const stamp = (now: Date): string => now.toISOString()
const entryOf = (record: GoalRecord, index: number): Entry => {
  const entry = record.checkpoints.find((checkpoint) => checkpoint.index === index)
  if (!entry) throw new Error(`The goal has no checkpoint ${index}`)
  return entry
}

function change(record: GoalRecord, index: number, patch: Partial<Omit<Entry, "index" | "log">>, now: Date, log?: string): GoalRecord {
  return {
    ...record,
    updatedAt: stamp(now),
    checkpoints: record.checkpoints.map((entry) => (entry.index === index ? { ...entry, ...patch, log: log === undefined ? entry.log : [...entry.log, log] } : entry)),
  }
}

function expect(entry: Entry, ...allowed: CheckpointStatus[]): void {
  if (!allowed.includes(entry.status)) throw new Error(`Checkpoint ${entry.index} is ${entry.status}, not ${allowed.join(" or ")}`)
}

/** A checkpoint that can start now: pending, with everything it depends on done. */
function ready(plan: Plan, record: GoalRecord): number | undefined {
  return plan.checkpoints.find((checkpoint) => entryOf(record, checkpoint.index).status === "pending" && checkpoint.dependsOn.every((dependency) => entryOf(record, dependency).status === "done"))?.index
}

/** What a runner does next, and the record with what follows from the checkpoints that cannot run any more (marked `skipped`). */
export type Step = { kind: "run"; index: number; record: GoalRecord } | { kind: "wait"; record: GoalRecord } | { kind: "settled"; record: GoalRecord }

/**
 * Looks at the checkpoints. What depends on a failed or skipped checkpoint can never run: it is `skipped`. Then a checkpoint that is
 * ready is `run`; while one is running or verifying the runner `wait`s; with none left the goal is `settled`: `done` when everything is
 * done, else `blocked` (something failed, was skipped, or needs a person). Safe to call again and again.
 */
export function advance(plan: Plan, record: GoalRecord, now: Date = new Date()): Step {
  if (record.status === "cancelled" || record.status === "done" || record.status === "failed") return { kind: "settled", record }
  let current = record
  for (let changed = true; changed; ) {
    changed = false
    for (const checkpoint of plan.checkpoints) {
      const entry = entryOf(current, checkpoint.index)
      if (entry.status !== "pending") continue
      const broken = checkpoint.dependsOn.find((dependency) => ["failed", "skipped"].includes(entryOf(current, dependency).status))
      if (broken === undefined) continue
      current = change(current, checkpoint.index, { status: "skipped" }, now, `skipped: checkpoint ${broken} did not finish`)
      changed = true
    }
  }
  const index = ready(plan, current)
  if (index !== undefined) return { kind: "run", index, record: { ...current, status: "running", updatedAt: stamp(now) } }
  if (current.checkpoints.some((entry) => entry.status === "running" || entry.status === "verifying")) return { kind: "wait", record: current }
  const status = current.checkpoints.every((entry) => entry.status === "done") ? "done" : "blocked"
  return { kind: "settled", record: { ...current, status, updatedAt: stamp(now) } }
}

/** The implementation of a checkpoint starts: this counts as an attempt, as it must also after a restart that interrupts it. */
export function begin(record: GoalRecord, index: number, now: Date = new Date()): GoalRecord {
  const entry = entryOf(record, index)
  expect(entry, "pending")
  return change(record, index, { status: "running", attempts: entry.attempts + 1 }, now)
}

/** The implementation ended; the goal runner now checks the result. */
export function startVerifying(record: GoalRecord, index: number, now: Date = new Date()): GoalRecord {
  expect(entryOf(record, index), "running")
  return change(record, index, { status: "verifying" }, now)
}

/** What the check found: it passed, it failed (the log says how), or a person has to operate it (Tier 2). */
export type Outcome = { result: "pass" | "fail" | "human"; log: string }

/**
 * Records the result of a check. A pass finishes the checkpoint. A failure tries again while attempts are left, and ends it as `failed` when
 * `maxAttempts` is used up. `human` leaves it `needs-human`: what depends on it waits, the rest goes on.
 */
export function finish(plan: Plan, record: GoalRecord, index: number, outcome: Outcome, now: Date = new Date()): GoalRecord {
  const entry = entryOf(record, index)
  expect(entry, "running", "verifying")
  const label = `attempt ${entry.attempts}`
  if (outcome.result === "pass") return change(record, index, { status: "done" }, now, `${label}: passed\n${outcome.log}`)
  if (outcome.result === "human") return change(record, index, { status: "needs-human" }, now, `${label}: needs a person\n${outcome.log}`)
  const max = plan.checkpoints.find((checkpoint) => checkpoint.index === index)!.verify.maxAttempts
  return change(record, index, { status: entry.attempts < max ? "pending" : "failed" }, now, `${label}: failed\n${outcome.log}`)
}

/** The goal starts again after the app was closed or crashed: a checkpoint that was running counts as the attempt it was. */
export function recover(plan: Plan, record: GoalRecord, now: Date = new Date()): GoalRecord {
  if (record.status !== "running") return record
  let current: GoalRecord = { ...record, status: "queued", updatedAt: stamp(now) }
  for (const entry of record.checkpoints) {
    if (entry.status !== "running" && entry.status !== "verifying") continue
    const max = plan.checkpoints.find((checkpoint) => checkpoint.index === entry.index)!.verify.maxAttempts
    current = change(current, entry.index, { status: entry.attempts < max ? "pending" : "failed" }, now, `attempt ${entry.attempts}: interrupted (the app stopped)`)
  }
  return current
}

/** Cancelled by the user: nothing more runs, and what was finished stays finished. A checkpoint in progress goes back to `pending`. */
export function cancel(record: GoalRecord, now: Date = new Date()): GoalRecord {
  if (record.status === "done" || record.status === "cancelled") return record
  let current: GoalRecord = { ...record, status: "cancelled", updatedAt: stamp(now) }
  for (const entry of record.checkpoints) if (entry.status === "running" || entry.status === "verifying") current = change(current, entry.index, { status: "pending" }, now, `attempt ${entry.attempts}: cancelled`)
  return current
}

/**
 * The user retries a failed or skipped checkpoint of a `blocked` goal: it gets its attempts back, and so does what was skipped
 * because of it. The goal is queued again.
 */
export function retry(plan: Plan, record: GoalRecord, index: number, now: Date = new Date()): GoalRecord {
  if (record.status !== "blocked") throw new Error(`The goal is ${record.status}: only a blocked goal can be retried`)
  expect(entryOf(record, index), "failed", "skipped")
  let current: GoalRecord = { ...record, status: "queued", updatedAt: stamp(now) }
  const reopen = new Set([index])
  for (let grown = true; grown; ) {
    grown = false
    for (const checkpoint of plan.checkpoints) if (!reopen.has(checkpoint.index) && entryOf(record, checkpoint.index).status === "skipped" && checkpoint.dependsOn.some((dependency) => reopen.has(dependency))) {
      reopen.add(checkpoint.index)
      grown = true
    }
  }
  for (const reopened of reopen) current = change(current, reopened, { status: "pending", attempts: 0 }, now, "retried by the user")
  return current
}

/** A person did what a `needs-human` checkpoint asked for, and says whether it passed. A pass lets what depends on it start; the goal is queued again. */
export function resolveHuman(record: GoalRecord, index: number, passed: boolean, note: string, now: Date = new Date()): GoalRecord {
  expect(entryOf(record, index), "needs-human")
  const next = change(record, index, { status: passed ? "done" : "failed" }, now, `checked by a person: ${passed ? "passed" : "failed"}${note ? `\n${note}` : ""}`)
  return record.status === "blocked" ? { ...next, status: "queued" } : next
}
