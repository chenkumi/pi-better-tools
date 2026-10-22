import { realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import WebSocket from 'ws';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { execMonitorCommand } from '../../shell-tools/src/monitor-exec.js';
import type { ReadonlyJobLease } from '../../shell-tools/src/monitor-capability.js';
import { LineParser, preview } from './lines.js';
import { prepareEndpoint, pinnedOptions, type Endpoint, type NetworkSource } from './network.js';
import { realClock, type Clock, type Launch } from './core.js';
/** Bounded settle for commands whose shell exits while a descendant keeps the pipes open (same values as Schedule Prompt).
 * exitIdleMs: shell exited and stdout/stderr stayed silent this long => report source closed (descendants may still run).
 * abortGraceMs: an abort before any output waits at most this long before the host kills the tree. */
const COMMAND_ABORT_GRACE_MS = 500, COMMAND_EXIT_IDLE_MS = 250;
export function commandLaunch(pi: ExtensionAPI, ctx: ExtensionContext, source: { tool: 'bash' | 'powershell'; command: string }): Launch {
  return async (sink, signal) => {
    const parser = new LineParser((text, partial) => sink.data(text, partial), reason => sink.fault(reason));
    try {
      await execMonitorCommand(pi, ctx, source.tool, source.command, signal, {
        stdout: chunk => parser.push(chunk), stderr: chunk => sink.stderr(chunk), started: () => sink.started(),
        closed: (code, closeSignal, spawnError) => { parser.end(); sink.closed({ sourceClosed: true, ...(code !== null ? { exitCode: code } : {}), ...(closeSignal ? { signal: closeSignal } : {}), spawnError, processTreeState: 'unknown' }, spawnError || code !== 0); },
      }, undefined, { abortGraceMs: COMMAND_ABORT_GRACE_MS, exitIdleMs: COMMAND_EXIT_IDLE_MS });
    } catch { sink.fault('source_error'); sink.closed({ sourceClosed: true, startupFailed: true, processTreeState: 'unknown' }, true); }
  };
}
export function websocketLaunch(source: Endpoint | NetworkSource, clock: Clock = realClock): Launch {
  return async (sink, signal, deadline) => {
    let endpoint: Endpoint;
    let timer: unknown;
    try {
      if ('addresses' in source) endpoint = source;
      else endpoint = await new Promise<Endpoint>((resolve, reject) => {
        let settled = false;
        const finish = (value?: Endpoint) => { if (settled) return; settled = true; if (timer !== undefined) clock.clear(timer); signal.removeEventListener('abort', abort); value ? resolve(value) : reject(new Error('startup failed')); };
        const abort = () => finish();
        signal.addEventListener('abort', abort, { once: true }); timer = clock.set(() => finish(), Math.max(1, Math.min(15000, deadline - clock.now())));
        if (signal.aborted) finish(); else prepareEndpoint(source).then(value => finish(value), () => finish());
      });
      if (signal.aborted || clock.now() >= deadline) { sink.closed({ sourceClosed: true, startupCanceled: true }); return; }
    } catch { sink.fault('source_error'); sink.closed({ sourceClosed: true, startupFailed: true }, true); return; }
    await new Promise<void>(resolve => {
      let ws: WebSocket;
      try { ws = new WebSocket(endpoint.url, pinnedOptions(endpoint, deadline - clock.now())); }
      catch { sink.fault('source_error'); sink.closed({ sourceClosed: true, startupFailed: true }, true); resolve(); return; }
      let fault = false;
      const abort = () => ws.terminate();
      signal.addEventListener('abort', abort, { once: true });
      ws.once('open', () => { if (signal.aborted) abort(); else sink.started(); });
      ws.on('message', (raw, binary) => {
        if (signal.aborted) return;
        if (binary) { fault = true; sink.fault('unsupported_payload'); return; }
        const bytes = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
        // ws already enforced aggregate maxPayload before allocating/reassembling payload.
        if (bytes.length > 16384) { fault = true; sink.fault('payload_limit'); return; }
        sink.data(bytes.toString('utf8'));
      });
      ws.on('error', error => {
        fault = true; const code = (error as NodeJS.ErrnoException).code;
        sink.fault(code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' ? 'payload_limit' : 'source_error');
        // Error != close. Keep ownership until the actual transport close callback.
      });
      ws.once('close', (code, reason) => {
        signal.removeEventListener('abort', abort); ws.removeAllListeners('message');
        sink.closed({ sourceClosed: true, closeCode: code, closeReason: preview(reason.toString('utf8'), 123) }, fault || (code !== 1000 && code !== 1005 && !signal.aborted)); resolve();
      });
      if (signal.aborted) abort();
    });
  };
}
export function jobLaunch(lease: ReadonlyJobLease, jobId: string, intervalMs: number, clock: Clock = realClock): Launch {
  return async (sink, signal) => {
    let timer: unknown;
    await new Promise<void>(resolve => {
      let stopped = false;
      const close = () => { if (stopped) return; stopped = true; if (timer !== undefined) clock.clear(timer); signal.removeEventListener('abort', close); sink.closed({ sourceClosed: true, timerCleared: true, observedJobCanceled: false }); resolve(); };
      const sample = () => {
        if (stopped || signal.aborted) { close(); return; }
        try {
          const snapshot = lease.snapshot(jobId); sink.data(undefined, false, snapshot);
          if (signal.aborted) { close(); return; }
          // Stop only at a known terminal status; a new non-terminal status keeps sampling until the Monitor's own deadline.
          if (['completed', 'failed', 'aborted', 'cancelled', 'timed_out', 'interrupted'].includes(snapshot.status as string)) { close(); return; }
          timer = clock.set(sample, intervalMs);
        } catch { sink.fault('source_error'); close(); }
      };
      signal.addEventListener('abort', close, { once: true }); if (signal.aborted) { close(); return; } sink.started(); sample();
    });
  };
}
/** Metadata-only file source. Targets stay inside the canonical workspace root: a lexical check at acceptance, and a realpath check
 * on every sample, so a later symlink swap faults instead of leaking a path or stat from outside. Polling only (no fs.watch):
 * at most one event per tick keeps the 60 events/minute cap unreachable at the 1 s minimum interval. Content is never read. */
export interface FileTarget { absolute: string; relative: string }
type FileSignature = { exists: false } | { exists: true; sizeBytes: number; mtimeMs: number; ino: number };
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
/** Nearest existing ancestor must stay inside root even when the file itself does not exist yet (create detection). */
function locate(root: string, absolute: string): FileSignature {
  let real: string;
  try { real = realpathSync(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error;
    let parent = dirname(absolute), tail = relative(parent, absolute);
    for (;;) {
      try { if (!inside(root, join(realpathSync(parent), tail))) throw new Error('path_outside_workspace'); return { exists: false }; }
      catch (inner) { if ((inner as Error).message === 'path_outside_workspace') throw inner; const next = dirname(parent); if (next === parent) return { exists: false }; tail = relative(next, join(parent, tail)); parent = next; }
    }
  }
  if (!inside(root, real)) throw new Error('path_outside_workspace');
  const stat = statSync(real);
  if (!stat.isFile()) throw new Error('not_a_file');
  return { exists: true, sizeBytes: stat.size, mtimeMs: Math.floor(stat.mtimeMs), ino: stat.ino };
}
export function resolveFilePath(root: string, input: string): FileTarget {
  const absolute = resolve(root, input), rel = relative(root, absolute);
  if (rel === '') throw new Error('Path must name a file inside the workspace');
  if (!inside(root, absolute)) throw new Error('Path is outside the workspace');
  try { locate(root, absolute); }
  catch (error) {
    const reason = (error as Error).message;
    throw new Error(reason === 'path_outside_workspace' ? 'Path is outside the workspace' : reason === 'not_a_file' ? 'Path is not a regular file' : 'File path cannot be inspected');
  }
  return { absolute, relative: rel };
}
export function fileLaunch(root: string, target: FileTarget, intervalMs: number, clock: Clock = realClock): Launch {
  return async (sink, signal) => {
    let timer: unknown, previous: FileSignature;
    await new Promise<void>(resolveDone => {
      let stopped = false;
      const close = () => { if (stopped) return; stopped = true; if (timer !== undefined) clock.clear(timer); signal.removeEventListener('abort', close); sink.closed({ sourceClosed: true, timerCleared: true }); resolveDone(); };
      const sign = (): FileSignature | undefined => {
        try { return locate(root, target.absolute); }
        catch (error) { sink.fault((error as Error).message === 'path_outside_workspace' ? 'path_outside_workspace' : 'source_error'); close(); return undefined; }
      };
      const sample = () => {
        if (stopped || signal.aborted) { close(); return; }
        const next = sign(); if (!next) return;
        const change = !previous.exists && next.exists ? 'created' : previous.exists && !next.exists ? 'deleted'
          : previous.exists && next.exists && (previous.sizeBytes !== next.sizeBytes || previous.mtimeMs !== next.mtimeMs || previous.ino !== next.ino) ? 'modified' : undefined;
        previous = next;
        if (change) {
          sink.data(undefined, false, { path: target.relative, change, exists: next.exists, ...(next.exists ? { sizeBytes: next.sizeBytes, mtimeMs: next.mtimeMs } : {}) });
          if (signal.aborted) { close(); return; }
        }
        timer = clock.set(sample, intervalMs);
      };
      signal.addEventListener('abort', close, { once: true }); if (signal.aborted) { close(); return; }
      const baseline = sign(); if (!baseline) return;
      previous = baseline; sink.started(); timer = clock.set(sample, intervalMs);
    });
  };
}
