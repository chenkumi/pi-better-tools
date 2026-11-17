// The goal rows of the shared Jobs panel (README). Presentation only: one row per goal, no plan text, command or log on the row,
// and nothing here starts, stops or changes a goal (the `goal_*` tools do).
import { JobsWidgetBinding, safeJobText, type PanelJob } from "../../../shared/src/background/index.ts"
import type { Plan } from "./plan.ts"
import type { GoalRecord } from "./store.ts"

export interface GoalRow { plan: Plan; record: GoalRecord }

const MAX_ROWS = 32
const ACTIVE = new Set(["queued", "running", "blocked"])

const entryOf = (record: GoalRecord, index: number) => record.checkpoints.find((entry) => entry.index === index)

/** The checkpoint the goal is at: the one in progress, else the first that is not done. */
function currentOf(row: GoalRow) {
  const open = row.record.checkpoints.find((entry) => entry.status === "running" || entry.status === "verifying") ?? row.record.checkpoints.find((entry) => entry.status !== "done")
  const checkpoint = open && row.plan.checkpoints.find((candidate) => candidate.index === open.index)
  return open && checkpoint ? { entry: open, checkpoint } : undefined
}

export function goalPanelJob(row: GoalRow): PanelJob {
  const { plan, record } = row
  const total = plan.checkpoints.length
  const done = record.checkpoints.filter((entry) => entry.status === "done").length
  const current = currentOf(row)
  const attempt = current ? `attempt ${Math.max(1, current.entry.attempts)}/${current.checkpoint.verify.maxAttempts}` : ""
  const needs = record.checkpoints.filter((entry) => ["failed", "skipped", "needs-human"].includes(entry.status)).length
  const activity = record.status === "blocked" ? `Needs attention · ${needs} checkpoint${needs === 1 ? "" : "s"} · ${done}/${total} done`
    : record.status === "queued" ? `Queued · ${done}/${total} done`
    : current ? `${current.checkpoint.index}/${total} ${current.checkpoint.title} · ${current.entry.status} · ${attempt}`
    : `${done}/${total} done`
  const lines = plan.checkpoints.map((checkpoint) => {
    const entry = entryOf(record, checkpoint.index)
    return `${checkpoint.index}. ${checkpoint.title}: ${entry?.status ?? "pending"} (attempts ${entry?.attempts ?? 0}/${checkpoint.verify.maxAttempts})`
  })
  return {
    kind: "goal", jobId: record.id, label: plan.title, title: `${done}/${total}`, state: record.status, active: ACTIVE.has(record.status),
    activity: safeJobText(activity, 256), usageState: "na", startedAt: Date.parse(record.createdAt),
    summary: record.status === "running" && attempt ? `${done}/${total} | ${attempt}` : `${record.status} | ${done}/${total}`,
    details: [`Goal ID: ${record.id}`, `State: ${record.status}`, `Updated: ${record.updatedAt}`, ...lines, "Manage it with the goal_* tools (tool_search \"goal\"). Nothing runs while Pi is closed."].map((line) => safeJobText(line, 512)),
  }
}

export class GoalPanel extends JobsWidgetBinding<GoalRow> {
  constructor() {
    super("goal", (rows) => [...rows].sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt)).slice(0, MAX_ROWS).map(goalPanelJob))
  }
}
