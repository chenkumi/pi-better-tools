// `/goals`: the goals of this project in the bottom panel, with keys for pause, resume, cancel and retry. The panel only picks an action; the
// action itself goes through the same `goal_*` tool code the model uses, so checks, the owner lock and the rules are not repeated here.
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"
import { bottomConfirm, isBottomPanelOpen, openBottomPanel } from "../../../shared/src/bottom-panel/index.ts"
import type { BottomBody, PanelStyle } from "../../../shared/src/bottom-panel/index.ts"
import { goalPanelJob, type GoalRow } from "./panel.ts"

export type GoalAction = { type: "pause" | "resume" | "cancel" | "retry"; goalId: string }

const KEYS = "↑/↓ PgUp/PgDn move  Enter details  p pause  r resume  t retry  x cancel  Esc close"

/** The checkpoint `t` retries: the first one that failed or was skipped (what depends on it is reopened with it). */
export function retryTarget(row: GoalRow): number | undefined {
  return row.record.checkpoints.find((entry) => entry.status === "failed" || entry.status === "skipped")?.index
}

export class GoalsBody implements BottomBody {
  #at = 0
  #detail = false
  #scroll = 0
  #room = 5
  constructor(
    private readonly rows: () => readonly GoalRow[],
    private readonly style: PanelStyle,
    private readonly screenRows: () => number,
    private readonly done: (action: GoalAction | null) => void,
    focus?: string,
  ) {
    const index = focus ? this.rows().findIndex((row) => row.record.id === focus) : -1
    if (index >= 0) this.#at = index
  }

  #current(): GoalRow | undefined {
    return this.rows()[this.#at]
  }

  render(width: number): string[] {
    const s = this.style
    const rows = this.rows()
    this.#at = Math.min(this.#at, Math.max(0, rows.length - 1))
    const room = Math.max(3, this.screenRows() - 12)
    this.#room = room
    const current = this.#current()
    if (this.#detail && current) {
      const job = goalPanelJob(current)
      const text = [`${job.label} · ${job.title}`, ...job.details].flatMap((line) => wrapTextWithAnsi(line, Math.max(10, width - 1)))
      this.#scroll = Math.min(this.#scroll, Math.max(0, text.length - room))
      const shown = text.slice(this.#scroll, this.#scroll + room)
      return ["", ...shown.map((line) => truncateToWidth(line, width, "…", false)), "", s.fg("dim", `${text.length > room ? `lines ${this.#scroll + 1}-${this.#scroll + shown.length} of ${text.length}  ` : ""}↑/↓ scroll  Enter/Esc back`)]
    }
    if (rows.length === 0) return ["", s.fg("dim", "No goals yet. Start one with /goal <what to do>."), "", s.fg("dim", "Esc close")]
    const from = Math.min(Math.max(0, this.#at - Math.floor(room / 2)), Math.max(0, rows.length - room))
    const lines = rows.slice(from, from + room).map((row, i) => {
      const view = goalPanelJob(row)
      const text = `${view.state.padEnd(9)} ${view.label} · ${view.title} · ${view.summary ?? ""}`
      return from + i === this.#at ? s.fg("accent", `▸ ${truncateToWidth(text, width - 2)}`) : `  ${truncateToWidth(text, width - 2)}`
    })
    return ["", ...lines, "", s.fg("dim", truncateToWidth(`${KEYS}${rows.length > room ? `  (${this.#at + 1}/${rows.length})` : ""}`, width))]
  }

  handleInput(data: string): void {
    const rows = this.rows()
    if (this.#detail) {
      if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "ctrl+c")) { this.#detail = false; this.#scroll = 0 }
      else if (matchesKey(data, "up")) this.#scroll = Math.max(0, this.#scroll - 1)
      else if (matchesKey(data, "down")) this.#scroll++
      else if (matchesKey(data, "pageUp")) this.#scroll = Math.max(0, this.#scroll - this.#room)
      else if (matchesKey(data, "pageDown")) this.#scroll += this.#room
      return
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.done(null)
    const row = this.#current()
    const type = data === "p" ? "pause" : data === "r" ? "resume" : data === "x" ? "cancel" : data === "t" ? "retry" : undefined
    if (row && type) return this.done({ type, goalId: row.record.id })
    if (rows.length === 0) return
    if (matchesKey(data, "enter")) { this.#detail = true; this.#scroll = 0 }
    else if (matchesKey(data, "up")) this.#at = (this.#at - 1 + rows.length) % rows.length
    else if (matchesKey(data, "down")) this.#at = (this.#at + 1) % rows.length
    else if (matchesKey(data, "pageUp")) this.#at = Math.max(0, this.#at - this.#room)
    else if (matchesKey(data, "pageDown")) this.#at = Math.min(rows.length - 1, this.#at + this.#room)
  }
}

export interface ManageDeps {
  rows: () => readonly GoalRow[]
  /** Runs a `goal_*` tool and returns its text. */
  call: (tool: string, params: Record<string, unknown>, ctx: ExtensionCommandContext) => Promise<string>
}

/** A tool result as a line for the user: its status and note when it is JSON, else its first line. */
export function describe(text: string): string {
  try {
    const value = JSON.parse(text) as { status?: unknown; note?: unknown }
    if (typeof value.status === "string") return typeof value.note === "string" ? `${value.status}. ${value.note}` : value.status
  } catch { /* not JSON */ }
  return text.split("\n")[0] ?? ""
}

/** Runs one action through the tools; returns the line to show the user. */
export async function performAction(action: GoalAction, deps: ManageDeps, ctx: ExtensionCommandContext): Promise<string | undefined> {
  const row = deps.rows().find((candidate) => candidate.record.id === action.goalId)
  const name = row?.plan.title ?? action.goalId
  const first = async (tool: string, params: Record<string, unknown>) => describe(await deps.call(tool, params, ctx))
  switch (action.type) {
    case "pause": return `${name}: ${await first("goal_pause", { goalId: action.goalId })}`
    case "resume": return `${name}: ${await first("goal_resume", { goalId: action.goalId })}`
    case "cancel":
      if (!(await bottomConfirm(ctx, "Cancel goal", `Cancel "${name}"? The checkpoint in progress is stopped; what was done is kept.`))) return undefined
      return `${name}: ${await first("goal_cancel", { goalId: action.goalId })}`
    case "retry": {
      const index = row ? retryTarget(row) : undefined
      if (index === undefined) return `${name}: nothing to retry (only a blocked goal with a failed or skipped checkpoint can be retried).`
      return `${name}: ${await first("goal_retry", { goalId: action.goalId, index })}`
    }
  }
}

export function registerGoalsCommand(pi: ExtensionAPI, deps: ManageDeps): void {
  pi.registerCommand("goals", {
    description: "List the goals of this project and pause, resume, retry or cancel them",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI || ctx.mode !== "tui") { if (ctx.hasUI) ctx.ui.notify("The goal list needs the interactive TUI. Use the goal_* tools.", "warning"); return }
      if (isBottomPanelOpen()) { ctx.ui.notify("Another panel is open. Close it first, then run this command again.", "warning"); return }
      let focus: string | undefined
      for (;;) {
        const action = await openBottomPanel<GoalAction | null>(ctx.ui, {
          key: "pi-better-tools-goals", title: "Goals",
          create: ({ done, theme, rows: screenRows }) => new GoalsBody(() => deps.rows(), theme, screenRows, done, focus),
        })
        if (!action) return
        focus = action.goalId
        try {
          const text = await performAction(action, deps, ctx)
          if (text) ctx.ui.notify(text, "info")
        } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning") }
      }
    },
  })
}
