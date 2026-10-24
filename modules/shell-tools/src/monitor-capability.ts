import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
export interface MonitorScope { sessionId: string; cwd: string }
export type JobKind = 'shell_job' | 'subagent_job' | 'fork_job';
export interface ReadonlyJobLease { readonly generation: number; snapshot(jobId: string): Record<string, unknown> }
/** Id and status only: no command, task text, output, usage or paths. */
export interface ActiveJobBrief { kind: JobKind; jobId: string; status: string }
interface Provider { kind: JobKind; scope: MonitorScope; generation: number; read: (id: string) => Record<string, unknown>; valid: () => boolean; revoked: boolean; active?: () => number; briefs?: () => ActiveJobBrief[] }
// Narrow capability rendezvous, not an extension factory/plugin manager. Never store executable job handles.
const key = Symbol.for('pi-better-tools.monitor.readonly-jobs.v1');
const root = globalThis as unknown as Record<symbol, Map<string, Provider>>;
function registry() { return root[key] ??= new Map(); }
export function canonicalMonitorCwd(cwd: string) { return realpathSync(resolve(cwd)); }
function identity(kind: JobKind, scope: MonitorScope) { return JSON.stringify([kind, scope.sessionId, scope.cwd]); }
export function publishCapability(kind: JobKind, scope: MonitorScope, generation: number, read: Provider['read'], valid: Provider['valid'], active?: () => number, briefs?: () => ActiveJobBrief[]): () => void {
  const id = identity(kind, scope), providers = registry();
  const old = providers.get(id); if (old) old.revoked = true;
  if (!old && providers.size >= 64) throw new Error('Monitor capability capacity exceeded');
  const provider: Provider = { kind, scope: { ...scope }, generation, read, valid, revoked: false, ...(active ? { active } : {}), ...(briefs ? { briefs } : {}) }; providers.set(id, provider);
  return () => { provider.revoked = true; if (providers.get(id) === provider) providers.delete(id); };
}
export function acquireCapability(kind: JobKind, scope: MonitorScope): ReadonlyJobLease {
  const id = identity(kind, scope), provider = registry().get(id);
  const assert = () => { if (!provider || provider.revoked || registry().get(id) !== provider || !provider.valid()) throw new Error('Monitor readonly adapter unavailable or owner/cwd/generation mismatch: the observing module is not registered for this session, or the session/cwd was replaced. Re-run monitor_start in the current session while that module is loaded.'); };
  assert();
  return Object.freeze({ generation: provider!.generation, snapshot(jobId: string) { assert(); const value = provider!.read(jobId); assert(); return value; } });
}
/** Default sampling interval for the Monitor that Shell requests for background jobs without timeoutMs. */
export const AUTO_MONITOR_INTERVAL_MS = 180000;
export type AutoMonitorStarter = (jobId: string) => string | undefined;
// Same rendezvous style as the readonly capability: Shell asks, an installed Monitor decides. No handles are shared.
const autoKey = Symbol.for('pi-better-tools.monitor.auto-shell-job.v1');
const autoRoot = globalThis as unknown as Record<symbol, Map<string, AutoMonitorStarter>>;
const autoRegistry = () => autoRoot[autoKey] ??= new Map();
export function publishAutoMonitor(scope: MonitorScope, starter: AutoMonitorStarter): () => void {
  const id = identity('shell_job', scope), starters = autoRegistry();
  starters.set(id, starter);
  return () => { if (starters.get(id) === starter) starters.delete(id); };
}
/** Best effort: returns the monitorId when an owner-matching Monitor accepted the job, otherwise undefined. Never throws. */
export function requestAutoMonitor(scope: MonitorScope, jobId: string): string | undefined {
  try { return autoRegistry().get(identity('shell_job', scope))?.(jobId); } catch { return undefined; }
}
/** Count-only bridge for a Fork process to learn whether its own Shell/Subagent jobs are still unfinished. No handles, no output, no cancellation. */
export function activeJobCounts(scope: MonitorScope): { shell: number; subagents: number } {
  const counts = { shell: 0, subagents: 0 };
  for (const [kind, field] of [['shell_job', 'shell'], ['subagent_job', 'subagents']] as const) {
    const provider = registry().get(identity(kind, scope));
    if (!provider || provider.revoked || !provider.active) continue;
    try { if (provider.valid()) counts[field] = Math.max(0, Math.floor(provider.active())); } catch { /* unavailable provider reports no jobs */ }
  }
  return counts;
}
/** Source kind, state, coarse target, optional user label and remaining lifetime only: no command text, URL path, output or event data. */
export interface ActiveMonitorBrief { monitorId: string; source: string; state: string; target: string; label?: string; remainingMs: number }
export const MAX_ACTIVE_MONITOR_BRIEFS = 16;
// Monitor publishes its own live receipts here; readers get a plain list, never the runtime or a stop/start handle.
const activeMonitorKey = Symbol.for('pi-better-tools.monitor.active-monitors.v1');
const activeMonitorRoot = globalThis as unknown as Record<symbol, Map<string, () => ActiveMonitorBrief[]>>;
const activeMonitorReaders = () => activeMonitorRoot[activeMonitorKey] ??= new Map();
const monitorIdentity = (scope: MonitorScope) => JSON.stringify([scope.sessionId, scope.cwd]);
export function publishActiveMonitorBriefs(scope: MonitorScope, read: () => ActiveMonitorBrief[]): () => void {
  const id = monitorIdentity(scope), readers = activeMonitorReaders();
  readers.set(id, read);
  return () => { if (readers.get(id) === read) readers.delete(id); };
}
/** Readonly live-monitor list for a model-facing reminder. Never throws; malformed rows or a failing reader only mark the result partial. */
export function activeMonitorBriefs(scope: MonitorScope): { briefs: ActiveMonitorBrief[]; partial: boolean } {
  const read = activeMonitorReaders().get(monitorIdentity(scope));
  if (!read) return { briefs: [], partial: false };
  try {
    const rows = read();
    if (!Array.isArray(rows)) return { briefs: [], partial: true };
    // Every field is re-checked here: the reader is owner code, but the summary text is model-facing.
    const briefs = rows.filter(row => row && typeof row.monitorId === 'string' && typeof row.source === 'string' && typeof row.state === 'string' && typeof row.target === 'string' && Number.isFinite(row.remainingMs));
    return { briefs: briefs.slice(0, MAX_ACTIVE_MONITOR_BRIEFS), partial: briefs.length !== rows.length || rows.length > MAX_ACTIVE_MONITOR_BRIEFS };
  } catch { return { briefs: [], partial: true }; }
}
const MAX_BRIEFS_PER_KIND = 16;
/** Readonly list of this owner's unfinished jobs for a model-facing reminder. Never throws; a failing provider only marks the result partial. */
export function activeJobBriefs(scope: MonitorScope): { briefs: ActiveJobBrief[]; partial: boolean } {
  const briefs: ActiveJobBrief[] = []; let partial = false;
  for (const kind of ['shell_job', 'subagent_job', 'fork_job'] as const) {
    const provider = registry().get(identity(kind, scope));
    if (!provider || provider.revoked || !provider.briefs) continue;
    try {
      if (!provider.valid()) continue;
      const rows = provider.briefs();
      if (rows.length > MAX_BRIEFS_PER_KIND) partial = true;
      for (const row of rows.slice(0, MAX_BRIEFS_PER_KIND)) briefs.push({ kind, jobId: String(row.jobId).slice(0, 128), status: String(row.status).slice(0, 32) });
    } catch { partial = true; }
  }
  return { briefs, partial };
}
