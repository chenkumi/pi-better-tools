import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MouseRegion, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { JobsOverlay, MORE_HOVER, displayedJobs, jobKey, renderJobs, safeJobText, type PanelJob, type PanelKind } from "./job-view.js";

export { type PanelKind } from "./job-view.js";
export const BACKGROUND_WIDGET_KEY = "pi-better-tools-background-jobs";
export const BACKGROUND_STATUS_KEY = "pi-better-tools-background-jobs";
const RENDEZVOUS = "pi-better-tools:background-panel:v2";
export type PanelHost = Partial<Pick<ExtensionAPI, "events" | "registerCommand">>;
export interface PanelSnapshot { jobs: readonly PanelJob[]; signature: string }
type Entry = { token: object; ctx: ExtensionContext; owner: string; snapshot?: PanelSnapshot };
const kinds: PanelKind[] = ["subagents", "shell", "fork", "monitor", "pty"];
/** SGR mouse report: motion with no button held is code 35 (32 motion + 3 "none"). */
const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/;
const FOCUS_OUT = "\x1b[O";

/** Presentation only. Registry ownership, admission, cancellation and messages stay in each module. */
export class BackgroundPanel {
  readonly protocol = RENDEZVOUS;
  private entries = new Map<PanelKind, Entry>();
  private collapsed = false;
  private owner?: string;
  private ui?: ExtensionContext;
  private last?: string;
  private revision = 0;
  /** Presentation only: the job key (or MORE_HOVER) under the pointer. The TUI sends no "pointer left" event, see the input listener below. */
  private hover?: string;
  private overlay?: { ctx: ExtensionContext; owner: string; close?: () => void; component?: JobsOverlay; cancelled: boolean };

  attach(kind: PanelKind, ctx: ExtensionContext): object | undefined {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    const owner = ctx.sessionManager.getSessionId();
    this.closeOverlay();
    if (owner !== this.owner) {
      this.entries.clear(); this.collapsed = false; this.hide(); this.owner = owner;
    }
    const token = {};
    this.entries.set(kind, { token, ctx, owner });
    this.last = undefined; this.revision++;
    return token;
  }
  update(kind: PanelKind, token: object, snapshot: PanelSnapshot) {
    const entry = this.entries.get(kind);
    if (!entry || entry.token !== token) return;
    entry.snapshot = snapshot;
    this.redraw(); this.refreshOverlay();
  }
  detach(kind: PanelKind, token: object) {
    if (this.entries.get(kind)?.token !== token) return;
    this.entries.delete(kind); this.closeOverlay(); this.last = undefined; this.redraw();
  }
  private validEntries() {
    for (const [kind, entry] of this.entries) {
      let valid = false;
      try { valid = entry.owner === this.owner && entry.ctx.sessionManager.getSessionId() === entry.owner; } catch { /* disposed context */ }
      if (!valid) { this.entries.delete(kind); this.closeOverlay(); this.last = undefined; }
    }
    return kinds.flatMap(kind => { const entry = this.entries.get(kind); return entry ? [{ kind, entry }] : []; });
  }
  private jobs(kind?: PanelKind): PanelJob[] {
    return this.validEntries().filter(e => !kind || e.kind === kind).flatMap(({ entry }) => entry.snapshot?.jobs ?? []);
  }
  private isOwner(ctx: ExtensionContext, owner = this.owner): boolean {
    try { return ctx.sessionManager.getSessionId() === owner; } catch { return false; }
  }
  private closeOverlay() {
    const overlay = this.overlay;
    if (!overlay || overlay.cancelled) return;
    overlay.cancelled = true;
    try { overlay.close?.(); } catch { /* disposed terminal */ }
  }
  private refreshOverlay() {
    try { if (this.overlay && !this.overlay.cancelled) this.overlay.component?.refresh(); } catch { this.closeOverlay(); }
  }
  private hide() {
    const ui = this.ui; this.last = undefined; this.revision++; this.hover = undefined;
    let cleared = true;
    try { ui?.ui.setStatus(BACKGROUND_STATUS_KEY, undefined); } catch { cleared = false; }
    try { ui?.ui.setWidget(BACKGROUND_WIDGET_KEY, undefined); } catch { cleared = false; }
    // Transient removal failure remains retryable; old pointer components invalidate immediately.
    if (cleared && this.ui === ui) this.ui = undefined;
  }
  private redraw() {
    const entries = this.validEntries(), active = entries.filter(({ entry }) => entry.snapshot?.jobs.some(j => j.active));
    if (!active.length || this.collapsed) { if (this.ui) this.hide(); return; }
    const ctx = active[0].entry.ctx;
    const signature = JSON.stringify(entries.map(({ kind, entry }) => [kind, entry.snapshot?.signature]));
    if (signature === this.last && ctx === this.ui) return;
    const revision = ++this.revision;
    this.ui = ctx;
    try {
      // The above-editor panel owns its summary, not the host footer or other status keys.
      ctx.ui.setStatus(BACKGROUND_STATUS_KEY, undefined);
      ctx.ui.setWidget(BACKGROUND_WIDGET_KEY, (tui, theme) => {
        let disposed = false, renderedWidth = -1, moreRow = -1, moreEnd = -1, jobRows: string[] = [];
        // Screen rectangle of this component, learned from the mouse events it receives.
        let rect: { x: number; y: number; width: number; height: number } | undefined;
        const clearHover = () => {
          if (this.hover === undefined) return;
          this.hover = undefined;
          try { tui.requestRender(); } catch { /* disposed terminal */ }
        };
        // The TUI only sends "move" to the component under the pointer, never "left". Raw input arrives before dispatch, so a
        // pointer report outside the panel (or the terminal losing focus) clears the highlight. The report is never consumed.
        let removeListener: (() => void) | undefined;
        try {
          removeListener = tui.addInputListener?.(data => {
            if (disposed || this.hover === undefined) return undefined;
            if (data === FOCUS_OUT) { clearHover(); return undefined; }
            const report = SGR_MOUSE.exec(data);
            if (report && rect) {
              const x = Number(report[2]) - 1, y = Number(report[3]) - 1;
              if (x < rect.x || x >= rect.x + rect.width || y < rect.y || y >= rect.y + rect.height) clearHover();
            }
            return undefined;
          });
        } catch { /* hover is optional; click still works */ }
        const child: Component = {
          invalidate() { renderedWidth = -1; moreRow = -1; jobRows = []; },
          render: width => {
            renderedWidth = width; moreRow = -1; jobRows = [];
            if (disposed || revision !== this.revision || this.collapsed) return [];
            const jobs = this.jobs();
            const lines = renderJobs(jobs, theme, width, tui.terminal?.rows ?? 40, this.hover);
            moreRow = lines.length - 1;
            // Each displayed job owns one row between the heading and More; anything that does not line up is simply not clickable.
            const shown = displayedJobs(jobs, tui.terminal?.rows ?? 40);
            if (lines.length === shown.length + 2) jobRows = shown.map(jobKey);
            moreEnd = width >= 3 ? 1 + visibleWidth("More…") : -1;
            // Only the complete More label is a mouse target, not clipped text or row contents.
            if (moreEnd > width - (width >= 3 ? 1 : 0) || !safeJobText(lines[moreRow] ?? "").startsWith(" More…")) moreRow = -1;
            return lines;
          },
        };
        const mouse = new MouseRegion(child, event => {
          if (disposed || revision !== this.revision || event.width !== renderedWidth) return;
          rect = { x: event.screenX - event.x, y: event.screenY - event.y, width: event.width, height: event.height };
          // Only the complete More label is a mouse target for the list; a job's row opens that job directly.
          const more = moreRow >= 0 && event.y === moreRow && event.x >= 1 && event.x < moreEnd;
          const key = more ? undefined : jobRows[event.y - 1];
          if (event.type === "move") {
            const target = more ? MORE_HOVER : key;
            if (target === this.hover) return;
            this.hover = target;
            return { handled: true, render: true };
          }
          if (event.button !== "left" || event.shift || event.alt || event.ctrl || event.type !== "click" || (event.clickCount ?? 1) !== 1) return;
          if (!this.jobs().some(j => j.active)) return;
          if (!more && !key) return;
          void this.openMore(ctx, undefined, key).catch(() => undefined);
          return { handled: true, render: true };
        });
        return Object.assign(mouse, { dispose: () => { disposed = true; moreRow = -1; jobRows = []; try { removeListener?.(); } catch { /* disposed terminal */ } if (this.hover !== undefined && revision === this.revision) this.hover = undefined; } });
      }, { placement: "aboveEditor" });
      this.ui = ctx; this.last = signature;
    } catch { this.hide(); }
  }
  /** Retain old command aliases; collapse is explicit, active jobs appear automatically by default. */
  toggle(kind: PanelKind | "all" | "collapse", ctx?: ExtensionContext): boolean {
    const entries = this.validEntries();
    if (ctx && (ctx.mode !== "tui" || !ctx.hasUI || !this.isOwner(ctx))) return false;
    if (!entries.some(e => (!kinds.includes(kind as PanelKind) || e.kind === kind) && e.entry.snapshot?.jobs.length)) { this.redraw(); return false; }
    this.collapsed = kind === "collapse";
    this.last = undefined; this.redraw(); return true;
  }
  async openMore(ctx: ExtensionContext, kind?: PanelKind, detailKey?: string): Promise<boolean> {
    if (ctx.mode !== "tui" || !ctx.hasUI || !this.isOwner(ctx) || !this.jobs(kind).length || this.overlay) return false;
    const lease = { ctx, owner: this.owner!, cancelled: false } as NonNullable<BackgroundPanel["overlay"]>;
    this.overlay = lease;
    try {
      await ctx.ui.custom<void>((tui, theme, _keys, done) => {
        let closed = false;
        lease.close = () => { if (closed) return; closed = true; lease.cancelled = true; lease.component?.dispose(); done(); };
        if (lease.cancelled || !this.isOwner(ctx, lease.owner) || !this.validEntries().length) {
          queueMicrotask(lease.close); return { render: () => [], invalidate() {} };
        }
        lease.component = new JobsOverlay(() => {
          if (lease.cancelled) return [];
          if (!this.isOwner(ctx, lease.owner)) { this.closeOverlay(); this.validEntries(); return []; }
          return this.jobs(kind);
        }, theme, () => tui.requestRender(), lease.close, () => tui.terminal?.rows ?? 24, tui, ctx.cwd, detailKey);
        return lease.component;
      }, { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: 20, margin: 1 } });
      return true;
    } catch { return false; }
    finally { lease.component?.dispose(); if (this.overlay === lease) this.overlay = undefined; }
  }
}

/** pi.events wrappers differ per extension; a synchronous rendezvous shares only this UI instance. */
export function acquireBackgroundPanel(api?: PanelHost): BackgroundPanel {
  let panel: BackgroundPanel | undefined;
  try {
    api?.events?.emit(RENDEZVOUS, { protocol: RENDEZVOUS, offer(value: BackgroundPanel) {
      if (!panel && value?.protocol === RENDEZVOUS && typeof value.attach === "function" && typeof value.openMore === "function") panel = value;
    } });
    if (panel) return panel;
    panel = new BackgroundPanel(); const shared = panel;
    api?.events?.on(RENDEZVOUS, (data: unknown) => {
      const request = data as { protocol?: string; offer?: (panel: BackgroundPanel) => void } | undefined;
      if (request?.protocol === RENDEZVOUS && typeof request.offer === "function") request.offer(shared);
    });
    api?.registerCommand?.("background-jobs", {
      description: "Background jobs above the editor; More opens a bounded list: more | subagents | shell | fork | monitor | pty | all | collapse (TUI only)",
      handler: async (args, ctx) => {
        const target = args.trim() || "more";
        if (![...kinds, "more", "all", "collapse"].includes(target)) { ctx.ui.notify("Usage: /background-jobs [more|subagents|shell|fork|monitor|pty|all|collapse]", "warning"); return; }
        if (target === "collapse") { shared.toggle("collapse", ctx); return; }
        if (ctx.mode !== "tui" || !ctx.hasUI) return;
        shared.toggle(target === "more" ? "all" : target as PanelKind | "all", ctx);
        if (!await shared.openMore(ctx, kinds.includes(target as PanelKind) ? target as PanelKind : undefined)) ctx.ui.notify("No retained background jobs here, or the job list is already open.", "info");
      },
    });
  } catch { /* UI registration failures cannot disable the job tools. */ }
  return panel ?? new BackgroundPanel();
}
