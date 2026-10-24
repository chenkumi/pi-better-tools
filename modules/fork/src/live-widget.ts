import type { PanelHost } from "../../shell-tools/src/background-panel.ts";
import { JobsWidgetBinding } from "../../shell-tools/src/widget-binding.ts";
import { safeJobText, usageDetails, type PanelJob, type PanelUsage } from "../../shell-tools/src/job-view.ts";
import type { Job } from "./manager.ts";
import { isTerminal } from "./store.ts";

const iso = (value?: string) => { const time = value ? Date.parse(value) : NaN; return Number.isFinite(time) ? time : undefined; };
const panelUsage = (job: Job): PanelUsage | undefined => {
	const usage = job.record.result?.usage;
	return usage ? { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, totalTokens: usage.total, cost: usage.cost } : undefined;
};

function activity(job: Job): string {
	const { status } = job.record;
	if (isTerminal(status)) {
		if (job.released && job.record.cleanup?.childClosed === true) return `${status} · child closed`;
		// Records recovered from disk (interrupted) carry no cleanup evidence: say nothing about it rather than claim either way.
		return job.released ? status : `${status} · cleanup unconfirmed · child close not observed`;
	}
	if (status === "awaiting_snapshot") return "awaiting_snapshot · starts at turn end";
	if (status === "cancelling") return "cancelling · cancel requested, awaiting child close";
	if (status === "blocked") {
		// The child's own model call failed; its nested jobs may still be running. Never render this as healthy.
		const pending = job.record.blocked ? job.record.blocked.pending.shell + job.record.blocked.pending.subagents : 0;
		const reason = job.record.blocked?.reason ?? "MODEL_ERROR";
		return pending ? `blocked · ${reason} · waiting for ${pending} unfinished nested job(s)` : `blocked · ${reason}`;
	}
	return status;
}

/** Plain projection of retained records. Never reads logs/sessions or the task/result body, and never owns the registry. */
export function forkPanelJob(job: Job): PanelJob {
	const r = job.record, usage = panelUsage(job);
	const details = [
		`Status: ${r.status}${r.cancelRequested ? " (cancel requested)" : ""} · delivery ${r.delivery}`,
		`Fork ID: ${r.jobId}`, `Fork session ID: ${r.forkSessionId}`,
		r.sessionPath ? `Native session: ${r.sessionPath}` : "Native session: not created yet",
		`Created: ${r.createdAt}${r.startedAt ? ` · Started: ${r.startedAt}` : ""}${r.endedAt ? ` · Ended: ${r.endedAt}` : ""}`,
		r.cleanup ? `Cleanup: child ${r.cleanup.childClosed ? "closed" : "close NOT confirmed"}${r.cleanup.exitCode !== undefined ? ` · exit ${r.cleanup.exitCode}` : ""}` : "Cleanup: no child close observed yet",
		...(r.blocked ? [`Blocked since ${r.blocked.since} · ${r.blocked.reason}${r.blocked.error ? ` · ${r.blocked.error}` : ""} · pending shell ${r.blocked.pending.shell} / subagents ${r.blocked.pending.subagents} · the Fork cannot progress until those jobs end`] : []),
		job.released ? "Permit: released" : "Permit: held until child close is confirmed",
		`Model: ${r.config.model} · thinking ${r.config.thinkingLevel}`,
		usageDetails(usage), "Usage is the Fork's own incremental usage, not inherited history.",
		...(job.persistError ? [`Persist error: ${job.persistError}`] : []),
	];
	return { kind: "fork", jobId: r.jobId, label: "fork", title: safeJobText(r.title, 256), state: r.status, active: !isTerminal(r.status) || !job.released,
		activity: activity(job), usageState: usage ? "reported" : r.result?.usageUnknown ? "unknown" : "pending", ...(usage ? { usage } : {}), startedAt: iso(r.createdAt), details: details.map(line => safeJobText(line, 512)),
		...(job.live && !job.live.isReleased ? { transcripts: [{ label: "fork", transcript: job.live }] } : {}) };
}

/** Binding-scoped, event-driven view of one origin session's Forks. Presentation only: no polling, no model work. */
export class ForkJobsWidget extends JobsWidgetBinding<Job> {
	constructor(api?: PanelHost) { super("fork", rows => rows.map(forkPanelJob), api); }
}
