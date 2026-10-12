import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { acquireBackgroundPanel, BACKGROUND_WIDGET_KEY, type BackgroundPanel, type PanelHost } from "./background-panel.js";
import { renderJobs, safeJobText, type PanelJob } from "./job-view.js";
export const SHELL_WIDGET_KEY = BACKGROUND_WIDGET_KEY;
export interface ShellWidgetRow {
  jobId: string; tool: string; status: string; command: string;
  startedAt?: number; endedAt?: number; totalBytes?: number; logBytes?: number;
  exitCode?: number; cancelRequested?: boolean; liveLogPath?: string;
}
export function shellPanelJobs(rows: readonly ShellWidgetRow[]): PanelJob[] {
  return rows.slice(0, 32).map(row => {
    const active = row.status === "running" || row.status === "cancelling";
    const activity = row.status === "cancelling" ? "Cancel requested · awaiting settlement" : row.status === "running" ? `Running · ${row.totalBytes ? "output received" : "no output observed"}` : row.status === "timed_out" ? "Output idle timeout" : row.status;
    return { kind: "shell", jobId: row.jobId, label: safeJobText(row.tool, 64), title: safeJobText(row.command, 256), state: row.status, active, activity, usageState: "na", startedAt: row.startedAt,
      details: [
        `Command preview: ${safeJobText(row.command, 8192)}`,
        `Started: ${row.startedAt === undefined ? "unknown" : new Date(row.startedAt).toISOString()}`,
        `Finished: ${row.endedAt === undefined ? "not observed" : new Date(row.endedAt).toISOString()}`,
        `Output bytes observed: ${row.totalBytes ?? "unknown"} · Log bytes retained: ${row.logBytes ?? "unknown"}`,
        `Exit code: ${row.exitCode ?? "not provided"} · Cancel requested: ${row.cancelRequested === true}`,
        ...(row.liveLogPath ? [`Log: ${safeJobText(row.liveLogPath)}`] : []),
        "Tokens N/A: Shell has no model usage ledger.",
      ] };
  });
}
export function renderShellWidget(rows: readonly ShellWidgetRow[], theme: Theme): Component {
  return { invalidate() {}, render: width => renderJobs(shellPanelJobs(rows), theme, width) };
}

/** UI-only observer: no timers, tools, model messages, or job-control side effects. */
export class ShellJobsWidget {
  private ctx?: ExtensionContext;
  private owner?: string;
  private source?: () => ShellWidgetRow[];
  private token?: object;
  private panel: BackgroundPanel;
  constructor(api?: PanelHost) { this.panel = acquireBackgroundPanel(api); }
  bind(ctx: ExtensionContext, source: () => ShellWidgetRow[]) {
    this.clear();
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    try { this.owner = ctx.sessionManager.getSessionId(); this.ctx = ctx; this.source = source; this.token = this.panel.attach("shell", ctx); }
    catch { /* Observability cannot fail admission. */ }
    this.refresh();
  }
  refresh() {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      if (ctx.sessionManager.getSessionId() !== this.owner) { this.clear(); return; }
      const jobs = shellPanelJobs(this.source!());
      if (this.token) this.panel.update("shell", this.token, { jobs, signature: JSON.stringify(jobs) });
    } catch { this.clear(); /* UI failure never changes execution or notifications. */ }
  }
  clear() {
    const token = this.token;
    this.ctx = undefined; this.owner = undefined; this.source = undefined; this.token = undefined;
    try { if (token) this.panel.detach("shell", token); } catch { /* disposed UI */ }
  }
}
