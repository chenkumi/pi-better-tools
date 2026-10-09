import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { BackgroundJobs } from './background.ts';
import { resultSummary } from './result.ts';
import { canonicalMonitorCwd, publishCapability } from '../../../shell-tools/src/monitor-capability.js';
function record(v: unknown): Record<string, unknown> { return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}; }
function bounded(value: unknown, bytes = 200) { if (typeof value !== 'string') return undefined; const raw = Buffer.from(value.slice(0, bytes)); let end = Math.min(raw.length, bytes); while (end > 0 && (raw[end]! & 0xc0) === 0x80) end--; return raw.subarray(0, end).toString('utf8'); }
function cleanup(value: unknown) { const v = record(value), out: Record<string, unknown> = {}; for (const key of ['childClosed', 'ioSettled', 'temporaryRemoved', 'originalLeaseReleased']) if (typeof v[key] === 'boolean') out[key] = v[key]; return out; }
function asOf(value: unknown) {
  const v = record(value), out: Record<string, unknown> = {};
  for (const key of ['entryId', 'sourceLeafId', 'timestamp', 'capturedAt']) { const text = bounded(v[key], 80); if (text !== undefined) out[key] = text; else if (typeof v[key] === 'number' && Number.isFinite(v[key])) out[key] = v[key]; }
  for (const key of ['stale', 'pendingToolCount']) if (typeof v[key] === 'boolean' || typeof v[key] === 'number') out[key] = v[key];
  return out;
}
/** Must call get(): its view enforces ready-query provisional worker/original-lease protection. */
export function subagentMonitorSnapshot(jobs: BackgroundJobs, id: string, owner: string, cwd: string): Record<string, unknown> {
  const view = jobs.get(id, owner, cwd);
  return { jobId: view.jobId, status: view.status, cancelRequested: view.cancelRequested,
    tasks: view.tasks.slice(0, 32).map(task => {
      const result = record(task.result), query = record(task.queries?.at(-1));
      const pending = query.cleanupPending === true || result.cleanupPending === true;
      const summary = !task.readOnlyQuery && !['queued', 'running'].includes(task.status) ? resultSummary(result, 200) : '';
      return { taskId: task.taskId, status: task.status, ...(typeof task.canMessage === 'boolean' ? { canMessage: task.canMessage } : {}), ...(task.readOnlyQuery ? { readOnlyQuery: true } : {}),
        ...(summary ? { summary: bounded(summary) } : {}), ...(typeof result.exitCode === 'number' ? { exitCode: result.exitCode } : {}),
        ...(typeof result.errorCode === 'string' ? { errorCode: bounded(result.errorCode, 80) } : {}),
        ...(typeof query.cleanupPending === 'boolean' || typeof result.cleanupPending === 'boolean' ? { cleanupPending: pending, cleanupEvidence: cleanup(query.cleanupEvidence ?? result.cleanupEvidence) } : {}),
        ...(query.asOf ? { asOf: asOf(query.asOf) } : {}),
      };
    }), asOf: Date.now(), partial: view.tasks.length > 32 };
}
export function publishSubagentMonitor(jobs: BackgroundJobs, ctx: ExtensionContext): () => void {
  const scope = { sessionId: ctx.sessionManager.getSessionId(), cwd: canonicalMonitorCwd(ctx.cwd) }, epoch = jobs.epoch;
  return publishCapability('subagent_job', scope, epoch, id => subagentMonitorSnapshot(jobs, id, scope.sessionId, scope.cwd), () => {
    try { return jobs.epoch === epoch && ctx.sessionManager.getSessionId() === scope.sessionId && canonicalMonitorCwd(ctx.cwd) === scope.cwd; } catch { return false; }
  });
}
