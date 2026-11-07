/**
 * The schedule rows of the shared Jobs panel. Presentation only: a row per visible job (running, scheduled or disabled),
 * no prompt or command text on the passive row, and nothing here starts, stops or changes a job.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canonicalMonitorCwd, JobsWidgetBinding, publishJobBriefs, safeJobText } from "../../../shared/src/background/index.js";
import type { PanelHost, PanelJob, TranscriptSource } from "../../../shared/src/background/index.js";
import type { Clock } from "./clock.ts";
import { defaultShell } from "./guard.ts";
import { describeSchedule } from "./shorthand.ts";
import type { Job, JobKind } from "./types.ts";

const MAX_ROWS = 32;
/** Relative times in the rows go stale, so the owner refreshes the view this often while something is scheduled. */
export const REFRESH_MS = 60_000;

export interface ScheduleRow { job: Job; running: boolean; /** Memory copy of the run in flight (output tail or conversation); shown in the Jobs overlay. */ live?: TranscriptSource }

/** "in 12m", "in 3h", "in 2d", or "due" when the time has come. */
export function relativeTime(targetMs: number, nowMs: number): string {
	const diff = targetMs - nowMs;
	if (diff <= 0) return "due";
	const minutes = Math.ceil(diff / 60_000);
	if (minutes < 60) return `in ${minutes}m`;
	const hours = Math.round(minutes / 60);
	return hours < 48 ? `in ${hours}h` : `in ${Math.round(hours / 24)}d`;
}

const kindLabel = (job: Job) => (job.kind === "agent" ? `agent ${job.model}` : job.kind);

export function schedulePanelJob(row: ScheduleRow, nowMs: number): PanelJob {
	const { job, running, live } = row;
	const next = job.enabled && job.state.nextDue ? Date.parse(job.state.nextDue) : undefined;
	const state = running ? "running" : job.enabled ? "scheduled" : "disabled";
	const details = [
		`Job ID: ${job.id}`,
		`Kind: ${kindLabel(job)}`,
		`Schedule: ${describeSchedule(job.schedule)}`,
		`State: ${state}${job.session ? "" : " (shared by every session of this directory)"}`,
		...(next !== undefined ? [`Next run: ${job.state.nextDue}`] : []),
		...(job.endAt ? [`Ends: ${job.endAt}`] : []),
		`Runs: ${job.state.runCount}${job.state.lastRun ? ` · last ${job.state.lastRun}` : ""}${job.state.lastStatus ? ` (${job.state.lastStatus})` : ""}`,
		...(job.state.lastError ? [`Last error: ${job.state.lastError}`] : []),
		...(job.kind === "shell" ? [`Shell: ${job.shell ?? defaultShell()}`, `Command: ${job.command}`] : []),
		...(job.kind === "prompt" || job.kind === "agent" ? [`Prompt: ${job.prompt}`] : []),
		...(job.kind === "monitor" ? [`Monitor source: ${job.start.source.kind}`, `Start: ${JSON.stringify(job.start)}`] : []),
		"Manage it with schedule_prompt / schedule_shell / schedule_monitor. Nothing runs while Pi is closed.",
	];
	return {
		kind: "schedule", jobId: job.id, label: job.name, title: kindLabel(job), state, active: job.enabled || running,
		activity: running ? "Running" : job.enabled ? `Scheduled · ${next !== undefined ? relativeTime(next, nowMs) : "no further run"}` : "Disabled",
		usageState: "na",
		...(job.state.lastRun ? { startedAt: Date.parse(job.state.lastRun) } : {}),
		summary: running ? "running" : job.enabled ? `${next !== undefined ? relativeTime(next, nowMs) : "—"} | ${describeSchedule(job.schedule)}` : "disabled",
		details: details.map((line) => safeJobText(line, 512)),
		...(running && live && !live.isReleased ? { transcripts: [{ label: job.name, transcript: live }] } : {}),
	};
}

/** Running jobs first, then by next due time (soonest first), then disabled ones. */
export function orderRows(rows: readonly ScheduleRow[]): ScheduleRow[] {
	const rank = (r: ScheduleRow) => (r.running ? 0 : r.job.enabled ? 1 : 2);
	const due = (r: ScheduleRow) => (r.job.state.nextDue ? Date.parse(r.job.state.nextDue) : Infinity);
	return [...rows].sort((a, b) => rank(a) - rank(b) || due(a) - due(b) || a.job.id.localeCompare(b.job.id));
}

export class SchedulePanel extends JobsWidgetBinding<ScheduleRow> {
	#timer: unknown;
	readonly #clock: Clock;
	constructor(clock: Clock, api?: PanelHost) {
		super("schedule", (rows) => orderRows(rows).slice(0, MAX_ROWS).map((row) => schedulePanelJob(row, clock.now())), api);
		this.#clock = clock;
	}

	override bind(ctx: ExtensionContext, source: () => readonly ScheduleRow[]): void {
		this.#stopTimer();
		super.bind(ctx, source);
		const loop = () => { this.refresh(); this.#timer = this.#clock.setTimeout(loop, REFRESH_MS); };
		this.#timer = this.#clock.setTimeout(loop, REFRESH_MS);
	}

	override clear(): void {
		this.#stopTimer();
		super.clear();
	}

	#stopTimer(): void {
		if (this.#timer !== undefined) this.#clock.clearTimeout(this.#timer);
		this.#timer = undefined;
	}
}

/** Runs in flight (id and status, nothing else) for the live background-jobs reminder at compaction. Returns the revoke handle. */
export function publishScheduleBriefs(running: () => ReadonlyMap<string, JobKind>, ctx: ExtensionContext): () => void {
	const scope = { sessionId: ctx.sessionManager.getSessionId(), cwd: canonicalMonitorCwd(ctx.cwd) };
	return publishJobBriefs("schedule_job", scope,
		() => [...running().keys()].map((jobId) => ({ jobId, status: "running" })),
		() => {
			try { return ctx.sessionManager.getSessionId() === scope.sessionId && canonicalMonitorCwd(ctx.cwd) === scope.cwd; } catch { return false; }
		});
}
