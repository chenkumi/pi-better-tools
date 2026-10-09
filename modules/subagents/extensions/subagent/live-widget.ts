import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Box, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

import { acquireBackgroundPanel, BACKGROUND_WIDGET_KEY, type BackgroundPanel, type PanelHost } from "../../../shell-tools/src/background-panel.js";
export const SUBAGENT_WIDGET_KEY = BACKGROUND_WIDGET_KEY;
export interface SubagentWidgetRow { jobId: string; taskId?: string; agent?: string; title?: string; status: "queued" | "running" | "finalizing"; cancelRequested: boolean }
const safe = (text: string) => stripVTControlCharacters(text.slice(0, 256)).replace(/[\r\n\t]/g, " ").replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");

export function renderSubagentWidget(rows: readonly SubagentWidgetRow[], theme: Theme): Component {
  return { invalidate() {}, render(width) {
    width = Math.max(0, Math.floor(width));
    const padding = width >= 3 ? 1 : 0, inner = width - padding * 2;
    const running = rows.filter(row => row.status === "running").length, queued = rows.filter(row => row.status === "queued").length, finalizing = rows.filter(row => row.status === "finalizing").length;
    const lines = [theme.fg("accent", truncateToWidth(`Background Subagents · ${running} running · ${queued} queued${finalizing ? ` · ${finalizing} finalizing` : ""}`, inner))];
    const rank = (row: SubagentWidgetRow) => row.status === "running" ? 0 : row.status === "finalizing" ? 1 : 2;
    const ordered = [...rows].sort((a, b) => rank(a) - rank(b));
    for (const row of ordered.slice(0, 8)) {
      const id = `…${safe(row.jobId).slice(-6)}${row.taskId ? `/…${safe(row.taskId).slice(-6)}` : ""}`;
      lines.push(theme.fg(row.cancelRequested ? "warning" : "dim", truncateToWidth(`${safe(row.agent ?? "batch")} · ${row.status === "finalizing" ? "finalizing · finishing cleanup" : row.status}${row.cancelRequested ? " (cancel requested)" : ""} · ${id}${row.title ? ` · ${safe(row.title)}` : ""}`, inner)));
    }
    if (rows.length > 8) lines.push(theme.fg("dim", truncateToWidth(`… ${rows.length - 8} more tasks/batches (running shown first)`, inner)));
    const bg = theme.getBgAnsi("toolPendingBg");
    const box = new Box(padding, 0, text => theme.bg("toolPendingBg", text.replace(/\x1b\[(?:0)?m/g, reset => reset + bg)));
    box.addChild({ render: () => lines, invalidate() {} });
    return box.render(width);
  } };
}

/** Owner-bound, event-driven view. Never performs model/provider/tool work. */
export class SubagentJobsWidget {
  private ctx?: ExtensionContext;
  private owner?: string;
  private source?: () => SubagentWidgetRow[];
  private token?: object;
  private panel: BackgroundPanel;
  constructor(api?: PanelHost) { this.panel = acquireBackgroundPanel(api); }
  bind(ctx: ExtensionContext, source: () => SubagentWidgetRow[]) {
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
      const rows = this.source!();
      if (this.token) this.panel.update("subagents", this.token, { count: rows.filter(row => row.status !== "finalizing").length, active: rows.length > 0, signature: JSON.stringify(rows), details: (theme, width) => renderSubagentWidget(rows, theme).render(width) });
    } catch { this.clear(); /* UI failure never controls jobs. */ }
  }
  clear() {
    const token = this.token;
    this.ctx = undefined; this.owner = undefined; this.source = undefined; this.token = undefined;
    try { if (token) this.panel.detach("subagents", token); } catch { /* disposed UI */ }
  }
}
