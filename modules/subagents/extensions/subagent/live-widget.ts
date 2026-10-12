import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { acquireBackgroundPanel, BACKGROUND_WIDGET_KEY, type BackgroundPanel, type PanelHost } from "../../../shell-tools/src/background-panel.js";
import { renderJobs, safeJobText, type PanelJob } from "../../../shell-tools/src/job-view.js";
export const SUBAGENT_WIDGET_KEY = BACKGROUND_WIDGET_KEY;
export interface SubagentWidgetRow { jobId: string; taskId?: string; agent?: string; title?: string; status: "queued" | "running" | "finalizing"; cancelRequested: boolean }
/** Compatibility for the existing minimal active projection; production supplies richer job-level data. */
function legacyJobs(rows: readonly SubagentWidgetRow[]): PanelJob[] {
  const groups = new Map<string, SubagentWidgetRow[]>();
  for (const row of rows) { const group = groups.get(row.jobId) ?? []; group.push(row); groups.set(row.jobId, group); }
  return [...groups].map(([jobId, tasks]) => {
    const running = tasks.filter(t => t.status === "running").length, queued = tasks.filter(t => t.status === "queued").length;
    const state = tasks.some(t => t.cancelRequested) ? "cancelling" : running ? "running" : queued ? "queued" : "finalizing";
    return { kind: "subagents", jobId, label: safeJobText(tasks[0].agent ?? "batch", 64), title: safeJobText(tasks[0].title ?? "", 256), state, active: true,
      activity: state === "cancelling" ? "Cancel requested · awaiting settlement" : state === "finalizing" ? "Finalizing · finishing cleanup" : `${running} running / ${queued} queued`, usageState: "pending", details: tasks.map(t => `${safeJobText(t.agent ?? "batch", 256)} · ${t.status} · ${safeJobText(t.title ?? "", 256)}`) };
  });
}
export function renderSubagentWidget(rows: readonly SubagentWidgetRow[], theme: Theme): Component {
  return { invalidate() {}, render: width => renderJobs(legacyJobs(rows), theme, width) };
}

/** Owner-bound, event-driven view. Never performs model/provider/tool work. */
export class SubagentJobsWidget {
  private ctx?: ExtensionContext;
  private owner?: string;
  private source?: () => readonly PanelJob[] | readonly SubagentWidgetRow[];
  private token?: object;
  private panel: BackgroundPanel;
  constructor(api?: PanelHost) { this.panel = acquireBackgroundPanel(api); }
  bind(ctx: ExtensionContext, source: () => readonly PanelJob[] | readonly SubagentWidgetRow[]) {
    this.clear();
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    try { this.owner = ctx.sessionManager.getSessionId(); this.ctx = ctx; this.source = source; this.token = this.panel.attach("subagents", ctx); }
    catch { /* Observability cannot fail admission. */ }
    this.refresh();
  }
  refresh() {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      if (ctx.sessionManager.getSessionId() !== this.owner) { this.clear(); return; }
      const rows = this.source!(), jobs = rows.length && "kind" in rows[0] ? rows as readonly PanelJob[] : legacyJobs(rows as readonly SubagentWidgetRow[]);
      if (this.token) this.panel.update("subagents", this.token, { jobs, signature: JSON.stringify(jobs) });
    } catch { this.clear(); /* UI failure never controls jobs. */ }
  }
  clear() {
    const token = this.token;
    this.ctx = undefined; this.owner = undefined; this.source = undefined; this.token = undefined;
    try { if (token) this.panel.detach("subagents", token); } catch { /* disposed UI */ }
  }
}
