// The files of a goal (README): `<workspace>/.pi/goals/<goalId>/` holds `plan.json` (the settled plan, never changed), `goal.json`
// (the progress) and `plan.md` (a read-only view made from the two, for people and version control; nothing reads it back).
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ulid } from "ulid"
import type { Plan } from "./plan.ts"

/** A goal as the status tool reports it. */
export interface GoalSummary {
  goalId: string
  title: string
  status: GoalStatus
  createdAt: string
  updatedAt: string
  checkpoints: Array<{ index: number; title: string; tier: 1 | 2 | 3; status: CheckpointStatus; attempts: number; maxAttempts: number; log: string[] }>
}

export type GoalStatus = "draft" | "queued" | "running" | "paused" | "done" | "blocked" | "failed" | "cancelled"
/** `needs-human`: Tier 2, nobody operates it automatically (README); it keeps what depends on it waiting. */
export type CheckpointStatus = "pending" | "running" | "verifying" | "done" | "failed" | "skipped" | "needs-human"

export interface GoalRecord {
  id: string
  status: GoalStatus
  createdAt: string
  updatedAt: string
  checkpoints: Array<{ index: number; status: CheckpointStatus; attempts: number; log: string[] }>
}

export const goalsDir = (cwd: string): string => join(cwd, ".pi", "goals")

const box = (status: CheckpointStatus): string => (status === "done" ? "[x]" : "[ ]")

/** The plan as Markdown, with the state of each checkpoint and its log. */
export function renderPlan(plan: Plan, record?: GoalRecord): string {
  const lines: string[] = [`# ${plan.title}`, "", "## Goal", plan.goal, ""]
  if (plan.references.length > 0) lines.push("## References", ...plan.references.map((reference) => `- ${reference}`), "")
  if (plan.rules.length > 0) lines.push("## Rules", ...plan.rules.map((rule) => `- ${rule}`), "")
  if (plan.decisions.length > 0) lines.push("## Decisions", ...plan.decisions.map((entry) => `- ${entry.question} → ${entry.decision} (${entry.reason})`), "")
  lines.push("## Plan")
  for (const checkpoint of plan.checkpoints) {
    const state = record?.checkpoints.find((entry) => entry.index === checkpoint.index)
    const done = state?.status === "done"
    const { verify } = checkpoint
    lines.push(`- ${box(state?.status ?? "pending")} ${checkpoint.index}. ${checkpoint.title}`)
    lines.push(`    Depends on: ${checkpoint.dependsOn.length > 0 ? checkpoint.dependsOn.join(", ") : "none"}`)
    for (const todo of checkpoint.todos) lines.push(`    - ${done ? "[x]" : "[ ]"} ${todo}`)
    lines.push("    Verify:", `      Tier: ${verify.tier}`, `      Max attempts: ${verify.maxAttempts}`)
    if (verify.command) lines.push(`      Command: ${verify.command}`)
    if (verify.check) lines.push(`      Check: ${verify.check}`)
    lines.push(`      Expected: ${verify.expected}`)
    if (verify.note) lines.push(`      Note: ${verify.note}`)
    lines.push("      Verification log:", ...(state?.log ?? []).map((entry) => `        ${entry.replace(/\n/g, "\n        ")}`))
  }
  return lines.join("\n") + "\n"
}

let writes = 0
const TRANSIENT = new Set(["EBUSY", "EPERM", "EACCES"])

/**
 * Writes through a temporary file (a name of its own per write), so a crash never leaves half a file. A file that another program
 * holds for a moment (antivirus, an editor; common on Windows) is tried again a few times before the write counts as failed.
 */
async function writeAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${++writes}.tmp`
  for (let attempt = 0; ; attempt++) {
    try {
      await writeFile(temporary, text, "utf8")
      await rename(temporary, path)
      return
    } catch (error) {
      if (attempt >= 4 || !TRANSIENT.has((error as NodeJS.ErrnoException).code ?? "")) {
        await rm(temporary, { force: true }).catch(() => undefined)
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt))
    }
  }
}

/** Creates the goal: its folder, the plan, the record (queued) and the view. */
export async function createGoal(cwd: string, plan: Plan, now: Date = new Date()): Promise<{ id: string; dir: string; record: GoalRecord }> {
  const id = ulid(now.getTime()).toUpperCase()
  const dir = join(goalsDir(cwd), id)
  await mkdir(dir, { recursive: true })
  const stamp = now.toISOString()
  const record: GoalRecord = { id, status: "queued", createdAt: stamp, updatedAt: stamp, checkpoints: plan.checkpoints.map((checkpoint) => ({ index: checkpoint.index, status: "pending", attempts: 0, log: [] })) }
  await writeAtomic(join(dir, "plan.json"), JSON.stringify(plan, null, 2) + "\n")
  await writeAtomic(join(dir, "goal.json"), JSON.stringify(record, null, 2) + "\n")
  await writeAtomic(join(dir, "plan.md"), renderPlan(plan, record))
  return { id, dir, record }
}

/** The goal as the renderer shows it. */
export function summarize(plan: Plan, record: GoalRecord): GoalSummary {
  return {
    goalId: record.id,
    title: plan.title,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    checkpoints: plan.checkpoints.map((checkpoint) => {
      const entry = record.checkpoints.find((candidate) => candidate.index === checkpoint.index)!
      return { index: checkpoint.index, title: checkpoint.title, tier: checkpoint.verify.tier, status: entry.status, attempts: entry.attempts, maxAttempts: checkpoint.verify.maxAttempts, log: entry.log }
    }),
  }
}

/** Saves the progress and makes the view again (the plan itself is never rewritten). */
export async function saveRecord(dir: string, plan: Plan, record: GoalRecord): Promise<void> {
  await writeAtomic(join(dir, "goal.json"), JSON.stringify(record, null, 2) + "\n")
  await writeAtomic(join(dir, "plan.md"), renderPlan(plan, record))
}

/** Only the plan, which is never rewritten: safe to read while the progress is being saved. */
export async function loadPlan(dir: string): Promise<Plan> {
  return JSON.parse(await readFile(join(dir, "plan.json"), "utf8")) as Plan
}

/** Reads a goal's folder; throws when a file is missing or is not what the goal runner wrote. */
export async function loadGoal(dir: string): Promise<{ plan: Plan; record: GoalRecord }> {
  const plan = JSON.parse(await readFile(join(dir, "plan.json"), "utf8")) as Plan
  const record = JSON.parse(await readFile(join(dir, "goal.json"), "utf8")) as GoalRecord
  if (!Array.isArray(plan.checkpoints) || !Array.isArray(record.checkpoints) || plan.checkpoints.length !== record.checkpoints.length) throw new Error(`${dir} is not a goal`)
  return { plan, record }
}

/** The goal folders of a workspace; a folder that cannot be read is left out. */
export async function listGoals(cwd: string): Promise<Array<{ dir: string; plan: Plan; record: GoalRecord }>> {
  const names = await readdir(goalsDir(cwd)).catch(() => [] as string[])
  const goals: Array<{ dir: string; plan: Plan; record: GoalRecord }> = []
  for (const name of names.sort()) {
    const dir = join(goalsDir(cwd), name)
    try {
      goals.push({ dir, ...(await loadGoal(dir)) })
    } catch {
      // not a goal folder
    }
  }
  return goals
}
