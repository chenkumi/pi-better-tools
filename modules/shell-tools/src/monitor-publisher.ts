import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ShellJobs } from './background-jobs.js';
import { canonicalMonitorCwd, publishCapability } from './monitor-capability.js';
/** Composed into existing Shell lifecycle handlers: no extra execution/lifecycle dispatcher. */
export function createShellMonitorPublisher(jobs: ShellJobs) {
  let revoke: (() => void) | undefined;
  const stop = () => { revoke?.(); revoke = undefined; };
  return {
    stop,
    start(ctx: ExtensionContext) {
      stop();
      try {
        const scope = { sessionId: ctx.sessionManager.getSessionId(), cwd: canonicalMonitorCwd(ctx.cwd) }, epoch = jobs.monitorEpoch;
        revoke = publishCapability('shell_job', scope, epoch, id => jobs.monitorSnapshot(ctx, id, scope.cwd, epoch), () => {
          try { return jobs.monitorEpoch === epoch && ctx.sessionManager.getSessionId() === scope.sessionId && canonicalMonitorCwd(ctx.cwd) === scope.cwd; } catch { return false; }
        });
      } catch { /* Missing canonical scope makes only the optional readonly capability unavailable. */ }
    },
  };
}
