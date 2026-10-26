import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, SelectList, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import { TranscriptView, type TranscriptSource } from "./live-transcript.js";
import { stripVTControlCharacters } from "node:util";

export type PanelKind = "subagents" | "shell" | "fork" | "monitor";
/** Hover target of the "More…" label; job rows use their {@link jobKey}. */
export const MORE_HOVER = "more";
export type UsageState = "pending" | "reported" | "unknown" | "na";
export interface PanelUsage { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number }
/** One task of a concurrent batch. `transcript` exists only while that task runs. */
export interface PanelTask { id: string; label: string; state: string; activity: string; details: string[]; transcript?: TranscriptSource }
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
  /** Right-hand column of the one-row panel entry; defaults to `state | usage`. */
  summary?: string;
  /** Live in-memory copies of running jobs (one per child task or one output tail); dropped by the owner at the terminal state. */
  transcripts?: readonly { label: string; transcript: TranscriptSource }[];
  /** Present for concurrent batches (two or more tasks): the viewer lists them and opens one at a time. */
  tasks?: readonly PanelTask[];
}
/** Change fingerprint for the panel: live copies are summarised by version, never serialized. */
export const panelSignature = (jobs: readonly PanelJob[]) => JSON.stringify(jobs.map(job => job.transcripts?.length || job.tasks?.length
  ? { ...job, transcripts: job.transcripts?.map(t => [t.label, t.transcript.version, t.transcript.isReleased]),
    tasks: job.tasks?.map(t => ({ ...t, transcript: t.transcript && [t.transcript.version, t.transcript.isReleased] })) }
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
  return `${icon} ${job.kind === "shell" ? "SH" : job.kind === "fork" ? "FK" : job.kind === "monitor" ? "MN" : "SA"} ${safeJobText(job.label, 64)}${job.title ? ` · ${safeJobText(job.title, 256)}` : ""}`;
}
const rowUsage = (job: PanelJob) => job.usageState === "na" ? "N/A"
  : job.usage && job.usageState === "reported" ? `${formatJobTokens(job.usage.totalTokens)}${job.active ? "*" : ""}`
    : job.usageState === "unknown" ? "unknown" : "pending";
/** Right-hand column of a panel row. A running Shell job only has "N/A" to say, so its state is left out. */
export function jobSummary(job: PanelJob): string {
  if (job.summary !== undefined) return safeJobText(job.summary, 128);
  const usage = rowUsage(job);
  return job.kind === "shell" && job.state === "running" ? usage : `${safeJobText(job.state, 32)} | ${usage}`;
}
/** One row per job, so the budget is rows left after editor/footer/chat, capped at five jobs. */
const panelJobLimit = (terminalRows: number) => Math.min(5, Math.max(0, Math.floor(terminalRows - 10)));
/** The jobs renderJobs draws, in row order: job i owns physical row 1 + i, between the heading row and the More row. */
export function displayedJobs(jobs: readonly PanelJob[], terminalRows = 40): PanelJob[] {
  return orderedJobs(jobs.filter(j => j.active)).slice(0, panelJobLimit(terminalRows));
}
/** Five JOBS total, one physical row each. `hover` is a {@link jobKey} or {@link MORE_HOVER}; it only recolours, never changes the row layout. */
export function renderJobs(jobs: readonly PanelJob[], theme: Theme, width: number, terminalRows = 40, hover?: string): string[] {
  width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const active = orderedJobs(jobs.filter(j => j.active));
  if (!active.length) return [];
  const limit = panelJobLimit(terminalRows);
  const padding = width >= 3 ? 1 : 0, inner = width - padding * 2;
  const count = (kind: PanelKind) => active.filter(j => j.kind === kind).length, fork = count("fork"), monitor = count("monitor");
  // The highlight ends in the default background, so the panel background is restored for the cells after it.
  const highlight = (line: string) => {
    const bg = theme.getBgAnsi("selectedBg");
    return theme.bg("selectedBg", line.replace(/\x1b\[(?:0)?m/g, reset => reset + bg)) + theme.getBgAnsi("toolPendingBg");
  };
  const lines = [theme.fg("accent", truncateToWidth(`Jobs · ${active.length} active · Subagents ${count("subagents")} / Shell ${count("shell")}${fork ? ` / Fork ${fork}` : ""}${monitor ? ` / Monitor ${monitor}` : ""}`, inner))];
  for (const job of active.slice(0, limit)) {
    const summary = inner >= 40 ? truncateToWidth(jobSummary(job), Math.floor(inner / 2)) : "";
    const gap = summary ? 2 : 0;
    const heading = truncateToWidth(jobHeading(job), Math.max(0, inner - visibleWidth(summary) - gap));
    const row = theme.fg(job.state === "cancelling" ? "warning" : "accent", heading + " ".repeat(Math.max(0, inner - visibleWidth(heading) - visibleWidth(summary)))) + theme.fg("dim", summary);
    lines.push(hover === jobKey(job) ? highlight(row) : row);
  }
  const omitted = Math.max(0, active.length - limit);
  const more = truncateToWidth(`More…${omitted ? ` (+${omitted} active)` : ""} · click a job to open · /background-jobs more · * reported usage`, inner);
  // Only the "More…" label is a click target, so only it lights up.
  lines.push(hover === MORE_HOVER && more.startsWith("More…") ? highlight(theme.fg("accent", "More…")) + theme.fg("dim", more.slice("More…".length)) : theme.fg("dim", more));
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
  /** Second level for concurrent batches: the opened task, and the cursor while the task list is shown. */
  private taskKey?: string;
  private taskCursor?: string;
  constructor(private source: () => PanelJob[], private theme: Theme, private requestRender: () => void, private done: () => void, private height: () => number, private tui?: TUI, private cwd = process.cwd(), initialDetail?: string) { this.detailKey = initialDetail; }
  invalidate() { this.list?.invalidate(); }
  refresh() { if (!this.disposed) this.requestRender(); }
  dispose() { this.disposed = true; this.dropViews(); }
  private dropViews() { for (const off of this.unsubscribe.splice(0)) off(); this.views.clear(); this.subscribed = undefined; this.subscribedSources = []; }
  private isBatch(job?: PanelJob): job is PanelJob & { tasks: readonly PanelTask[] } { return !!job?.tasks && job.tasks.length > 1; }
  private taskLines(job: PanelJob, width: number): string[] {
    const tasks = job.tasks ?? [], running = tasks.filter(t => t.state === "running").length;
    const index = Math.max(0, tasks.findIndex(t => t.id === this.taskCursor));
    const rows = Math.max(1, this.pageRows - 1), start = Math.max(0, Math.min(index - Math.floor(rows / 2), tasks.length - rows));
    const lines = [this.theme.fg("dim", truncateToWidth(`${tasks.length} concurrent tasks · ${running} running`, width))];
    for (const [i, t] of tasks.slice(start, start + rows).entries()) {
      const selected = start + i === index, icon = t.state === "running" ? "●" : t.state === "queued" ? "◷" : t.state === "completed" ? "✓" : "○";
      const live = t.transcript && !t.transcript.isReleased ? " · live" : "";
      const text = truncateToWidth(`${selected ? "▸" : " "} ${icon} ${safeJobText(t.label, 64)} · ${safeJobText(t.state)}${live} · ${safeJobText(t.activity, 256)}`, width);
      lines.push(selected ? this.theme.fg("accent", text) : text);
    }
    return lines;
  }
  private detailHasLive() {
    const job = this.source().find(j => jobKey(j) === this.detailKey);
    return !!this.tui && !!job?.transcripts?.some(t => !t.transcript.isReleased);
  }
  /** Live lines for a running job; undefined when there is no live copy (use metadata). */
  private conversation(job: PanelJob, width: number, task?: PanelTask): string[] | undefined {
    const live = (task ? (task.transcript ? [{ label: task.label, transcript: task.transcript }] : []) : job.transcripts ?? []).filter(t => !t.transcript.isReleased);
    if (!this.tui || !live.length) { if (this.subscribed) this.dropViews(); return; }
    this.liveLabel = live.every(t => t.transcript.mode === "output") ? "Live output (memory copy)" : "Live conversation (memory copy)";
    // Identity, not list position: the panel list is compacted, so a different task's copy can sit at the same index.
    const sources = live.map(t => t.transcript), key = jobKey(job) + (task ? `/${task.id}` : "");
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
      // Inside one task of a batch, Esc goes back to the task list so a sibling can be picked.
      if (this.detailKey && this.taskKey) { this.taskKey = undefined; this.offset = 0; this.fromEnd = 0; this.metadata = false; this.liveDetail = false; this.dropViews(); this.refresh(); return; }
      if (this.detailKey && this.detailHasLive()) { this.done(); return; }
      if (this.detailKey) { this.detailKey = undefined; this.taskKey = undefined; this.taskCursor = undefined; this.offset = 0; this.fromEnd = 0; this.metadata = false; this.liveDetail = false; this.expanded = false; this.dropViews(); this.refresh(); } else this.done(); return; }
    if (matchesKey(data, "tab") && !this.detailKey) { this.finishedOnly = !this.finishedOnly; this.signature = undefined; this.selected = undefined; this.refresh(); return; }
    const current = this.detailKey ? this.source().find(j => jobKey(j) === this.detailKey) : undefined;
    if (this.isBatch(current) && !this.taskKey) {
      const tasks = current.tasks, index = Math.max(0, tasks.findIndex(t => t.id === this.taskCursor));
      if (matchesKey(data, "up")) this.taskCursor = tasks[Math.max(0, index - 1)]!.id;
      else if (matchesKey(data, "down")) this.taskCursor = tasks[Math.min(tasks.length - 1, index + 1)]!.id;
      else if (matchesKey(data, "pageUp")) this.taskCursor = tasks[Math.max(0, index - this.pageRows)]!.id;
      else if (matchesKey(data, "pageDown")) this.taskCursor = tasks[Math.min(tasks.length - 1, index + this.pageRows)]!.id;
      else if (matchesKey(data, "enter")) { this.taskKey = tasks[index]!.id; this.offset = 0; this.fromEnd = 0; this.metadata = false; }
      this.refresh(); return;
    }
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
    let listing = false;
    if (this.detailKey) {
      const job = jobs.find(j => jobKey(j) === this.detailKey);
      const batch = this.isBatch(job), task = batch && this.taskKey ? job.tasks.find(t => t.id === this.taskKey) : undefined;
      if (this.taskKey && !task) this.taskKey = undefined; // that task is no longer retained: fall back to the list
      listing = batch && !task;
      title = !job ? "Job no longer retained" : task ? `Task · ${safeJobText(task.label, 64)}` : batch ? `Job details · ${safeJobText(job.label, 64)} · ${job.tasks.length} concurrent tasks` : `Job details · ${safeJobText(job.label, 64)}`;
      const raw = task ? [`${task.label} · ${task.state}`, `Activity: ${task.activity}`, ...task.details.slice(0, 256), ...(task.details.length > 256 ? ["… metadata fields omitted (256-field limit)"] : []), ...(job?.state === "cancelling" ? ["Job cancel requested; that is not proof the task or its process tree has exited."] : []), "Retained metadata only; no logs read."] : job ? [jobHeading(job), `Job ID: ${safeJobText(job.jobId)}`, `State: ${safeJobText(job.state)} · ${safeJobText(job.activity)}`, usageLabel(job), ...job.details.slice(0, 256), ...(job.details.length > 256 ? ["… metadata fields omitted (256-field limit)"] : []), "Retained metadata only; no logs read. Cancel requested is not proof of process-tree exit."] : ["This job is no longer retained in this session/runtime."];
      const chat = job && !this.metadata && !listing ? this.conversation(job, Math.max(1, inner), task) : undefined;
      this.liveDetail = !!chat;
      if (!job) this.dropViews();
      const wrapped: string[] = [];
      if (listing) lines.push(...this.taskLines(job!, Math.max(1, inner)));
      else if (chat) {
        const maxFromEnd = Math.max(0, chat.length - this.pageRows);
        this.fromEnd = Math.min(this.fromEnd, maxFromEnd);
        const end = chat.length - this.fromEnd;
        lines.push(...chat.slice(Math.max(0, end - this.pageRows), end));
        lines.push(this.theme.fg("dim", `${this.liveLabel} · Ctrl+O Expand · ↑↓ PgUp PgDn Scroll · End Follow · ${this.fromEnd ? `${this.fromEnd} rows above end` : "following"}`));
      } else for (const line of raw) {
        wrapped.push(...wrapTextWithAnsi(safeJobText(line), Math.max(1, inner)).slice(0, 300 - wrapped.length));
        if (wrapped.length === 300) break;
      }
      if (!chat && !listing) {
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
        this.list.onSelect = item => { this.detailKey = item.value; this.taskKey = undefined; this.taskCursor = undefined; this.offset = 0; this.fromEnd = 0; this.metadata = false; this.refresh(); };
        this.list.onCancel = () => this.done();
        this.signature = signature;
        this.selected = this.list.getSelectedItem()?.value;
      }
      lines.push(...this.list!.render(inner));
    }
    const footer = this.theme.fg("dim", this.detailKey ? [!this.taskKey && this.detailHasLive() ? "Esc Close" : "Esc Back", ...(listing ? ["↑↓ Select", "Enter Open"] : []), ...(this.liveDetail || this.metadata ? ["m Conversation/Metadata"] : []), ...(this.liveDetail ? ["Ctrl+O Expand"] : []), "Ctrl+C Close"].join(" · ") : "↑↓ Select · Enter Details · Tab Finished/All · Esc Close");
    const content = (contentRows === 1 ? [footer] : [this.theme.fg("accent", title), ...lines.slice(0, bodyRows), footer]).map(s => truncateToWidth(s, inner, "…", true));
    if (!bordered) return content.map(s => truncateToWidth(s, width));
    const border = (s: string) => this.theme.fg("border", s);
    return [border(`╭${"─".repeat(inner)}╮`), ...content.map(s => `${border("│")}${s}${border("│")}`), border(`╰${"─".repeat(inner)}╯`)];
  }
}
