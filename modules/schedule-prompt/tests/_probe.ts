// Test-only probe extension for Schedule Prompt defect reproductions. Offline; writes only to files named by env vars.
// REPRO_EVENTS: jsonl of session_start/session_shutdown (with session id). REPRO_TIMER_LOG: jsonl of setInterval creations.
import { appendFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  const events = process.env.REPRO_EVENTS, timers = process.env.REPRO_TIMER_LOG;
  if (timers && !(globalThis as any).__reproSetIntervalPatched) {
    (globalThis as any).__reproSetIntervalPatched = true;
    const original = globalThis.setInterval;
    (globalThis as any).setInterval = function (fn: any, ms?: number, ...rest: any[]) {
      const stack = String(new Error().stack);
      appendFileSync(timers, JSON.stringify({ ms, widgetTimer: /cron-widget/.test(stack) }) + '\n');
      return (original as any)(fn, ms, ...rest);
    };
  }
  const write = (type: string, reason: string, ctx: any) => {
    if (events) appendFileSync(events, JSON.stringify({ type, reason, sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, trusted: ctx.isProjectTrusted?.() }) + '\n');
  };
  pi.on('session_start', async (e: any, ctx: any) => write('start', e.reason, ctx));
  pi.on('session_shutdown', async (e: any, ctx: any) => write('shutdown', e.reason, ctx));
}
