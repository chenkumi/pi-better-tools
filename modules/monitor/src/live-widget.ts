import type { PanelHost } from '../../shell-tools/src/background-panel.js';
import { safeJobText, type PanelJob } from '../../shell-tools/src/job-view.js';
import { JobsWidgetBinding } from '../../shell-tools/src/widget-binding.js';
import type { Clock, MonitorPanelRow } from './core.js';

/** The remaining-time column only changes by the minute; twice a minute keeps it within 30 s of the truth. */
export const PANEL_REFRESH_MS = 30_000;

export function remainingLabel(ms: number): string {
  if (!(ms > 0)) return '剩 0m';
  if (ms < 60_000) return '剩 <1m';
  const minutes = Math.floor(ms / 60_000), hours = Math.floor(minutes / 60);
  return hours ? `剩 ${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}` : `剩 ${minutes}m`;
}

const time = (value?: number) => value === undefined ? 'n/a' : new Date(value).toISOString();

/** Plain projection of a retained Monitor. Never reads event text or stderr, and never owns the runtime. */
export function monitorPanelJob(row: MonitorPanelRow, now: number): PanelJob {
  const wake = `wake ${row.wakeAgent ? 'on' : 'off'}`;
  const ended = !['starting', 'running', 'stopping'].includes(row.state);
  // A source that has ended but whose close is unconfirmed still holds an active slot: say so instead of "completed".
  const summary = row.state === 'running' ? `${wake} | ${remainingLabel(row.deadline - now)}` : ended && row.active ? `${row.state} | cleanup pending` : `${row.state} | ${wake}`;
  const title = row.label ?? row.target;
  const details = [
    `Status: ${row.state}${row.stopReason ? ` (${row.stopReason})` : ''}`,
    `Monitor ID: ${row.id}`,
    `Source: ${row.source}`,
    `${row.source === 'command' ? 'Command' : row.source === 'websocket' ? 'Endpoint (origin only)' : 'File'}: ${row.target}`,
    ...(row.label ? [`Label: ${row.label}`] : []),
    ...(row.intervalMs !== undefined ? [`Sampling interval: ${row.intervalMs} ms`] : []),
    `Created: ${time(row.createdAt)}${row.startedAt !== undefined ? ` · Started: ${time(row.startedAt)}` : ''}${row.endedAt !== undefined ? ` · Ended: ${time(row.endedAt)}` : ''}`,
    `Deadline: ${time(row.deadline)}${row.state === 'running' ? ` · ${remainingLabel(row.deadline - now)}` : ''}`,
    `Wake agent: ${row.wakeAgent ? 'yes — submitted data requests a model turn' : 'no — display data only, no model turn requested'}`,
    `Events: adopted ${row.counts.adopted} · submitted ${row.counts.submitted} · omitted ${row.counts.omitted} · rejected ${row.counts.rejected} · buffered ${row.buffered}`,
    `Last event: ${time(row.lastEventAt)}`,
    `Notification: ${row.notification.state} · attempts ${row.notification.attempts} · host acknowledgment unknown`,
    `Cleanup: source ${row.cleanup.sourceClosed ? 'closed' : 'close NOT confirmed'}${row.cleanup.exitCode !== undefined ? ` · exit ${row.cleanup.exitCode}` : ''}${row.cleanup.signal ? ` · signal ${row.cleanup.signal}` : ''} · process tree state unknown`,
    'Use monitor_stop to stop it; this view is readonly. Stopping is a request, not proof that descendants have exited.',
  ];
  return {
    kind: 'monitor', jobId: row.id, label: row.source, title: safeJobText(title, 256), state: row.state, active: row.active,
    activity: `${row.state} · ${row.counts.submitted} submitted · ${row.counts.adopted} adopted`, usageState: 'na', startedAt: row.createdAt,
    summary, details: details.map(line => safeJobText(line, 512)),
  };
}

/** Binding-scoped, event-driven view of one session's non-job Monitors. A 30 s timer exists only while one is active, and only redraws. */
export class MonitorJobsWidget extends JobsWidgetBinding<MonitorPanelRow> {
  private timer?: unknown;
  constructor(private clock: Clock, api?: PanelHost) { super('monitor', rows => rows.map(row => monitorPanelJob(row, clock.now())), api); }
  override refresh() {
    super.refresh();
    if (this.lastJobs.some(job => job.active)) this.rearm(); else this.disarm();
  }
  override clear() {
    this.disarm();
    super.clear();
  }
  private disarm() {
    if (this.timer === undefined) return;
    try { this.clock.clear(this.timer); } catch { /* display only */ }
    this.timer = undefined;
  }
  private rearm() {
    if (this.timer !== undefined) return;
    this.timer = this.clock.set(() => { this.timer = undefined; this.refresh(); }, PANEL_REFRESH_MS);
    (this.timer as { unref?: () => void } | undefined)?.unref?.();
  }
}
