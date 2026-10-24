import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { acquireBackgroundPanel, type BackgroundPanel, type PanelHost } from "./background-panel.js";
import { panelSignature, type PanelJob, type PanelKind } from "./job-view.js";

/** Owner-bound presentation only. Each producer still owns its projection and job lifecycle. */
export class JobsWidgetBinding<Row> {
  private ctx?: ExtensionContext;
  private owner?: string;
  private source?: () => readonly Row[];
  private token?: object;
  private panel: BackgroundPanel;
  constructor(private kind: PanelKind, private project: (rows: readonly Row[]) => readonly PanelJob[], api?: PanelHost) {
    this.panel = acquireBackgroundPanel(api);
  }
  bind(ctx: ExtensionContext, source: () => readonly Row[]) {
    this.clear();
    try {
      if (ctx.mode !== "tui" || !ctx.hasUI) return;
      this.owner = ctx.sessionManager.getSessionId(); this.ctx = ctx; this.source = source;
      this.token = this.panel.attach(this.kind, ctx);
    } catch { /* Observability cannot fail admission. */ }
    this.refresh();
  }
  refresh() {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      if (ctx.sessionManager.getSessionId() !== this.owner) { this.clear(); return; }
      const jobs = this.project(this.source!());
      if (this.token) this.panel.update(this.kind, this.token, { jobs, signature: panelSignature(jobs) });
    } catch { this.clear(); /* UI failure never controls jobs or notifications. */ }
  }
  clear() {
    const token = this.token;
    this.ctx = undefined; this.owner = undefined; this.source = undefined; this.token = undefined;
    try { if (token) this.panel.detach(this.kind, token); } catch { /* disposed UI */ }
  }
}
