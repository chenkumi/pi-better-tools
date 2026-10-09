import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Box, MouseRegion, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

export const BACKGROUND_WIDGET_KEY = "pi-better-tools-background-jobs";
export const BACKGROUND_STATUS_KEY = "pi-better-tools-background-jobs";
const RENDEZVOUS = "pi-better-tools:background-panel:v1";
export type PanelKind = "subagents" | "shell";
export type PanelHost = Partial<Pick<ExtensionAPI, "events" | "registerCommand">>;
export interface PanelSnapshot {
  count: number;
  active: boolean;
  signature: string;
  details(theme: Theme, width: number): string[];
}
type Entry = { token: object; ctx: ExtensionContext; owner: string; snapshot?: PanelSnapshot };
const kinds: PanelKind[] = ["subagents", "shell"];

/** Presentation only. Registry ownership, admission, cancellation and messages stay in each module. */
export class BackgroundPanel {
  readonly protocol = RENDEZVOUS;
  private entries = new Map<PanelKind, Entry>();
  private expanded = { subagents: false, shell: false };
  private owner?: string;
  private ui?: ExtensionContext;
  private last?: string;
  private revision = 0;

  attach(kind: PanelKind, ctx: ExtensionContext): object | undefined {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    const owner = ctx.sessionManager.getSessionId();
    if (owner !== this.owner) {
      this.entries.clear(); this.expanded = { subagents: false, shell: false }; this.hide(); this.owner = owner;
    }
    const token = {};
    this.entries.set(kind, { token, ctx, owner });
    this.expanded[kind] = false; this.last = undefined; this.revision++;
    return token;
  }
  update(kind: PanelKind, token: object, snapshot: PanelSnapshot) {
    const entry = this.entries.get(kind);
    if (!entry || entry.token !== token) return;
    entry.snapshot = snapshot;
    if (!snapshot.active) this.expanded[kind] = false;
    this.redraw();
  }
  detach(kind: PanelKind, token: object) {
    if (this.entries.get(kind)?.token !== token) return;
    this.entries.delete(kind); this.expanded[kind] = false; this.last = undefined; this.redraw();
  }
  private validEntries() {
    for (const [kind, entry] of this.entries) {
      let valid = false;
      try { valid = entry.owner === this.owner && entry.ctx.sessionManager.getSessionId() === entry.owner; } catch { /* disposed context */ }
      if (!valid) { this.entries.delete(kind); this.expanded[kind] = false; this.last = undefined; }
    }
    return kinds.flatMap(kind => { const entry = this.entries.get(kind); return entry ? [{ kind, entry }] : []; });
  }
  private hide() {
    const ui = this.ui; this.last = undefined; this.revision++;
    let cleared = true;
    try { ui?.ui.setStatus(BACKGROUND_STATUS_KEY, undefined); } catch { cleared = false; }
    try { ui?.ui.setWidget(BACKGROUND_WIDGET_KEY, undefined); } catch { cleared = false; }
    // A transient removal failure must remain retryable on the next lifecycle event.
    // Invalidate old components immediately, even if their host cannot remove them yet.
    if (cleared && this.ui === ui) this.ui = undefined;
  }
  private redraw() {
    const entries = this.validEntries(), active = entries.filter(({ entry }) => entry.snapshot?.active);
    if (!active.length) { if (this.ui) this.hide(); return; }
    const ctx = active[0].entry.ctx;
    const signature = JSON.stringify(entries.map(({ kind, entry }) => [kind, entry.snapshot?.signature, this.expanded[kind]]));
    if (signature === this.last && ctx === this.ui) return;
    const revision = ++this.revision;
    this.ui = ctx;
    try {
      // Plain status text lets the native footer own styling, width and ordering.
      ctx.ui.setStatus(BACKGROUND_STATUS_KEY, kinds.map(kind => `${this.expanded[kind] ? "▾" : "▸"} ${kind === "subagents" ? "Subagents" : "Shell"}：${this.entries.get(kind)?.snapshot?.count ?? 0}`).join(" ｜ "));
      if (!active.some(({ kind }) => this.expanded[kind])) {
        ctx.ui.setWidget(BACKGROUND_WIDGET_KEY, undefined);
        this.last = signature;
        return;
      }
      ctx.ui.setWidget(BACKGROUND_WIDGET_KEY, (tui, theme) => {
        let disposed = false, bounds: { kind: PanelKind; start: number; end: number }[] = [], renderedWidth = -1;
        const child: Component = {
          invalidate() { bounds = []; renderedWidth = -1; },
          render: width => {
            bounds = []; renderedWidth = width;
            if (disposed || revision !== this.revision) return [];
            const current = this.validEntries();
            if (!current.some(({ entry }) => entry.snapshot?.active)) return [];
            width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
            const padding = width >= 3 ? 1 : 0, inner = width - padding * 2;
            const segment = (kind: PanelKind, short: boolean) => `${this.expanded[kind] ? "▾" : "▸"} ${kind === "subagents" ? short ? "S" : "Subagents" : short ? "Sh" : "Shell"}：${this.entries.get(kind)?.snapshot?.count ?? 0}`;
            let separator = " ｜ ";
            let parts = kinds.map(kind => segment(kind, false));
            if (visibleWidth(parts.join(separator)) > inner) parts = kinds.map(kind => segment(kind, true));
            if (visibleWidth(parts.join(separator)) > inner) {
              separator = "|"; parts = kinds.map(kind => `${kind === "subagents" ? "S" : "Sh"}:${this.entries.get(kind)?.snapshot?.count ?? 0}`);
            }
            const labelBudget = visibleWidth(parts.join(separator)) > inner ? Math.max(0, inner - 3) : inner;
            let x = padding;
            kinds.forEach((kind, index) => {
              const end = x + visibleWidth(parts[index]);
              // Never make a partially clipped label an ambiguous click target.
              if (end <= padding + labelBudget && this.entries.get(kind)?.snapshot?.active) bounds.push({ kind, start: x, end });
              x = end + visibleWidth(separator);
            });
            const bg = theme.getBgAnsi("toolPendingBg"), box = new Box(padding, 0, text => theme.bg("toolPendingBg", text.replace(/\x1b\[(?:0)?m/g, reset => reset + bg)));
            box.addChild({ render: () => [theme.fg("accent", truncateToWidth(parts.join(separator), inner))], invalidate() {} });
            const lines = box.render(width);
            for (const { kind, entry } of current) if (this.expanded[kind] && entry.snapshot?.active) lines.push(...entry.snapshot.details(theme, width));
            return lines;
          },
        };
        const mouse = new MouseRegion(child, event => {
          if (disposed || revision !== this.revision || event.width !== renderedWidth || event.y !== 0 || event.button !== "left" || event.shift || event.alt || event.ctrl) return;
          this.validEntries();
          const target = bounds.find(bound => event.x >= bound.start && event.x < bound.end);
          if (!target || !this.entries.get(target.kind)?.snapshot?.active) return;
          if (event.type !== "click" || (event.clickCount ?? 1) !== 1) return;
          if (!this.toggle(target.kind)) return;
          try { tui.requestRender(); } catch { /* disposed terminal */ }
          return { handled: true, render: true };
        });
        return Object.assign(mouse, { dispose() { disposed = true; bounds = []; } });
      }, { placement: "belowEditor" });
      this.ui = ctx; this.last = signature;
    } catch { this.hide(); }
  }
  toggle(kind: PanelKind | "all" | "collapse", ctx?: ExtensionContext): boolean {
    const entries = this.validEntries().filter(({ entry }) => entry.snapshot?.active);
    if (ctx && (ctx.mode !== "tui" || !ctx.hasUI || ctx.sessionManager.getSessionId() !== this.owner)) return false;
    if (!entries.length) { this.redraw(); return false; }
    if (kind === "all" || kind === "collapse") {
      const expand = kind === "all" && !entries.every(({ kind }) => this.expanded[kind]);
      for (const { kind } of entries) this.expanded[kind] = expand;
    } else {
      if (!entries.some(entry => entry.kind === kind)) return false;
      this.expanded[kind] = !this.expanded[kind];
    }
    this.redraw(); return true;
  }
}

/** pi.events wrappers differ per extension; a synchronous rendezvous shares only this UI instance. */
export function acquireBackgroundPanel(api?: PanelHost): BackgroundPanel {
  let panel: BackgroundPanel | undefined;
  try {
    api?.events?.emit(RENDEZVOUS, { protocol: RENDEZVOUS, offer(value: BackgroundPanel) {
      if (!panel && value?.protocol === RENDEZVOUS && typeof value.attach === "function" && typeof value.toggle === "function") panel = value;
    } });
    if (panel) return panel;
    panel = new BackgroundPanel(); const shared = panel;
    api?.events?.on(RENDEZVOUS, (data: unknown) => {
      const request = data as { protocol?: string; offer?: (panel: BackgroundPanel) => void } | undefined;
      if (request?.protocol === RENDEZVOUS && typeof request.offer === "function") request.offer(shared);
    });
    api?.registerCommand?.("background-jobs", {
      description: "Toggle background-work details below the editor; counts stay in the footer: subagents | shell | all | collapse (TUI only)",
      handler: async (args, ctx) => {
        const target = args.trim() || "all";
        if (!["subagents", "shell", "all", "collapse"].includes(target)) { ctx.ui.notify("Usage: /background-jobs [subagents|shell|all|collapse]", "warning"); return; }
        if (!shared.toggle(target as PanelKind | "all" | "collapse", ctx) && ctx.hasUI) ctx.ui.notify("No active background details in this TUI session.", "info");
      },
    });
  } catch { /* UI registration failures cannot disable the job tools. */ }
  return panel ?? new BackgroundPanel();
}
