// Spike: the real, unmodified Fork child guard inside an interactive (PTY) Pi, with its IPC messages shimmed onto the side socket.
import { appendFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import guard from '../../modules/fork/src/child-guard.ts';
import { canonicalMonitorCwd, publishCapability } from '../../shared/src/background/index.ts';
import viewer from './viewer-ext.ts';

// Optional synchronous diagnostics (SPIKE_LOG=<file>): what the child saw, in order, even if it dies right after.
const L = (message: string) => { if (process.env.SPIKE_LOG) appendFileSync(process.env.SPIKE_LOG, `${Date.now() % 100000} ${message}\n`); };
const socketState = () => JSON.stringify((globalThis as any).__spikeSocketState?.());

export default function (pi: ExtensionAPI) {
  process.on('exit', code => L(`exit event code=${code} socket=${socketState()}`));
  const realExit = process.exit.bind(process);
  (process as any).exit = (code?: number) => {
    L(`process.exit(${code}) called from: ${new Error().stack?.split('\n').slice(2, 5).join(' | ')}`);
    if (process.env.SPIKE_NO_DRAIN) return realExit(code);
    // The guard exits right after sending `rejected`; a socket still connecting has not sent it yet. Wait for it to drain.
    const started = Date.now();
    const poll = setInterval(() => {
      const state = (globalThis as any).__spikeSocketState?.();
      if (!state || (!state.connecting && state.queued === 0) || Date.now() - started > 2000) { clearInterval(poll); L('draining done, exiting'); realExit(code); }
    }, 10);
    return undefined as never;
  };
  // A PTY child has no node IPC fd. The guard only needs `process.send` / `process.connected`, so route them to the side channel.
  if (typeof process.send !== 'function') {
    Object.defineProperty(process, 'connected', { value: true, configurable: true });
    (process as any).send = (message: unknown, callback?: (error: Error | null) => void) => {
      L(`send ${(message as any)?.type} socket=${socketState()}`);
      (globalThis as any).__spikeSend?.({ ipc: message });
      callback?.(null);
      return true;
    };
  }
  viewer(pi); // registers first, so its session_start opens the socket before the guard's verified message is sent
  guard(pi);
  // Stand-in for the child's own Shell module: publish a pending-job count into the same registry the guard reads (activeJobCounts).
  // The harness changes the count with a {type:'jobs', n} command.
  pi.on('session_start', (_event, ctx) => {
    publishCapability('shell_job', { sessionId: ctx.sessionManager.getSessionId(), cwd: canonicalMonitorCwd(ctx.cwd) }, 1, () => ({}), () => true, () => (globalThis as any).__spikeJobs ?? 0);
  });
}
