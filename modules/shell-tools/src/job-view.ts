import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, SelectList, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

export type PanelKind = "subagents" | "shell";
export type UsageState = "pending" | "reported" | "unknown" | "na";
export interface PanelUsage { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number }
/** Plain presentation only; never a receipt, execution registry or accounting ledger. */
export interface PanelJob {
  kind: PanelKind;
  jobId: string;
  label: string;
  title: string;
  state: string;
  active: boolean;
  activity: string;
  usageState: UsageState;
  usage?: PanelUsage;
  startedAt?: number;
  details: string[];
}
export const jobKey = (job: PanelJob) => `${job.kind}:${job.jobId}`;
export const safeJobText = (text: string, limit = 8192) => stripVTControlCharacters(text.slice(0, limit))
  .replace(/[\r\n\t]/g, " ").replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
export const formatJobTokens = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}m` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
export function panelUsage(value: unknown): PanelUsage | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as Record<string, unknown>;
  if (typeof v.totalTokens !== "number" || !Number.isFinite(v.totalTokens) || v.totalTokens < 0) return;
  const num = (key: string) => typeof v[key] === "number" && Number.isFinite(v[key]) && (v[key] as number) >= 0 ? v[key] as number : 0;
  const cost = typeof v.cost === "number" ? num("cost") : v.cost && typeof v.cost === "object" ? (v.cost as { total?: unknown }).total : undefined;
  return { input: num("input"), output: num("output"), cacheRead: num("cacheRead"), cacheWrite: num("cacheWrite"), totalTokens: num("totalTokens"), cost: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : 0 };
}
export function usageLabel(job: Pick<PanelJob, "usageState" | "usage" | "active">, short = false): string {
  if (job.usageState === "na") return "tokens N/A";
  if (!job.usage || job.usageState !== "reported") return `usage ${job.usageState === "unknown" ? "unknown" : "pending"}`;
  const total = `${formatJobTokens(job.usage.totalTokens)} tok${job.active ? "*" : ""}`;
  return short ? total : `${job.active ? "reported " : ""}${total} · ↑${formatJobTokens(job.usage.input)} ↓${formatJobTokens(job.usage.output)}`;
}
export function usageDetails(usage?: PanelUsage): string {
  return usage ? `Input ${usage.input} · Output ${usage.output} · Cache read ${usage.cacheRead} · Cache write ${usage.cacheWrite} · Total ${usage.totalTokens} · Cost $${usage.cost.toFixed(4)}` : "Usage not reported; unknown is not zero.";
}
export function orderedJobs(jobs: readonly PanelJob[]): PanelJob[] {
  const rank = (j: PanelJob) => !j.active ? 4 : j.state === "cancelling" ? 0 : j.state === "running" ? 1 : j.state === "finalizing" ? 2 : 3;
  return [...jobs].sort((a, b) => rank(a) - rank(b) || (a.active ? (a.startedAt ?? 0) - (b.startedAt ?? 0) : (b.startedAt ?? 0) - (a.startedAt ?? 0)) || jobKey(a).localeCompare(jobKey(b)));
}
export function jobHeading(job: PanelJob): string {
  const icon = job.state === "queued" ? "◷" : job.state === "finalizing" || job.state === "cancelling" ? "◐" : job.active ? "●" : job.state === "completed" ? "✓" : "○";
  return `${icon} ${job.kind === "shell" ? "SH" : "SA"} ${safeJobText(job.label, 64)}${job.title ? ` · ${safeJobText(job.title, 256)}` : ""}`;
}
/** Five JOBS total, two physical rows each. Small terminals reserve space for editor/footer/chat. */
export function renderJobs(jobs: readonly PanelJob[], theme: Theme, width: number, terminalRows = 40): string[] {
  width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const active = orderedJobs(jobs.filter(j => j.active));
  if (!active.length) return [];
  const limit = Math.min(5, Math.max(0, Math.floor((terminalRows - 10) / 2)));
  const padding = width >= 3 ? 1 : 0, inner = width - padding * 2;
  const sub = active.filter(j => j.kind === "subagents").length;
  const lines = [theme.fg("accent", truncateToWidth(`Jobs · ${active.length} active · Subagents ${sub} / Shell ${active.length - sub}`, inner))];
  for (const job of active.slice(0, limit)) {
    const suffix = width >= 40 ? `  …${safeJobText(job.jobId, 256).slice(-6)}` : "";
    const heading = truncateToWidth(jobHeading(job), Math.max(0, inner - visibleWidth(suffix)));
    lines.push(theme.fg("accent", heading + " ".repeat(Math.max(0, inner - visibleWidth(heading) - visibleWidth(suffix)))) + theme.fg("dim", suffix));
    const usage = usageLabel(job, width < 80), activity = safeJobText(job.activity, 256);
    const text = inner >= 28 ? `${truncateToWidth(activity, Math.max(0, inner - visibleWidth(usage) - 5))} · ${usage}` : `${activity} · ${usage}`;
    lines.push(theme.fg(job.state === "cancelling" ? "warning" : "dim", truncateToWidth(`  ${text}`, inner)));
  }
  const omitted = Math.max(0, active.length - limit);
  lines.push(theme.fg("dim", truncateToWidth(`More…${omitted ? ` (+${omitted} active)` : ""} · /background-jobs more · * reported usage`, inner)));
  const bg = theme.getBgAnsi("toolPendingBg");
  const box = new Box(padding, 0, text => theme.bg("toolPendingBg", text.replace(/\x1b\[(?:0)?m/g, reset => reset + bg)));
  box.addChild({ render: () => lines, invalidate() {} });
  return box.render(width);
}

/** SDK selector supplies bounded keyboard/mouse selection; detail view is a bounded text viewport. */
export class JobsOverlay implements Component {
  private list?: SelectList;
  private signature?: string;
  private selected?: string;
  private detailKey?: string;
  private offset = 0;
  private pageRows = 5;
  private finishedOnly = false;
  private disposed = false;
  constructor(private source: () => PanelJob[], private theme: Theme, private requestRender: () => void, private done: () => void, private height: () => number) {}
  invalidate() { this.list?.invalidate(); }
  refresh() { if (!this.disposed) this.requestRender(); }
  dispose() { this.disposed = true; }
  handleInput(data: string) {
    if (this.disposed) return;
    if (matchesKey(data, "ctrl+c")) { this.done(); return; }
    if (matchesKey(data, "escape")) { if (this.detailKey) { this.detailKey = undefined; this.offset = 0; this.refresh(); } else this.done(); return; }
    if (matchesKey(data, "tab") && !this.detailKey) { this.finishedOnly = !this.finishedOnly; this.signature = undefined; this.selected = undefined; this.refresh(); return; }
    if (this.detailKey) {
      if (matchesKey(data, "up")) this.offset = Math.max(0, this.offset - 1);
      else if (matchesKey(data, "down")) this.offset++;
      else if (matchesKey(data, "pageUp")) this.offset = Math.max(0, this.offset - this.pageRows);
      else if (matchesKey(data, "pageDown")) this.offset += this.pageRows;
      this.refresh(); return;
    }
    this.list?.handleInput(data); this.selected = this.list?.getSelectedItem()?.value; this.refresh();
  }
  render(width: number): string[] {
    if (this.disposed) return [];
    width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    const height = Math.max(1, Math.min(20, this.height() - 2));
    const bordered = width >= 3 && height >= 4, inner = Math.max(0, width - (bordered ? 2 : 0));
    const contentRows = height - (bordered ? 2 : 0), bodyRows = Math.max(0, contentRows - 2);
    this.pageRows = Math.max(1, bodyRows - 1); // Detail scroll-info row is part of the height budget.
    const jobs = orderedJobs(this.source());
    if (this.disposed) return []; // Owner/source checks can close this lease during rendering.
    const lines: string[] = [];
    let title = `Jobs · ${this.finishedOnly ? "Recent finished" : "Active / Recent finished"}`;
    if (this.detailKey) {
      const job = jobs.find(j => jobKey(j) === this.detailKey);
      title = job ? `Job details · ${safeJobText(job.label, 64)}` : "Job no longer retained";
      const raw = job ? [jobHeading(job), `Job ID: ${safeJobText(job.jobId)}`, `State: ${safeJobText(job.state)} · ${safeJobText(job.activity)}`, usageLabel(job), ...job.details.slice(0, 256), ...(job.details.length > 256 ? ["… metadata fields omitted (256-field limit)"] : []), "Retained metadata only; no logs read. Cancel requested is not proof of process-tree exit."] : ["This job is no longer retained in this session/runtime."];
      const wrapped: string[] = [];
      for (const line of raw) {
        wrapped.push(...wrapTextWithAnsi(safeJobText(line), Math.max(1, inner)).slice(0, 300 - wrapped.length));
        if (wrapped.length === 300) break;
      }
      if (wrapped.length === 300) wrapped[299] = "… details omitted (300-line limit)";
      this.offset = Math.min(this.offset, Math.max(0, wrapped.length - this.pageRows));
      lines.push(...wrapped.slice(this.offset, this.offset + this.pageRows));
      lines.push(this.theme.fg("dim", `↑↓ / PgUp PgDn Scroll · ${this.offset + 1}-${Math.min(wrapped.length, this.offset + this.pageRows)}/${wrapped.length}`));
    } else {
      const displayed = jobs.filter(j => !this.finishedOnly || !j.active);
      const signature = JSON.stringify([this.pageRows, displayed]);
      if (signature !== this.signature) {
        const selected = this.selected ?? this.list?.getSelectedItem()?.value;
        this.list = new SelectList(displayed.map(j => ({ value: jobKey(j), label: `${jobHeading(j)} · …${safeJobText(j.jobId).slice(-6)}`, description: `${safeJobText(j.activity, 256)} · ${usageLabel(j, true)}` })), Math.max(1, this.pageRows - 1), {
          selectedPrefix: s => this.theme.fg("accent", s), selectedText: s => this.theme.fg("accent", s), description: s => this.theme.fg("dim", s), scrollInfo: s => this.theme.fg("dim", s), noMatch: s => this.theme.fg("dim", s),
        });
        const index = displayed.findIndex(j => jobKey(j) === selected);
        this.list.setSelectedIndex(Math.max(0, index));
        this.list.onSelect = item => { this.detailKey = item.value; this.offset = 0; this.refresh(); };
        this.list.onCancel = () => this.done();
        this.signature = signature;
        this.selected = this.list.getSelectedItem()?.value;
      }
      lines.push(...this.list!.render(inner));
    }
    const footer = this.theme.fg("dim", this.detailKey ? "Esc Back · Ctrl+C Close" : "↑↓ Select · Enter Details · Tab Finished/All · Esc Close");
    const content = (contentRows === 1 ? [footer] : [this.theme.fg("accent", title), ...lines.slice(0, bodyRows), footer]).map(s => truncateToWidth(s, inner, "…", true));
    if (!bordered) return content.map(s => truncateToWidth(s, width));
    const border = (s: string) => this.theme.fg("border", s);
    return [border(`╭${"─".repeat(inner)}╮`), ...content.map(s => `${border("│")}${s}${border("│")}`), border(`╰${"─".repeat(inner)}╯`)];
  }
}
