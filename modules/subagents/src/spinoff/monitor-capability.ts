// Readonly, bounded Spinoff state for Monitor's `spinoff_job` source. Observation only: the Spinoff result keeps
// its own spinoff-result delivery path, and nothing here can cancel, resume or query a Spinoff's model.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canonicalMonitorCwd, publishCapability } from "../../../../shared/src/background/index.ts";
import { findOwnedJob, ownedJobs, state } from "./manager.ts";
import { isTerminal } from "./store.ts";

const MAX_REASON = 200;
const bounded = (value: string, max = MAX_REASON) => value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "").slice(0, max);

/** Bounded status view of one owned Spinoff: no task text, no result output, no usage, no native session path. */
export function spinoffMonitorSnapshot(ctx: ExtensionContext, jobId: string): Record<string, unknown> {
	const job = findOwnedJob(ctx, jobId);
	if (!job) throw new Error("Monitor Spinoff snapshot unavailable: the Spinoff is not retained by this session/cwd");
	const record = job.record;
	const from = Date.parse(record.startedAt ?? record.createdAt), to = Date.parse(record.endedAt ?? "");
	return {
		jobId: record.jobId, status: record.status, cancelRequested: record.cancelRequested, delivery: record.delivery,
		createdAt: record.createdAt, ...(record.startedAt ? { startedAt: record.startedAt } : {}), ...(record.endedAt ? { endedAt: record.endedAt } : {}),
		elapsedMs: Number.isFinite(from) ? Math.max(0, (Number.isFinite(to) ? to : Date.now()) - from) : 0,
		...(record.cleanup ? { cleanup: { childClosed: record.cleanup.childClosed === true, exitCode: record.cleanup.exitCode ?? null } } : {}),
		...(record.transcript ? { transcript: { state: record.transcript.state, path: bounded(record.transcript.path, 400) } } : {}),
		// Blocked is a non-terminal status the child guard reports; only the bounded reason and nested-job counts travel.
		...(record.blocked ? { blocked: { reason: bounded(record.blocked.reason), pending: { shell: record.blocked.pending.shell, subagents: record.blocked.pending.subagents }, since: record.blocked.since } } : {}),
	};
}

/** Publishes the `spinoff_job` capability for this session/cwd generation; returns the revoke handle. */
export function publishSpinoffMonitor(ctx: ExtensionContext): () => void {
	const scope = { sessionId: ctx.sessionManager.getSessionId(), cwd: canonicalMonitorCwd(ctx.cwd) }, epoch = state().epoch;
	return publishCapability("spinoff_job", scope, epoch, jobId => spinoffMonitorSnapshot(ctx, jobId), () => {
		try {
			return state().epoch === epoch && ctx.sessionManager.getSessionId() === scope.sessionId && canonicalMonitorCwd(ctx.cwd) === scope.cwd;
		} catch { return false; }
	}, undefined, () => ownedJobs(ctx).filter(job => !isTerminal(job.record.status)).map(job => ({ kind: "spinoff_job" as const, jobId: job.record.jobId, status: job.record.status })));
}
