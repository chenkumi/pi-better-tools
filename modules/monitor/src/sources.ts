import WebSocket from 'ws';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { execMonitorCommand } from '../../shell-tools/src/monitor-exec.js';
import type { ReadonlyJobLease } from '../../shell-tools/src/monitor-capability.js';
import { LineParser, preview } from './lines.js';
import { prepareEndpoint, pinnedOptions, type Endpoint, type NetworkSource } from './network.js';
import { realClock, type Clock, type Launch } from './core.js';
export function commandLaunch(pi: ExtensionAPI, ctx: ExtensionContext, source: { tool: 'bash' | 'powershell'; command: string }): Launch {
  return async (sink, signal) => {
    const parser = new LineParser((text, partial) => sink.data(text, partial), reason => sink.fault(reason));
    try {
      await execMonitorCommand(pi, ctx, source.tool, source.command, signal, {
        stdout: chunk => parser.push(chunk), stderr: chunk => sink.stderr(chunk), started: () => sink.started(),
        closed: (code, closeSignal, spawnError) => { parser.end(); sink.closed({ sourceClosed: true, ...(code !== null ? { exitCode: code } : {}), ...(closeSignal ? { signal: closeSignal } : {}), spawnError, processTreeState: 'unknown' }, spawnError || code !== 0); },
      });
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
          if (!['queued', 'running', 'cancelling', 'starting', 'finalizing'].includes(snapshot.status as string)) { close(); return; }
          timer = clock.set(sample, intervalMs);
        } catch { sink.fault('source_error'); close(); }
      };
      signal.addEventListener('abort', close, { once: true }); if (signal.aborted) { close(); return; } sink.started(); sample();
    });
  };
}
