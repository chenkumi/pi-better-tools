// Runs a goal: one session per checkpoint to implement it, then the runner's own check (README). The state machine
// (`goal-state.ts`) decides what each result means; this file only asks the host to do the work and saves after every change. What the host
// can do is the small `GoalHost` interface, so the loop is tested with a fake one.
import type { Plan, PlanCheckpoint } from "./plan.ts"
import { parseVerdict, reviewPrompt } from "./review.ts"
import { loadGoal, saveRecord, type GoalRecord } from "./store.ts"
import * as state from "./state.ts"

export interface ImplementTask {
  goalId: string
  index: number
  attempt: number
  /** A name for the session, so it can be found in the history. */
  name: string
  prompt: string
}

export interface GoalHost {
  /** Whether the project is trusted: the goal runner runs no command of a plan in a project that is not. */
  trusted(): Promise<boolean>
  /** Runs one task in a session of its own and resolves when its turn has ended. `ok` is false when the model failed or was stopped. */
  implement(task: ImplementTask, signal: AbortSignal): Promise<{ ok: boolean; summary: string }>
  /** Runs a static review in a session that can only read; same shape as `implement`. */
  review(task: ImplementTask, signal: AbortSignal): Promise<{ ok: boolean; summary: string }>
  /** Runs a command in the workspace: the exit code (null when it did not run or was stopped) and the end of its output. */
  check(command: string, signal: AbortSignal): Promise<{ exitCode: number | null; output: string }>
}

const clip = (text: string, max: number): string => (text.length > max ? `…${text.slice(text.length - max)}` : text)

/** What the session that implements a checkpoint is told. It starts with no memory of the conversation, so the plan carries everything. */
export function taskPrompt(plan: Plan, record: GoalRecord, checkpoint: PlanCheckpoint): string {
  const entry = record.checkpoints.find((candidate) => candidate.index === checkpoint.index)!
  const { verify } = checkpoint
  const lines = [
    `You are carrying out checkpoint ${checkpoint.index} of ${plan.checkpoints.length} of a plan, unattended. Nobody can answer questions: use the plan and your own judgment, and finish.`,
    "",
    `Plan: ${plan.title}`,
    `Goal: ${plan.goal}`,
  ]
  if (plan.references.length > 0) lines.push("", "References:", ...plan.references.map((reference) => `- ${reference}`))
  if (plan.rules.length > 0) lines.push("", "Rules (follow them):", ...plan.rules.map((rule) => `- ${rule}`))
  if (plan.decisions.length > 0) lines.push("", "Decisions already made:", ...plan.decisions.map((decision) => `- ${decision.question} → ${decision.decision} (${decision.reason})`))
  const before = plan.checkpoints.filter((other) => other.index < checkpoint.index && checkpoint.dependsOn.includes(other.index))
  if (before.length > 0) lines.push("", "Already done, which this checkpoint builds on:", ...before.map((other) => `- ${other.index}. ${other.title}`))
  if (entry.log.at(-1)?.startsWith(state.PAUSE_LOG)) lines.push("", "The previous attempt was paused by the user part-way. The folder may hold changes it left unfinished: look at what is there first, then finish the checkpoint without redoing or duplicating work that is already correct.")
  lines.push("", `Your checkpoint: ${checkpoint.index}. ${checkpoint.title}`, "To do:", ...checkpoint.todos.map((todo) => `- ${todo}`))
  lines.push("", `It is checked afterwards${verify.command ? ` by running \`${verify.command}\` (it must exit with 0)` : ""}. It passes when: ${verify.expected}`)
  if (entry.log.length > 0) lines.push("", "Earlier attempts at this checkpoint, and what went wrong (do not repeat it):", ...entry.log.map((log) => clip(log, 3000)))
  lines.push("", "Do only this checkpoint. Do not submit plans. When you are done, say in a few lines what you changed.")
  return lines.join("\n")
}

/** Why a run was stopped when the host itself is going away: the goal is left as it is, to be continued by the next host. */
const SHUTDOWN = Symbol("goal-runner-shutdown")
/** Why a run was stopped by `pause`: the session in progress is stopped and the goal is kept, paused. */
const PAUSE = Symbol("goal-runner-pause")

interface Run {
  controller: AbortController
  done: Promise<GoalRecord>
}

export class GoalRunner {
  private readonly host: GoalHost
  private readonly onChange: (dir: string, record: GoalRecord) => void
  private readonly runs = new Map<string, Run>()
  /** Changes asked for while a run of this process holds the record: the run applies them itself, so its next save does not undo them. */
  /** Goals whose stop is a cancel: a cancel that follows a pause wins, whichever aborted first. */
  private readonly cancelling = new Set<string>()
  private readonly pending = new Map<string, Array<(record: GoalRecord) => GoalRecord>>()

  constructor(host: GoalHost, onChange: (dir: string, record: GoalRecord) => void = () => {}) {
    this.host = host
    this.onChange = onChange
  }

  isRunning(dir: string): boolean {
    return this.runs.has(dir)
  }

  /** Starts (or, after a restart, continues) the goal in this folder. Resolves with the record when nothing more will run. */
  start(dir: string): Promise<GoalRecord> {
    const running = this.runs.get(dir)
    if (running) return running.done
    // Registered at once, before anything is awaited: a second start in the same tick must find this run.
    const controller = new AbortController()
    const done = this.open(dir, controller.signal).finally(() => { this.runs.delete(dir); this.cancelling.delete(dir) })
    this.runs.set(dir, { controller, done })
    return done
  }

  private async open(dir: string, signal: AbortSignal): Promise<GoalRecord> {
    if (!(await this.host.trusted())) throw new Error("This project is not trusted, so the goal runner does not run the commands of a plan in it.")
    const { plan, record } = await loadGoal(dir)
    if (record.status === "done" || record.status === "cancelled") return record
    return this.loop(dir, plan, state.recover(plan, record), signal)
  }

  /** The host is stopping: every run ends where it is, with nothing recorded about the session that gets stopped; the next start recovers it. */
  async stopAll(): Promise<void> {
    const runs = [...this.runs.values()]
    for (const run of runs) run.controller.abort(SHUTDOWN)
    await Promise.allSettled(runs.map((run) => run.done))
  }

  /** The user retries a failed or skipped checkpoint of a blocked goal: it is queued again. The caller starts it. */
  async retry(dir: string, index: number): Promise<GoalRecord> {
    const { plan, record } = await loadGoal(dir)
    const next = state.retry(plan, record, index)
    if (this.defer(dir, (live) => state.retry(plan, live, index))) return next
    await this.save(dir, plan, next)
    return next
  }

  /** A person did what a `needs-human` checkpoint asked: the goal goes on from there once the caller starts it. */
  async resolve(dir: string, index: number, passed: boolean, note: string): Promise<GoalRecord> {
    const { plan, record } = await loadGoal(dir)
    const next = state.resolveHuman(record, index, passed, note)
    if (this.defer(dir, (live) => state.resolveHuman(live, index, passed, note))) return next
    await this.save(dir, plan, next)
    return next
  }

  /** Stops the run of this goal: the session in progress is stopped, and the goal is cancelled with what was done kept. */
  async cancel(dir: string): Promise<GoalRecord> {
    const run = this.runs.get(dir)
    if (!run) {
      const { plan, record } = await loadGoal(dir)
      const cancelled = state.cancel(record)
      if (cancelled !== record) await this.save(dir, plan, cancelled)
      return cancelled
    }
    this.cancelling.add(dir)
    run.controller.abort()
    return run.done
  }

  /** Stops the work in progress at once and keeps the goal paused (the attempt does not count); `resume` continues it. */
  async pause(dir: string): Promise<GoalRecord> {
    const run = this.runs.get(dir)
    if (!run) {
      const { plan, record } = await loadGoal(dir)
      const paused = state.pause(record)
      if (paused !== record) await this.save(dir, plan, paused)
      return paused
    }
    run.controller.abort(PAUSE)
    return run.done
  }

  /** A paused goal is queued again; the caller starts it. */
  async resume(dir: string): Promise<GoalRecord> {
    if (this.runs.has(dir)) throw new Error("The goal is still stopping; try again in a moment")
    const { plan, record } = await loadGoal(dir)
    const next = state.resume(record)
    await this.save(dir, plan, next)
    return next
  }

  /** True when a run holds the goal: the change is left for it to apply (the caller saves nothing). */
  private defer(dir: string, change: (record: GoalRecord) => GoalRecord): boolean {
    if (!this.runs.has(dir)) return false
    this.pending.set(dir, [...(this.pending.get(dir) ?? []), change])
    return true
  }

  private drain(dir: string, record: GoalRecord): GoalRecord {
    const changes = this.pending.get(dir) ?? []
    this.pending.delete(dir)
    return changes.reduce((current, change) => { try { return change(current) } catch { return current } }, record)
  }

  private async save(dir: string, plan: Plan, record: GoalRecord): Promise<void> {
    await saveRecord(dir, plan, record)
    this.onChange(dir, record)
  }

  private async loop(dir: string, plan: Plan, first: GoalRecord, signal: AbortSignal): Promise<GoalRecord> {
    let record = first
    try {
      for (;;) {
        if (signal.reason === SHUTDOWN) return record
        if (signal.aborted) {
          record = signal.reason === PAUSE && !this.cancelling.has(dir) && (record.status === "queued" || record.status === "running") ? state.pause(record) : state.cancel(record)
          await this.save(dir, plan, record)
          return record
        }
        record = this.drain(dir, record)
        const step = state.advance(plan, record)
        record = step.record
        await this.save(dir, plan, record)
        // A change that arrived while saving goes on from here instead of being lost.
        if (step.kind !== "run") { if (this.pending.has(dir)) continue; return record }
        record = state.begin(record, step.index)
        await this.save(dir, plan, record)
        record = await this.work(dir, plan, record, step.index, signal)
      }
    } catch (error) {
      // A file that cannot be written is a failed goal, not something to ignore.
      record = { ...record, status: "failed", updatedAt: new Date().toISOString() }
      this.onChange(dir, record)
      await saveRecord(dir, plan, record).catch(() => undefined)
      throw error
    }
  }

  /** Tier 3: a read-only session reads the work and gives a verdict. A pass is recorded as reviewed, not run; no verdict is left to a person. */
  private async review(started: GoalRecord, plan: Plan, checkpoint: PlanCheckpoint, attempt: number, summary: string, signal: AbortSignal): Promise<state.Outcome> {
    const scope = `Scope: ${checkpoint.verify.check}\nExpected: ${checkpoint.verify.expected}`
    try {
      const task = { goalId: started.id, index: checkpoint.index, attempt, name: `Goal ${checkpoint.index}/${plan.checkpoints.length}: review ${checkpoint.title}`, prompt: reviewPrompt(plan, checkpoint, summary) }
      const result = await this.host.review(task, signal)
      const verdict = result.ok ? parseVerdict(result.summary) : undefined
      if (!verdict) return { result: "human", log: `The review gave no verdict, so a person has to look.\n${scope}\n${clip(result.summary, 2000)}` }
      if (verdict.verdict === "fail") return { result: "fail", log: `Reviewed, not run: FAIL\n${scope}\n${clip(verdict.reasons, 3000)}` }
      return { result: "pass", log: `Reviewed, not run: PASS\n${scope}${checkpoint.verify.note ? `\nNot verified: ${checkpoint.verify.note}` : ""}\n${clip(verdict.reasons, 3000)}` }
    } catch (error) {
      return { result: "human", log: `The review could not run (${error instanceof Error ? error.message : String(error)}), so a person has to look.\n${scope}` }
    }
  }

  /** One attempt at a checkpoint that has begun: implement, then check. */
  private async work(dir: string, plan: Plan, started: GoalRecord, index: number, signal: AbortSignal): Promise<GoalRecord> {
    const checkpoint = plan.checkpoints.find((candidate) => candidate.index === index)!
    const attempt = started.checkpoints.find((entry) => entry.index === index)!.attempts
    const outcome = async (): Promise<{ record: GoalRecord; outcome?: state.Outcome }> => {
      let summary: string
      try {
        const task = { goalId: started.id, index, attempt, name: `Goal ${checkpoint.index}/${plan.checkpoints.length}: ${checkpoint.title}`, prompt: taskPrompt(plan, started, checkpoint) }
        const result = await this.host.implement(task, signal)
        if (signal.aborted) return { record: started }
        if (!result.ok) return { record: started, outcome: { result: "fail", log: `The implementation did not complete.\n${clip(result.summary, 2000)}` } }
        summary = result.summary
      } catch (error) {
        if (signal.aborted) return { record: started }
        return { record: started, outcome: { result: "fail", log: `The implementation failed: ${error instanceof Error ? error.message : String(error)}` } }
      }
      const verifying = state.startVerifying(started, index)
      await this.save(dir, plan, verifying)
      const { verify } = checkpoint
      if (verify.tier === 2) return { record: verifying, outcome: { result: "human", log: `${clip(summary, 1500)}\nTo check: ${verify.check}\nExpected: ${verify.expected}` } }
      if (verify.tier === 3) {
        const reviewed = await this.review(started, plan, checkpoint, attempt, summary, signal)
        // Stopped while reviewing: no verdict is not a request for a person; the loop cancels, or the next start recovers the checkpoint.
        return signal.aborted ? { record: verifying } : { record: verifying, outcome: reviewed }
      }
      if (signal.aborted) return { record: verifying } // paused or stopped while the state was being saved: no command is started
      try {
        const run = await this.host.check(verify.command!, signal)
        if (signal.aborted) return { record: verifying }
        const text = `$ ${verify.command}\nexit code ${run.exitCode ?? "none"}\n${clip(run.output, 3000)}\nExpected: ${verify.expected}`
        return { record: verifying, outcome: { result: run.exitCode === 0 ? "pass" : "fail", log: text } }
      } catch (error) {
        if (signal.aborted) return { record: verifying }
        return { record: verifying, outcome: { result: "fail", log: `The check could not run: ${error instanceof Error ? error.message : String(error)}` } }
      }
    }
    const { record, outcome: result } = await outcome()
    // Stopped by the user: the loop cancels the goal, which puts the checkpoint in progress back to pending.
    if (!result) return record
    const finished = state.finish(plan, record, index, result)
    await this.save(dir, plan, finished)
    return finished
  }
}
