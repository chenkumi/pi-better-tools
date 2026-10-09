import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Box, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

import { acquireBackgroundPanel, BACKGROUND_WIDGET_KEY, type BackgroundPanel, type PanelHost } from "./background-panel.js";
export const SHELL_WIDGET_KEY = BACKGROUND_WIDGET_KEY;
export interface ShellWidgetRow { jobId: string; tool: string; status: "running" | "cancelling"; command: string }
const safe = (text: string) => stripVTControlCharacters(text.slice(0, 256)).replace(/[\r\n\t]/g, " ").replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");

export function renderShellWidget(rows: readonly ShellWidgetRow[], theme: Theme): Component {
  return { invalidate() {}, render(width) {
    width = Math.max(0, Math.floor(width));
    const padding = width >= 3 ? 1 : 0, inner = width - padding * 2;
    const lines = [theme.fg("accent", truncateToWidth(`Background Shell · ${rows.length} active`, inner)),
      ...rows.slice(0, 8).map(row => theme.fg(row.status === "cancelling" ? "warning" : "dim", truncateToWidth(`${safe(row.tool)} · ${row.status === "cancelling" ? "cancel requested" : "running"} · …${safe(row.jobId).slice(-6)} · ${safe(row.command)}`, inner)))];
    if (rows.length > 8) lines.push(theme.fg("dim", truncateToWidth(`… ${rows.length - 8} more active jobs`, inner)));
    const bg = theme.getBgAnsi("toolPendingBg");
    const box = new Box(padding, 0, text => theme.bg("toolPendingBg", text.replace(/\x1b\[(?:0)?m/g, reset => reset + bg)));
    box.addChild({ render: () => lines, invalidate() {} });
    return box.render(width);
  } };
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
      const rows = this.source!();
      if (this.token) this.panel.update("shell", this.token, { count: rows.length, active: rows.length > 0, signature: JSON.stringify(rows), details: (theme, width) => renderShellWidget(rows, theme).render(width) });
    } catch { this.clear(); /* UI failure never changes execution or notifications. */ }
  }
  clear() {
    const token = this.token;
    this.ctx = undefined; this.owner = undefined; this.source = undefined; this.token = undefined;
    try { if (token) this.panel.detach("shell", token); } catch { /* disposed UI */ }
  }
}
