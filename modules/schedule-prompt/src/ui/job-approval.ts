import { CronScheduler } from '../scheduler.js';
import { validateJobDeadline } from '../deadline.js';
import { defaultCommandShell, DEFAULT_COMMAND_TIMEOUT_MS } from '../command.js';
import type { CronStorage } from '../storage.js';
import { isCommandJob, type CronJob } from '../types.js';

/** Execution identity, not mutable run statistics. Include binding and kind in UI compare-and-toggle. */
export function approvalSpec(job: CronJob): string {
  return JSON.stringify([job.id, job.session ?? null, job.enabled, job.name, job.type, job.schedule,
    job.intervalMs ?? null, job.endAt ?? null, job.shell ?? null, job.cwd ?? null,
    job.timeoutMs ?? null, job.command ?? null, job.prompt ?? null]);
}

export function toggleReviewedJob(storage: CronStorage, scheduler: CronScheduler, reviewed: CronJob, session: string | undefined): void {
  const expected = approvalSpec(reviewed);
  let stored: CronJob | undefined;
  storage.updateJobWith(reviewed.id, latest => {
    if (!CronScheduler.isLoadedFor(latest, session) || approvalSpec(latest) !== expected) return undefined;
    if (!latest.enabled) validateJobDeadline(latest);
    stored = { ...latest, enabled: !latest.enabled };
    return { enabled: stored.enabled };
  });
  if (!stored) throw new Error('Job changed or was removed while approval was pending. Review its current definition and try again.');
  if (stored.enabled && isCommandJob(stored)) {
    let failure: Error | undefined;
    try {
      if (!scheduler.approveCommand(stored)) failure = new Error('Command directory is no longer available');
    } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
    if (failure) {
      scheduler.removeJob(stored.id); // Stop local scheduling even if the compensating store write fails.
      const savedSpec = approvalSpec(stored);
      let rolledBack = false;
      try {
        rolledBack = storage.updateJobWith(stored.id, latest => approvalSpec(latest) === savedSpec ? { enabled: false } : undefined);
      } catch { /* An enable was saved; do not misreport an unconfirmed rollback as disabled. */ }
      throw new Error(`Command was not approved; local scheduling stopped. ${rolledBack ? 'Enable rolled back.' : 'Enable was saved but rollback is unconfirmed; inspect the persisted job before reloading.'} ${failure.message}`);
    }
  }
  scheduler.updateJob(stored.id, stored);
}

/** Escape controls rather than allowing terminal codes/bidi to hide part of the approved spec. */
const shown = (value: string) => JSON.stringify(value).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
  c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
export function commandApprovalText(job: CronJob): string {
  return [
    `Name: ${shown(job.name)}`,
    `Schedule: ${job.type} ${shown(job.schedule)}`,
    `Deadline: ${job.endAt === undefined ? '(none)' : shown(job.endAt)}`,
    `Session: ${job.session === undefined ? '(shared)' : shown(job.session)}`,
    `Shell: ${job.shell ?? defaultCommandShell()}`,
    `Directory: ${job.cwd === undefined ? '(project)' : shown(job.cwd)}`,
    `Stall timeout: ${job.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS} ms`,
    `Command: ${shown(job.command ?? '')}`,
  ].join('\n');
}
