/**
 * Agent job runner: a separate in-process agent session answers the prompt. It never joins the user's conversation;
 * the result is a marker, and only `notify: true` wakes the main agent. The session itself is behind `ChildFactory`
 * so the orchestration (start, time limit, cancellation, outcome, cleanup) is testable without a model.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LiveTranscript } from "../../../shared/src/background/index.js";
import type { Clock } from "./clock.ts";
import type { RunHandle, RunInfo, RunOutcome } from "./engine.ts";
import type { LiveRuns } from "./live-runs.ts";
import { postMarker, type MarkerDetails } from "./markers.ts";
import type { Job } from "./types.ts";

export type AgentJob = Extract<Job, { kind: "agent" }>;

export interface ChildResult { text: string; /** Set when the run ended in a provider error or stopped itself. */ failure?: string }
export interface ChildSession {
	/** Runs the prompt to completion. */
	run(prompt: string): Promise<ChildResult>;
	abort(): void;
	/** Memory copy of the child conversation for the Jobs overlay; fed while the run goes on. */
	readonly transcript?: LiveTranscript;
	/** Awaited teardown; returns the cleanup failure text, if any, instead of throwing. */
	dispose(): Promise<string | undefined>;
}
export type ChildFactory = (job: AgentJob) => Promise<ChildSession>;

/** Upper bound for one run, so a hung provider cannot pin a job in "running" forever. */
export const AGENT_TIMEOUT_MS = 30 * 60 * 1000;
const SHOWN_CHARS = 500;

export interface AgentDeps {
	pi: Pick<ExtensionAPI, "sendMessage">;
	clock: Clock;
	createChild: ChildFactory;
	timeoutMs?: number;
	active: Set<AbortController>;
	live?: LiveRuns;
}

export function runAgentJob(d: AgentDeps, job: AgentJob, info: RunInfo): RunHandle {
	let resolveStarted!: (value: boolean) => void;
	const started = new Promise<boolean>((resolve) => { resolveStarted = resolve; });
	const base: MarkerDetails = { jobId: job.id, jobName: job.name, kind: "agent", phase: "start", model: job.model, scheduledFor: info.scheduledFor, ...(info.missed !== undefined ? { catchUp: info.missed } : {}) };
	const limit = d.timeoutMs ?? AGENT_TIMEOUT_MS;

	const done = (async (): Promise<RunOutcome> => {
		// The start marker carries text so the conversation shows why a later notification arrives.
		postMarker(d.pi, base, { content: `Scheduled agent job "${job.name}" started (model ${job.model}).` });
		const controller = new AbortController();
		d.active.add(controller);
		let child: ChildSession | undefined, timer: unknown, timedOut = false;
		let result: ChildResult | undefined, error: string | undefined, cleanup: string | undefined;
		try {
			child = await d.createChild(job);
			if (child.transcript) d.live?.set(job.id, child.transcript);
			resolveStarted(true);
			const abort = () => child?.abort();
			if (controller.signal.aborted) abort();
			controller.signal.addEventListener("abort", abort, { once: true });
			timer = d.clock.setTimeout(() => { timedOut = true; abort(); }, limit);
			result = await child.run(job.prompt);
		} catch (thrown) {
			error = thrown instanceof Error ? thrown.message : String(thrown);
		} finally {
			if (timer !== undefined) d.clock.clearTimeout(timer);
			cleanup = child ? await child.dispose().catch((e: unknown) => (e instanceof Error ? e.message : String(e))) : undefined;
			d.active.delete(controller);
			if (child?.transcript) { if (d.live) d.live.release(job.id, child.transcript); else child.transcript.release(); }
		}
		if (controller.signal.aborted && !timedOut) return { status: "error", error: "cancelled because the session ended" };
		if (timedOut) error = `timed out after ${Math.round(limit / 60000)} minutes`;
		else if (error === undefined && result?.failure) error = result.failure;
		const text = result?.text.trim() ?? "";
		const shown = text.length > SHOWN_CHARS ? `${text.slice(0, SHOWN_CHARS)}…` : text;
		const note = cleanup ? ` (cleanup not confirmed: ${cleanup})` : "";
		if (error === undefined) {
			postMarker(d.pi, { ...base, phase: "done", output: shown, ...(job.notify ? { notify: true } : {}) },
				job.notify ? { content: `Scheduled agent job "${job.name}" finished:\n${text || "(no text)"}${note}`, wake: true } : {});
			return { status: "success" };
		}
		const failed = `${error}${note}`;
		postMarker(d.pi, { ...base, phase: "error", error: failed, output: shown, ...(job.notify ? { notify: true } : {}) },
			job.notify ? { content: `Scheduled agent job "${job.name}" failed: ${failed}`, wake: true } : {});
		return { status: "error", error: failed };
	})();
	void done.finally(() => resolveStarted(false));
	return { started, done };
}
