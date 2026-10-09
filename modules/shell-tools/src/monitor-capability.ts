import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
export interface MonitorScope { sessionId: string; cwd: string }
export type JobKind = 'shell_job' | 'subagent_job';
export interface ReadonlyJobLease { readonly generation: number; snapshot(jobId: string): Record<string, unknown> }
interface Provider { kind: JobKind; scope: MonitorScope; generation: number; read: (id: string) => Record<string, unknown>; valid: () => boolean; revoked: boolean }
// Narrow capability rendezvous, not an extension factory/plugin manager. Never store executable job handles.
const key = Symbol.for('pi-better-tools.monitor.readonly-jobs.v1');
const root = globalThis as unknown as Record<symbol, Map<string, Provider>>;
function registry() { return root[key] ??= new Map(); }
export function canonicalMonitorCwd(cwd: string) { return realpathSync(resolve(cwd)); }
function identity(kind: JobKind, scope: MonitorScope) { return JSON.stringify([kind, scope.sessionId, scope.cwd]); }
export function publishCapability(kind: JobKind, scope: MonitorScope, generation: number, read: Provider['read'], valid: Provider['valid']): () => void {
  const id = identity(kind, scope), providers = registry();
  const old = providers.get(id); if (old) old.revoked = true;
  if (!old && providers.size >= 64) throw new Error('Monitor capability capacity exceeded');
  const provider: Provider = { kind, scope: { ...scope }, generation, read, valid, revoked: false }; providers.set(id, provider);
  return () => { provider.revoked = true; if (providers.get(id) === provider) providers.delete(id); };
}
export function acquireCapability(kind: JobKind, scope: MonitorScope): ReadonlyJobLease {
  const id = identity(kind, scope), provider = registry().get(id);
  const assert = () => { if (!provider || provider.revoked || registry().get(id) !== provider || !provider.valid()) throw new Error('Monitor readonly adapter unavailable or owner/cwd/generation mismatch'); };
  assert();
  return Object.freeze({ generation: provider!.generation, snapshot(jobId: string) { assert(); const value = provider!.read(jobId); assert(); return value; } });
}
