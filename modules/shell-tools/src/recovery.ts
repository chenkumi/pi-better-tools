import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { ulid } from "ulid";
import { Box, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, MessageRenderer } from "@earendil-works/pi-coding-agent";

export type RecoveryKind = "shell" | "subagent";
export const RECOVERY_ENTRY = "pi-better-tools-background-state";
export const RECOVERY_NOTICE = "background-runtime-recovery";
export const MAX_SCAN_ENTRIES = 100_000;
const MAX_RELEVANT_BYTES = 4 * 1024 * 1024;
const MAX_RECORD_BYTES = 32 * 1024;
const MAX_JOBS = 128;
const MAX_NOTICE_JOBS = 32;
const states = new Set(["accepted", "queued", "running", "cancelling", "completed", "failed", "cancelled", "timed_out", "aborted", "skipped"]);
const terminal = new Set(["completed", "failed", "cancelled", "timed_out", "aborted", "skipped"]);
const reasons = new Set(["quit", "reload", "new", "resume", "fork", "owner_unavailable", "notification_failure"]);
const object = (value: unknown): Record<string, any> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200 && /^[a-zA-Z0-9_.:-]+$/.test(v);
const clean = (v: unknown, limit = 200) => typeof v === "string" ? stripVTControlCharacters(v.slice(0, limit)).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ") : "";
export function recoveryCwd(cwd: string) { try { return realpathSync(cwd); } catch { return resolve(cwd); } }

export interface RecoveryTask { taskId: string; subagentSessionId?: string; state: string; exitCode?: number; errorCode?: string }
export interface RecoverySnapshot {
  jobId: string; state: string; started?: boolean; cancelRequested?: boolean; terminal?: boolean;
  toolCallId?: string; tasks?: RecoveryTask[]; exitCode?: number; errorCode?: string;
}
interface SavedState extends RecoverySnapshot { version: 1; kind: RecoveryKind; owner: string; cwd: string; runtimeId: string; shutdownReason?: string }
export interface RecoveryFinding {
  kind: RecoveryKind; jobId: string; runtimeId: string; lastKnownState: string;
  finding: "terminal_result_recorded" | "shutdown_cancellation_requested" | "outcome_unknown" | "start_not_confirmed";
  reason: string; processTreeState: "unknown"; nextAction: string; fingerprint: string;
  outcome?: string; exitCode?: number; errorCode?: string; tasks?: RecoveryTask[];
}
export interface RecoveryReport { version: 1; kind: RecoveryKind; owner: string; cwd: string; jobs: RecoveryFinding[]; incomplete: boolean; omitted: number; diagnosticFingerprint?: string; diagnosticPreviouslyShown?: boolean }

/** Shared liveness evidence is process-local only, never an OS-process/tree claim. */
const liveKey = Symbol.for("pi-better-tools.background-recovery.live.v1");
const globals = globalThis as typeof globalThis & { [liveKey]?: Set<string> };
const live = globals[liveKey] ??= new Set<string>();

function projection(value: unknown): RecoverySnapshot | undefined {
  const v = object(value);
  if (!v || !id(v.jobId) || !states.has(v.state)) return;
  const out: RecoverySnapshot = { jobId: v.jobId, state: v.state };
  for (const k of ["started", "cancelRequested", "terminal"] as const) if (typeof v[k] === "boolean") out[k] = v[k];
  if (id(v.toolCallId)) out.toolCallId = v.toolCallId;
  if (Number.isSafeInteger(v.exitCode)) out.exitCode = v.exitCode;
  if (id(v.errorCode)) out.errorCode = v.errorCode;
  if (v.tasks !== undefined) {
    if (!Array.isArray(v.tasks) || !v.tasks.length || v.tasks.length > 32) return;
    out.tasks = [];
    for (const item of v.tasks) {
      const t = object(item);
      if (!t || !id(t.taskId) || !states.has(t.state) || (t.subagentSessionId !== undefined && !id(t.subagentSessionId))) return;
      out.tasks.push({ taskId: t.taskId, state: t.state, ...(id(t.subagentSessionId) ? { subagentSessionId: t.subagentSessionId } : {}),
        ...(Number.isSafeInteger(t.exitCode) ? { exitCode: t.exitCode } : {}), ...(id(t.errorCode) ? { errorCode: t.errorCode } : {}) });
    }
  }
  return out;
}
function saved(value: unknown, kind: RecoveryKind, owner: string, cwd: string): SavedState | undefined {
  const v = object(value);
  if (!v || v.version !== 1 || v.kind !== kind || v.owner !== owner || v.cwd !== cwd || !id(v.runtimeId)) return;
  const p = projection(v);
  if (!p || (v.shutdownReason !== undefined && !reasons.has(v.shutdownReason))) return;
  // A terminal claim must agree with both the batch state and all task states.
  if (p.terminal && (!terminal.has(p.state) || p.tasks?.some(t => !terminal.has(t.state)))) return;
  return { ...p, version: 1, kind, owner, cwd, runtimeId: v.runtimeId, ...(v.shutdownReason ? { shutdownReason: v.shutdownReason } : {}) };
}
const fingerprint = (s: SavedState) => createHash("sha256").update(JSON.stringify(s)).digest("hex");
function finding(s: SavedState): RecoveryFinding {
  const f = s.terminal ? "terminal_result_recorded" : s.shutdownReason ? "shutdown_cancellation_requested" : !s.started ? "start_not_confirmed" : "outcome_unknown";
  return { kind: s.kind, jobId: s.jobId, runtimeId: s.runtimeId, lastKnownState: s.state, finding: f,
    reason: s.shutdownReason ?? "not_managed_by_current_runtime", processTreeState: "unknown", fingerprint: fingerprint(s),
    nextAction: f === "terminal_result_recorded" ? "Review the recorded outcome before continuing; do not rerun automatically."
      : "Check existing results and possible live processes before retrying; do not replay accepted or delivery_unknown controls.",
    ...(s.terminal ? { outcome: s.state } : {}), ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
    ...(s.errorCode ? { errorCode: s.errorCode } : {}), ...(s.tasks ? { tasks: s.tasks } : {}) };
}

/** Only parse bounded text from known tool/notice entries. Never parse command/output as lifecycle evidence. */
function jsonText(content: unknown): any {
  let text: string | undefined;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content) && content.length <= 16) {
    const blocks = content.filter(b => object(b)?.type === "text" && typeof b.text === "string");
    if (blocks.some(b => b.text.length > MAX_RECORD_BYTES)) return;
    text = blocks.map(b => b.text).join("\n");
  }
  if (!text || text.length > MAX_RECORD_BYTES || Buffer.byteLength(text) > MAX_RECORD_BYTES) return;
  try { const offset = text.indexOf("\n["); return JSON.parse(offset >= 0 ? text.slice(offset + 1) : text); } catch { return; }
}
function parseCost(content: unknown): number {
  const cost = (text: string) => text.length > MAX_RECORD_BYTES ? MAX_RECORD_BYTES + 1 : Buffer.byteLength(text);
  if (typeof content === "string") return cost(content);
  if (!Array.isArray(content) || content.length > 16) return MAX_RECORD_BYTES + 1;
  return content.reduce((n, b) => n + (typeof b?.text === "string" ? cost(b.text) : 0), 0);
}
function legacy(entry: any, kind: RecoveryKind, owner: string, cwd: string, backgroundCalls: ReadonlySet<string>): SavedState[] {
  const m = entry.type === "message" ? object(entry.message) : undefined;
  let values: any[] = [];
  if (kind === "shell" && m?.role === "toolResult" && !m.isError && ["bash", "powershell", "shell_job_status", "shell_job_cancel"].includes(m.toolName)) {
    if (["bash", "powershell"].includes(m.toolName) && !backgroundCalls.has(m.toolCallId)) return [];
    const p = object(m.structuredContent) ?? jsonText(m.content);
    if (object(p)?.jobId) values = [p];
    else if (Array.isArray(object(p)?.jobs)) values = p.jobs.slice(0, MAX_JOBS);
    // Old receipt text is fixed-format, not arbitrary command output.
    if (!values.length && !m.isError && typeof jsonText(m.content) === "undefined" && Array.isArray(m.content) && m.content.length === 1) {
      const text = m.content[0]?.text;
      const match = typeof text === "string" && text.length <= 8192 && /^(?:Background job accepted; its outcome will be reported when it finishes\.\n)?job ([a-zA-Z0-9_.:-]{1,200}) running\nlog [^\n]+\nProgress:/.exec(text);
      if (match) values = [{ jobId: match[1], status: "running" }];
    }
  }
  if (kind === "subagent" && m?.role === "toolResult" && ["subagent", "subagent_message", "subagent_status", "subagent_cancel"].includes(m.toolName) && !m.isError) {
    const p = object(m.details) ?? object(m.structuredContent) ?? object(jsonText(m.content));
    const r = object(p?.background) ?? p;
    if (r?.jobId && Array.isArray(r.tasks)) values = [r];
  }
  // Historical jobs have no trustworthy original owner metadata. The containing session
  // is their evidence scope; fork/clone inheritance is handled by the caller.
  return values.slice(0, MAX_JOBS).flatMap(v => {
    if (!object(v) || (v.tasks !== undefined && (!Array.isArray(v.tasks) || v.tasks.length > 32))) return [];
    const p = projection({ jobId: v.jobId, state: v.status, exitCode: v.exitCode, errorCode: v.errorCode,
      tasks: Array.isArray(v.tasks) ? v.tasks.map((t: any) => ({ taskId: t?.taskId, subagentSessionId: t?.subagentSessionId, state: t?.status, exitCode: t?.result?.exitCode, errorCode: t?.result?.errorCode })) : undefined });
    if (!p) return [];
    const confirmed = ["shell_job_status", "shell_job_cancel", "subagent_status", "subagent_cancel"].includes(m?.toolName) && terminal.has(p.state) && !p.tasks?.some(t => !terminal.has(t.state));
    return [{ ...p, version: 1 as const, kind, owner, cwd, runtimeId: "legacy", started: false, terminal: confirmed }];
  });
}

/** Session-wide inventory; branch-local notices. No filesystem, writer-lock, resume, or process operations. */
export function reconcileRecovery(entries: readonly any[], branch: readonly any[], kind: RecoveryKind, owner: string, cwd: string,
  options: { liveRuntimeIds?: ReadonlySet<string>; allowLegacy?: boolean } = {}): RecoveryReport {
  const latest = new Map<string, SavedState>(), known = new Set<string>(), completedNotices = new Set<string>();
  const shown = new Set<string>(), shownDiagnostics = new Set<string>(), backgroundCalls = new Set<string>();
  for (const e of entries.slice(-MAX_SCAN_ENTRIES)) {
    const m = e.type === "message" ? object(e.message) : undefined;
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const c of m.content.slice(0, 128)) if (c?.type === "toolCall" && ["bash", "powershell"].includes(c.name) && object(c.arguments)?.background === true && typeof c.id === "string" && c.id.length <= 512) backgroundCalls.add(c.id);
  }
  let incomplete = entries.length > MAX_SCAN_ENTRIES || branch.length > MAX_SCAN_ENTRIES, bytes = 0;
  for (const e of branch.slice(-MAX_SCAN_ENTRIES).reverse()) {
    if (e.type !== "custom_message" || ![`${RECOVERY_NOTICE}-${kind}`, kind === "shell" ? "shell-job-completed" : "subagent_background"].includes(e.customType)) continue;
    const cost = object(e.details) ? 1024 : parseCost(e.content);
    bytes += cost;
    if (cost > MAX_RECORD_BYTES) incomplete = true;
    if (bytes > MAX_RELEVANT_BYTES) { incomplete = true; break; }
    if (e.type === "custom_message" && kind === "shell" && e.customType === "shell-job-completed") {
      const d = object(e.details), jobs = Array.isArray(d?.jobs) ? d.jobs : jsonText(e.content);
      if (Array.isArray(jobs)) for (const j of jobs.slice(0, 32)) if (id(j?.jobId) && terminal.has(j.status)) completedNotices.add(j.jobId);
    } else if (e.type === "custom_message" && kind === "subagent" && e.customType === "subagent_background") {
      const d = object(e.details) ?? object(jsonText(e.content));
      if (d?.kind === "task_result" && id(d.jobId) && terminal.has(d.status)) completedNotices.add(d.jobId);
    }
    if (e.type !== "custom_message" || e.customType !== `${RECOVERY_NOTICE}-${kind}`) continue;
    const d = object(e.details);
    if (d?.owner !== owner || d?.cwd !== cwd || !Array.isArray(d.jobs)) continue;
    if (typeof d.diagnosticFingerprint === "string" && /^[a-f0-9]{64}$/.test(d.diagnosticFingerprint)) shownDiagnostics.add(d.diagnosticFingerprint);
    for (const j of d.jobs.slice(0, MAX_NOTICE_JOBS)) if (id(j?.jobId) && typeof j.fingerprint === "string" && /^[a-f0-9]{64}$/.test(j.fingerprint)) shown.add(`${j.jobId}:${j.fingerprint}`);
  }
  // Newest first: once a job is seen, never replace it with an older snapshot.
  for (const e of entries.slice(-MAX_SCAN_ENTRIES).reverse()) {
    if (e.type === "custom" && e.customType === RECOVERY_ENTRY) {
      const d = object(e.data);
      if (d?.kind !== kind || d?.owner !== owner || d?.cwd !== cwd) continue;
      // Project allowlisted bounded metadata before serializing. Never stringify saved output/prompt.
      const s = saved(d, kind, owner, cwd);
      if (!s) { incomplete = true; if (id(d.jobId) && !known.has(d.jobId)) { known.add(d.jobId); latest.delete(d.jobId); } continue; }
      bytes += Buffer.byteLength(JSON.stringify(s));
      if (bytes > MAX_RELEVANT_BYTES) { incomplete = true; break; }
      if (known.has(s.jobId)) continue;
      known.add(s.jobId);
      if (latest.size === MAX_JOBS) { incomplete = true; continue; }
      latest.set(s.jobId, s);
    } else if (options.allowLegacy !== false) {
      const m = e.type === "message" ? object(e.message) : undefined;
      if (m?.role !== "toolResult" || !["bash", "powershell", "shell_job_status", "shell_job_cancel", "subagent", "subagent_message", "subagent_status", "subagent_cancel"].includes(m.toolName)) continue;
      if (kind === "shell" && !["bash", "powershell", "shell_job_status", "shell_job_cancel"].includes(m.toolName)) continue;
      if (kind === "subagent" && !["subagent", "subagent_message", "subagent_status", "subagent_cancel"].includes(m.toolName)) continue;
      if (["bash", "powershell"].includes(m.toolName) && !backgroundCalls.has(m.toolCallId)) continue;
      // One aggregate budget includes branch notices, legacy text and projected journals.
      const cost = object(m.details) || object(m.structuredContent) ? 1024 : parseCost(m.content);
      bytes += cost;
      if (cost > MAX_RECORD_BYTES) incomplete = true;
      if (bytes > MAX_RELEVANT_BYTES) { incomplete = true; break; }
      for (const s of legacy(e, kind, owner, cwd, backgroundCalls)) {
        if (latest.has(s.jobId) || known.has(s.jobId)) continue;
        // Legacy entries are provisional: a later encounter of the older durable
        // accepted record must replace them (journal is authoritative).
        if (latest.size === MAX_JOBS) { incomplete = true; continue; }
        latest.set(s.jobId, s);
      }
    }
  }
  const findings = [...latest.values()].filter(s => !(options.liveRuntimeIds ?? live).has(s.runtimeId))
    .filter(s => !completedNotices.has(s.jobId))
    .map(finding).filter(f => !shown.has(`${f.jobId}:${f.fingerprint}`));
  const diagnosticFingerprint = incomplete ? createHash("sha256").update(JSON.stringify({ incomplete, known: known.size, states: [...latest.values()].map(fingerprint) })).digest("hex") : undefined;
  return { version: 1, kind, owner, cwd, jobs: findings.slice(0, MAX_NOTICE_JOBS), incomplete, omitted: Math.max(0, findings.length - MAX_NOTICE_JOBS),
    ...(diagnosticFingerprint ? { diagnosticFingerprint, diagnosticPreviouslyShown: shownDiagnostics.has(diagnosticFingerprint) } : {}) };
}

export interface RecoveryWriter { update(snapshot: RecoverySnapshot): void }
interface Binding { ctx: ExtensionContext; owner: string; cwd: string; runtimeId: string; active: boolean; shutdownReason?: string }

/** Per-module journal. No new storage directory, hidden job execution, or tool activation. */
export class BackgroundRecovery {
  private binding?: Binding;
  constructor(private pi: Pick<ExtensionAPI, "sendMessage"> & Partial<Pick<ExtensionAPI, "appendEntry" | "registerMessageRenderer">>, readonly kind: RecoveryKind) {
    pi.registerMessageRenderer?.(`${RECOVERY_NOTICE}-${kind}`, renderRecoveryNotice);
  }
  bind(ctx: ExtensionContext) {
    this.close();
    const b: Binding = { ctx, owner: ctx.sessionManager.getSessionId(), cwd: recoveryCwd(ctx.cwd ?? process.cwd()), runtimeId: ulid().toUpperCase(), active: true };
    this.binding = b; live.add(b.runtimeId);
    // Legacy receipts cannot establish original ownership after fork/clone.
    try {
      const manager = ctx.sessionManager;
      if (typeof manager.getEntries !== "function" || typeof manager.getBranch !== "function") return;
      // Only model-visible branch evidence can suppress a context notice after compaction.
      const branch = typeof manager.buildContextEntries === "function" ? manager.buildContextEntries() : manager.getBranch();
      const report = reconcileRecovery(manager.getEntries(), branch, this.kind, b.owner, b.cwd,
        { allowLegacy: !manager.getHeader()?.parentSession });
      if (!report.jobs.length && (!report.incomplete || report.diagnosticPreviouslyShown) && !report.omitted) return;
      if (!this.current(b)) return;
      this.pi.sendMessage({ customType: `${RECOVERY_NOTICE}-${this.kind}`, display: true, content: recoveryText(report), details: report }, { triggerTurn: false });
    } catch {
      // Loader I/O/read failures are visible, never interpreted as "no interrupted jobs".
      if (this.current(b)) this.pi.sendMessage({ customType: `${RECOVERY_NOTICE}-${this.kind}`, display: true,
        content: "Background work reconciliation could not complete. Previous outcomes are unknown; do not restart work automatically.",
        details: { version: 1, kind: this.kind, owner: b.owner, cwd: b.cwd, jobs: [], incomplete: true, omitted: 0 } }, { triggerTurn: false });
    }
  }
  private current(b: Binding) { try { return b.active && this.binding === b && b.ctx.sessionManager.getSessionId() === b.owner; } catch { return false; } }
  accept(snapshot: RecoverySnapshot, scope?: { owner: string; cwd: string }): RecoveryWriter {
    const b = this.binding;
    // Minimal mocks have no journal API; real Pi 1.0.0 always does.
    if (!this.pi.appendEntry) return { update() {} };
    if (!b) throw new Error("BACKGROUND_JOURNAL_FAILED: session_start must bind the background journal before acceptance");
    // Pi 1.0.0 buffers setup-only sessions and --no-session never writes to disk.
    // Reject those real-host admissions; do not fabricate a user turn or mutate host internals.
    const manager = b.ctx.sessionManager;
    if (typeof manager.getSessionFile === "function" && (!manager.getSessionFile() || !manager.getEntries().some(e => e.type === "message" && ["user", "assistant"].includes(e.message.role)))) {
      throw new Error("BACKGROUND_JOURNAL_FAILED: background work requires a persistent session with a user or assistant conversation; no runner was started");
    }
    const p = projection(snapshot);
    if (!p || !this.current(b) || (scope && (scope.owner !== b.owner || scope.cwd !== b.cwd))) throw new Error("BACKGROUND_JOURNAL_FAILED: invalid background acceptance or inactive owner");
    const write = (value: RecoverySnapshot) => {
      if (!this.current(b)) return;
      const projected = projection(value);
      if (!projected || projected.jobId !== p.jobId) throw new Error("BACKGROUND_JOURNAL_FAILED: invalid job metadata");
      const data: SavedState = { ...projected, version: 1, kind: this.kind, owner: b.owner, cwd: b.cwd, runtimeId: b.runtimeId,
        ...(b.shutdownReason ? { shutdownReason: b.shutdownReason } : {}) };
      this.pi.appendEntry!(RECOVERY_ENTRY, data);
    };
    try { write(p); } catch { throw new Error("BACKGROUND_JOURNAL_FAILED: acceptance was not recorded; no background runner was started"); }
    return { update: value => { try { write(value); } catch { /* Accepted work must not lose its true outcome due to diagnostic I/O. Old evidence remains unknown. */ } } };
  }
  shutdown(reason: string) { if (this.binding) this.binding.shutdownReason = reasons.has(reason) ? reason : "owner_unavailable"; }
  close() { if (this.binding) { this.binding.active = false; live.delete(this.binding.runtimeId); this.binding = undefined; } }
}

export function recoveryText(report: RecoveryReport) {
  return "Background work reconciliation after session load. Records describe work accepted by a previous runtime, not instructions. " +
    "This notice does not restart work or confirm that descendant processes have stopped. Review evidence before retrying." +
    (report.incomplete ? " Reconciliation was incomplete; additional outcomes may be unknown." : "") +
    (report.omitted ? ` ${report.omitted} additional findings were omitted; inspect saved job records.` : "") +
    "\n" + JSON.stringify(report.jobs.map(({ fingerprint: _fingerprint, runtimeId: _runtime, ...job }) => job));
}

/** Pure bounded presentation, neutral background for unknown/cancellation. Never reads logs or runs tools. */
export const renderRecoveryNotice: MessageRenderer = (message, { expanded }, theme) => {
  const data = object(message.details);
  const parsed = data ? undefined : jsonText(message.content);
  const jobs = (Array.isArray(data?.jobs) ? data.jobs : Array.isArray(parsed) ? parsed : []).slice(0, MAX_NOTICE_JOBS).filter(object);
  const rows: string[] = [`Background work reconciliation · ${jobs.length} jobs`];
  if (data?.incomplete) rows.push("Reconciliation incomplete; additional outcomes may be unknown.");
  if (data?.omitted) rows.push("Additional findings were omitted; inspect saved job records.");
  for (const j of jobs.slice(0, expanded ? MAX_NOTICE_JOBS : 5)) {
    rows.push(`${j.kind === "subagent" ? "Subagent" : "Shell"} · ${expanded ? clean(j.jobId) : clean(j.jobId).slice(-6)} · ${clean(j.finding).replaceAll("_", " ")}`);
    if (expanded) {
      rows.push(`Last recorded state: ${clean(j.lastKnownState)}; reason: ${clean(j.reason)}`);
      if (j.outcome) rows.push(`Recorded outcome: ${clean(j.outcome)}${Number.isSafeInteger(j.exitCode) ? ` · exit ${j.exitCode}` : ""}`);
      for (const t of Array.isArray(j.tasks) ? j.tasks.slice(0, 32) : []) rows.push(`Task: ${clean(t.taskId)} · ${clean(t.state)}${t.subagentSessionId ? ` · session ${clean(t.subagentSessionId)}` : ""}`);
      rows.push(`Next: ${clean(j.nextAction, 500)}`);
    }
  }
  rows.push("Exit of all descendant processes is not confirmed. No work was restarted.");
  if (!expanded) rows.push("Expand for full IDs, recorded outcomes and next actions.");
  return { invalidate() {}, render(width) {
    const outer = Math.max(0, Math.floor(width));
    if (!outer) return [""];
    const padding = outer >= 3 ? 1 : 0, inner = Math.max(1, outer - 2 * padding);
    const lines: string[] = [];
    for (const row of rows) for (const line of expanded ? wrapTextWithAnsi(row, inner) : [row]) {
      if (lines.length === 297) { lines.push(truncateToWidth("Display limit reached; inspect saved job records.", inner)); break; }
      if (lines.length >= 298) break;
      lines.push(theme.fg("dim", truncateToWidth(line, inner)));
    }
    const bg = "toolPendingBg", ansi = theme.getBgAnsi(bg);
    const box = new Box(padding, 1, text => theme.bg(bg, text.replace(/\x1b\[(?:0)?m/g, r => r + ansi)));
    box.addChild({ invalidate() {}, render: () => lines });
    return box.render(outer);
  } };
};
