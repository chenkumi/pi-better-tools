/** Persisted data model (store version 2). Discriminated on `kind`; engine state is kept apart from user settings. */

export type Schedule =
	| { type: "cron"; expr: string; timezone?: string }
	| { type: "interval"; everyMs: number }
	| { type: "once"; at: string };

export type MissedPolicy = "skip" | "run-once" | "run-all";
export type JobStatus = "success" | "error" | "running" | "skipped";

export interface JobState {
	nextDue?: string;
	lastRun?: string;
	lastStatus?: JobStatus;
	lastError?: string;
	runCount: number;
}

/** Monitor start parameters are validated structurally here and fully by Monitor itself at start time. */
export type MonitorStart = { source: { kind: string; [key: string]: unknown }; [key: string]: unknown };

export interface JobCommon {
	id: string;
	name: string;
	description?: string;
	schedule: Schedule;
	endAt?: string;
	enabled: boolean;
	session?: string;
	missed?: MissedPolicy;
	maxLateMs?: number;
	createdAt: string;
	state: JobState;
}

export type JobBody =
	| { kind: "prompt"; prompt: string }
	| { kind: "agent"; prompt: string; model: string; notify?: boolean; extensions?: boolean | string[]; skills?: boolean | string[] }
	| { kind: "shell"; command: string; shell?: "bash" | "powershell"; cwd?: string; timeoutMs?: number }
	| { kind: "monitor"; start: MonitorStart };

export type Job = JobCommon & JobBody;
export type JobKind = Job["kind"];

export interface StoreFile {
	version: 2;
	jobs: Job[];
}
