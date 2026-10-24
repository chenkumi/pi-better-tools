import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, SelectList, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import { TranscriptView, type TranscriptSource } from "./live-transcript.js";
import { stripVTControlCharacters } from "node:util";

export type PanelKind = "subagents" | "shell" | "fork";
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
  /** Live in-memory copies of running jobs (one per child task or one output tail); dropped by the owner at the terminal state. */
  transcripts?: readonly { label: string; transcript: TranscriptSource }[];
}
/** Change fingerprint for the panel: live copies are summarised by version, never serialized. */
export const panelSignature = (jobs: readonly PanelJob[]) => JSON.stringify(jobs.map(job => job.transcripts?.length
  ? { ...job, transcripts: job.transcripts.map(t => [t.label, t.transcript.version, t.transcript.isReleased]) }
  : job));
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
  return `${icon} ${job.kind === "shell" ? "SH" : job.kind === "fork" ? "FK" : "SA"} ${safeJobText(job.label, 64)}${job.title ? ` · ${safeJobText(job.title, 256)}` : ""}`;
}
const panelJobLimit = (terminalRows: number) => Math.min(5, Math.max(0, Math.floor((terminalRows - 10) / 2)));
/** The jobs renderJobs draws, in row order: job i owns physical rows 1 + 2i (heading) and 2 + 2i (activity). */
export function displayedJobs(jobs: readonly PanelJob[], terminalRows = 40): PanelJob[] {
  return orderedJobs(jobs.filter(j => j.active)).slice(0, panelJobLimit(terminalRows));
}
/** Five JOBS total, two physical rows each. Small terminals reserve space for editor/footer/chat. */
export function renderJobs(jobs: readonly PanelJob[], theme: Theme, width: number, terminalRows = 40): string[] {
  width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const active = orderedJobs(jobs.filter(j => j.active));
  if (!active.length) return [];
  const limit = panelJobLimit(terminalRows);
  const padding = width >= 3 ? 1 : 0, inner = width - padding * 2;
  const sub = active.filter(j => j.kind === "subagents").length, fork = active.filter(j => j.kind === "fork").length;
  const lines = [theme.fg("accent", truncateToWidth(`Jobs · ${active.length} active · Subagents ${sub} / Shell ${active.length - sub - fork}${fork ? ` / Fork ${fork}` : ""}`, inner))];
  for (const job of active.slice(0, limit)) {
    const suffix = width >= 40 ? `  …${safeJobText(job.jobId, 256).slice(-6)}` : "";
    const heading = truncateToWidth(jobHeading(job), Math.max(0, inner - visibleWidth(suffix)));
    lines.push(theme.fg("accent", heading + " ".repeat(Math.max(0, inner - visibleWidth(heading) - visibleWidth(suffix)))) + theme.fg("dim", suffix));
    const usage = usageLabel(job, width < 80), activity = safeJobText(job.activity, 256);
    const text = inner >= 28 ? `${truncateToWidth(activity, Math.max(0, inner - visibleWidth(usage) - 5))} · ${usage}` : `${activity} · ${usage}`;
    lines.push(theme.fg(job.state === "cancelling" ? "warning" : "dim", truncateToWidth(`  ${text}`, inner)));
  }
  const omitted = Math.max(0, active.length - limit);
  lines.push(theme.fg("dim", truncateToWidth(`More…${omitted ? ` (+${omitted} active)` : ""} · click a job to open · /background-jobs more · * reported usage`, inner)));
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
  private metadata = false;
  private liveDetail = false;
  private liveLabel = "Live conversation (memory copy)";
  private expanded = false;
  private fromEnd = 0;
  private views = new Map<TranscriptSource, TranscriptView>();
  private unsubscribe: Array<() => void> = [];
  private subscribed?: string;
  private subscribedSources: readonly TranscriptSource[] = [];
  constructor(private source: () => PanelJob[], private theme: Theme, private requestRender: () => void, private done: () => void, private height: () => number, private tui?: TUI, private cwd = process.cwd(), initialDetail?: string) { this.detailKey = initialDetail; }
  invalidate() { this.list?.invalidate(); }
  refresh() { if (!this.disposed) this.requestRender(); }
  dispose() { this.disposed = true; this.dropViews(); }
  private dropViews() { for (const off of this.unsubscribe.splice(0)) off(); this.views.clear(); this.subscribed = undefined; this.subscribedSources = []; }
  private detailHasLive() {
    const job = this.source().find(j => jobKey(j) === this.detailKey);
    return !!this.tui && !!job?.transcripts?.some(t => !t.transcript.isReleased);
  }
  /** Live lines for a running job; undefined when there is no live copy (use metadata). */
  private conversation(job: PanelJob, width: number): string[] | undefined {
    const live = (job.transcripts ?? []).filter(t => !t.transcript.isReleased);
    if (!this.tui || !live.length) { if (this.subscribed) this.dropViews(); return; }
    this.liveLabel = live.every(t => t.transcript.mode === "output") ? "Live output (memory copy)" : "Live conversation (memory copy)";
    // Identity, not list position: the panel list is compacted, so a different task's copy can sit at the same index.
    const sources = live.map(t => t.transcript), key = jobKey(job);
    if (this.subscribed !== key || sources.length !== this.subscribedSources.length || sources.some((source, i) => source !== this.subscribedSources[i])) {
      this.dropViews();
      this.subscribed = key; this.subscribedSources = sources;
      for (const { transcript } of live) {
        this.views.set(transcript, new TranscriptView(transcript, this.tui, this.cwd, this.expanded));
        this.unsubscribe.push(transcript.subscribe(() => this.refresh()));
      }
    }
    const lines: string[] = [];
    for (const { label, transcript } of live) {
      if (live.length > 1) lines.push(this.theme.fg("accent", `── ${safeJobText(label, 64)} ──`));
      lines.push(...this.views.get(transcript)!.render(width));
    }
    return lines;
  }
  handleInput(data: string) {
    if (this.disposed) return;
    if (matchesKey(data, "ctrl+c")) { this.done(); return; }
    if (matchesKey(data, "escape")) {
      // A running job's live view replaces the list: Esc closes the whole overlay. Metadata-only details still go back to the list.
      if (this.detailKey && this.detailHasLive()) { this.done(); return; }
      if (this.detailKey) { this.detailKey = undefined; this.offset = 0; this.fromEnd = 0; this.metadata = false; this.liveDetail = false; this.expanded = false; this.dropViews(); this.refresh(); } else this.done(); return; }
    if (matchesKey(data, "tab") && !this.detailKey) { this.finishedOnly = !this.finishedOnly; this.signature = undefined; this.selected = undefined; this.refresh(); return; }
    if (this.detailKey && (this.liveDetail || this.metadata) && (data === "m" || data === "M")) { this.metadata = !this.metadata; this.offset = 0; this.fromEnd = 0; this.refresh(); return; }
    if (this.detailKey && this.liveDetail && matchesKey(data, "ctrl+o")) {
      // Same key as the host's "Toggle tool output": tool cards in the live view render at their own expansion state.
      this.expanded = !this.expanded;
      for (const view of this.views.values()) view.setExpanded(this.expanded);
      this.refresh(); return;
    }
    if (this.detailKey && this.liveDetail) {
      if (matchesKey(data, "up")) this.fromEnd++;
      else if (matchesKey(data, "down")) this.fromEnd = Math.max(0, this.fromEnd - 1);
      else if (matchesKey(data, "pageUp")) this.fromEnd += this.pageRows;
      else if (matchesKey(data, "pageDown")) this.fromEnd = Math.max(0, this.fromEnd - this.pageRows);
      else if (matchesKey(data, "end")) this.fromEnd = 0;
      this.refresh(); return;
    }
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
      const chat = job && !this.metadata ? this.conversation(job, Math.max(1, inner)) : undefined;
      this.liveDetail = !!chat;
      if (!job) this.dropViews();
      const wrapped: string[] = [];
      if (chat) {
        const maxFromEnd = Math.max(0, chat.length - this.pageRows);
        this.fromEnd = Math.min(this.fromEnd, maxFromEnd);
        const end = chat.length - this.fromEnd;
        lines.push(...chat.slice(Math.max(0, end - this.pageRows), end));
        lines.push(this.theme.fg("dim", `${this.liveLabel} · Ctrl+O Expand · ↑↓ PgUp PgDn Scroll · End Follow · ${this.fromEnd ? `${this.fromEnd} rows above end` : "following"}`));
      } else for (const line of raw) {
        wrapped.push(...wrapTextWithAnsi(safeJobText(line), Math.max(1, inner)).slice(0, 300 - wrapped.length));
        if (wrapped.length === 300) break;
      }
      if (!chat) {
        if (wrapped.length === 300) wrapped[299] = "… details omitted (300-line limit)";
        this.offset = Math.min(this.offset, Math.max(0, wrapped.length - this.pageRows));
        lines.push(...wrapped.slice(this.offset, this.offset + this.pageRows));
        lines.push(this.theme.fg("dim", `↑↓ / PgUp PgDn Scroll · ${this.offset + 1}-${Math.min(wrapped.length, this.offset + this.pageRows)}/${wrapped.length}`));
      }
    } else {
      const displayed = jobs.filter(j => !this.finishedOnly || !j.active);
      const signature = JSON.stringify([this.pageRows, panelSignature(displayed)]);
      if (signature !== this.signature) {
        const selected = this.selected ?? this.list?.getSelectedItem()?.value;
        this.list = new SelectList(displayed.map(j => ({ value: jobKey(j), label: `${jobHeading(j)} · …${safeJobText(j.jobId).slice(-6)}`, description: `${safeJobText(j.activity, 256)} · ${usageLabel(j, true)}` })), Math.max(1, this.pageRows - 1), {
          selectedPrefix: s => this.theme.fg("accent", s), selectedText: s => this.theme.fg("accent", s), description: s => this.theme.fg("dim", s), scrollInfo: s => this.theme.fg("dim", s), noMatch: s => this.theme.fg("dim", s),
        });
        const index = displayed.findIndex(j => jobKey(j) === selected);
        this.list.setSelectedIndex(Math.max(0, index));
        this.list.onSelect = item => { this.detailKey = item.value; this.offset = 0; this.fromEnd = 0; this.metadata = false; this.refresh(); };
        this.list.onCancel = () => this.done();
        this.signature = signature;
        this.selected = this.list.getSelectedItem()?.value;
      }
      lines.push(...this.list!.render(inner));
    }
    const footer = this.theme.fg("dim", this.detailKey ? [this.detailHasLive() ? "Esc Close" : "Esc Back", ...(this.liveDetail || this.metadata ? ["m Conversation/Metadata"] : []), ...(this.liveDetail ? ["Ctrl+O Expand"] : []), "Ctrl+C Close"].join(" · ") : "↑↓ Select · Enter Details · Tab Finished/All · Esc Close");
    const content = (contentRows === 1 ? [footer] : [this.theme.fg("accent", title), ...lines.slice(0, bodyRows), footer]).map(s => truncateToWidth(s, inner, "…", true));
    if (!bordered) return content.map(s => truncateToWidth(s, width));
    const border = (s: string) => this.theme.fg("border", s);
    return [border(`╭${"─".repeat(inner)}╮`), ...content.map(s => `${border("│")}${s}${border("│")}`), border(`╰${"─".repeat(inner)}╯`)];
  }
}
