import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { BACKGROUND_WIDGET_KEY, type PanelHost } from "./background-panel.js";
import { JobsWidgetBinding } from "./widget-binding.js";
import { renderJobs, safeJobText, type PanelJob } from "./job-view.js";
import type { OutputTranscript } from "./live-transcript.js";
export const SHELL_WIDGET_KEY = BACKGROUND_WIDGET_KEY;
export interface ShellWidgetRow {
  jobId: string; tool: string; status: string; command: string;
  startedAt?: number; endedAt?: number; totalBytes?: number; logBytes?: number;
  exitCode?: number; cancelRequested?: boolean; liveLogPath?: string;
  /** Bounded live output copy of a running job; the owner releases it at the terminal state. */
  live?: OutputTranscript;
}
export function shellPanelJobs(rows: readonly ShellWidgetRow[]): PanelJob[] {
  return rows.slice(0, 32).map(row => {
    const active = row.status === "running" || row.status === "cancelling";
    const activity = row.status === "cancelling" ? "Cancel requested · awaiting settlement" : row.status === "running" ? `Running · ${row.totalBytes ? "output received" : "no output observed"}` : row.status === "timed_out" ? "Time limit exceeded" : row.status;
    return { kind: "shell", jobId: row.jobId, label: safeJobText(row.tool, 64), title: safeJobText(row.command, 256), state: row.status, active, activity, usageState: "na", startedAt: row.startedAt,
      details: [
        `Command preview: ${safeJobText(row.command, 8192)}`,
        `Started: ${row.startedAt === undefined ? "unknown" : new Date(row.startedAt).toISOString()}`,
        `Finished: ${row.endedAt === undefined ? "not observed" : new Date(row.endedAt).toISOString()}`,
        `Output bytes observed: ${row.totalBytes ?? "unknown"} · Log bytes retained: ${row.logBytes ?? "unknown"}`,
        `Exit code: ${row.exitCode ?? "not provided"} · Cancel requested: ${row.cancelRequested === true}`,
        ...(row.liveLogPath ? [`Log: ${safeJobText(row.liveLogPath)}`] : []),
        "Tokens N/A: Shell has no model usage ledger.",
      ],
      ...(row.live && !row.live.isReleased ? { transcripts: [{ label: "output", transcript: row.live }] } : {}) };
  });
}
export function renderShellWidget(rows: readonly ShellWidgetRow[], theme: Theme): Component {
  return { invalidate() {}, render: width => renderJobs(shellPanelJobs(rows), theme, width) };
}

/** UI-only observer: no timers, tools, model messages, or job-control side effects. */
export class ShellJobsWidget extends JobsWidgetBinding<ShellWidgetRow> {
  constructor(api?: PanelHost) { super("shell", shellPanelJobs, api); }
}
