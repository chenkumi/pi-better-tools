import { stripVTControlCharacters } from "node:util";
import type { RpcObservation } from "./rpc.ts";

export type StartupPhase = "spawning_child" | "awaiting_get_state" | "validating_rpc_state" | "verifying_startup_guard" | "awaiting_get_entries" | "validating_startup_entries" | "setting_steering_mode" | "submitting_initial_prompt" | "startup_ready";
const GUARD_PHASES = ["guard_loaded", "guard_session_start", "guard_verified", "guard_rejected", "guard_failed"] as const;
const GUARD_ERRORS = ["MODEL_UNAVAILABLE", "CONFIG_CHANGED", "TRUST_REQUIRED", "EACCES", "EPERM", "EEXIST", "ENOENT", "ENOTDIR", "EIO", "OTHER"];
const COMMANDS = ["get_state", "get_entries", "set_steering_mode", "prompt"];
const VERSION = /^v?\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][a-zA-Z0-9.-]{1,40})?$/;
const safePath = (value: string) => stripVTControlCharacters(value.slice(0, 512)).replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/gu, "");

/** Observations only: no timers, I/O, readiness authorization or raw payload retention.
 * Failure-time evidence is frozen before termination; cleanup is reported separately. */
export class StartupDiagnostics {
	private readonly startedAt: number;
	private phase: StartupPhase = "spawning_child";
	private lastCompleted = "none_observed";
	private active = true;
	private guardReports = new Set<string>();
	private guardErrors: Record<string, string> = {};
	private piVersion?: string;
	private nodeVersion?: string;
	private cli?: { command: string; script?: string };
	private pid?: number;
	private spawnSeen = false;
	private closeSeen = false;
	private exitCode: number | null = null;
	private signalCode: string | null = null;
	private terminationSeen = false;
	private stdoutBytes = 0;
	private stderrBytes = 0;
	private uiRequests = 0;
	private unmatchedResponses = 0;
	private promptRequested = false;
	private request?: { id: string; command: string; event: string; elapsedMs: number; deadlineMs?: number; writeCompleted: boolean; matchingResponse: boolean };
	private timeline: Array<{ atMs: number; event: string }> = [];
	private timelineOmitted = 0;
	private frozen?: ReturnType<StartupDiagnostics["capture"]>;
	private message?: string;
	constructor(private readonly token: string, private readonly now: () => number = () => performance.now()) { this.startedAt = now(); }
	get isStarting() { return this.active; }
	get hasFailure() { return this.frozen !== undefined; }
	private elapsed() { return Math.max(0, Math.round(this.now() - this.startedAt)); }
	private record(event: string) {
		if (!this.active) return;
		if (this.timeline.length < 24) this.timeline.push({ atMs: this.elapsed(), event });
		else this.timelineOmitted = Math.min(Number.MAX_SAFE_INTEGER, this.timelineOmitted + 1);
	}
	launch(invocation: { command: string; args: string[] }) {
		this.cli = { command: safePath(invocation.command), ...(/\.(?:[cm]?js|ts)$/iu.test(invocation.args[0] ?? "") ? { script: safePath(invocation.args[0]) } : {}) };
		this.record("spawn_requested");
	}
	spawnObserved(pid?: number) {
		if (!this.active) return;
		this.spawnSeen = true;
		if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0) this.pid = pid;
		this.checkpoint("child_spawn_observed");
	}
	enter(phase: StartupPhase) {
		if (!this.active) return;
		this.phase = phase;
		if (phase === "submitting_initial_prompt") this.promptRequested = true;
		this.record(phase);
	}
	checkpoint(phase: string) { if (this.active) { this.lastCompleted = phase; this.record(phase); } }
	observeBytes(stream: "stdout" | "stderr", count: number) {
		if (!this.active || !Number.isSafeInteger(count) || count < 0) return;
		if (stream === "stdout") this.stdoutBytes = Math.min(Number.MAX_SAFE_INTEGER, this.stdoutBytes + count);
		else this.stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, this.stderrBytes + count);
	}
	observeUiRequest() { if (this.active) { this.uiRequests = Math.min(Number.MAX_SAFE_INTEGER, this.uiRequests + 1); this.record("extension_ui_request_observed"); } }
	observeRpc(event: RpcObservation) {
		if (!this.active) return;
		if (event.event === "unmatched_response") { this.unmatchedResponses = Math.min(Number.MAX_SAFE_INTEGER, this.unmatchedResponses + 1); this.record("unmatched_rpc_response"); return; }
		if (!event.command || !COMMANDS.includes(event.command) || !event.id || event.id.length > 64) return;
		if (event.event === "queued") this.request = { id: event.id, command: event.command, event: event.event, elapsedMs: event.elapsedMs, deadlineMs: event.deadlineMs, writeCompleted: false, matchingResponse: false };
		else if (this.request?.id === event.id) {
			this.request.event = event.event; this.request.elapsedMs = event.elapsedMs;
			if (event.event === "write_completed") this.request.writeCompleted = true;
			if (event.event === "response" || event.event === "rejected") this.request.matchingResponse = true;
		}
		this.record(`rpc_${event.command}_${event.event}`);
	}
	receive(input: unknown): boolean {
		if (!this.active || !input || typeof input !== "object" || Array.isArray(input)) return false;
		try {
			const value = input as Record<string, unknown>;
			if (value.channel !== "pi-subagent-startup" || value.token !== this.token || typeof value.phase !== "string" || !(GUARD_PHASES as readonly string[]).includes(value.phase) || this.guardReports.has(value.phase)) return false;
			// Reject unknown fields rather than accidentally retaining future credentials/text.
			for (const key in value) if (!["channel", "token", "phase", "piVersion", "nodeVersion", "errorCode"].includes(key)) return false;
			for (const key of ["piVersion", "nodeVersion"]) if (value[key] !== undefined && (typeof value[key] !== "string" || (value[key] as string).length > 64 || !VERSION.test(value[key] as string))) return false;
			if (value.errorCode !== undefined && (typeof value.errorCode !== "string" || !GUARD_ERRORS.includes(value.errorCode))) return false;
			this.guardReports.add(value.phase);
			if (typeof value.piVersion === "string") this.piVersion = value.piVersion;
			if (typeof value.nodeVersion === "string") this.nodeVersion = value.nodeVersion;
			if (typeof value.errorCode === "string") this.guardErrors[value.phase] = value.errorCode;
			this.record(value.phase);
			return true;
		} catch { return false; }
	}
	ready() { this.enter("startup_ready"); this.checkpoint("initial_prompt_accepted"); this.active = false; }
	terminationRequested() { this.terminationSeen = true; }
	processClosed(code: number | null, signal: string | null) { this.closeSeen = true; this.exitCode = code; this.signalCode = signal; }
	private capture() {
		return { phase: this.phase, elapsedMs: this.elapsed(), lastCompleted: this.lastCompleted, cli: this.cli ? { ...this.cli } : undefined,
			pid: this.pid, spawnObserved: this.spawnSeen, childCloseObserved: this.closeSeen, childExitCode: this.exitCode, childSignal: this.signalCode,
			guardReports: [...this.guardReports], guardErrors: { ...this.guardErrors }, piVersion: this.piVersion ?? "unknown", nodeVersion: this.nodeVersion ?? "unknown",
			request: this.request ? { ...this.request } : undefined, promptRequested: this.promptRequested, stdoutBytes: this.stdoutBytes, stderrBytes: this.stderrBytes,
			uiRequests: this.uiRequests, unmatchedResponses: this.unmatchedResponses, timeline: this.timeline.map(event => ({ ...event })), timelineOmitted: this.timelineOmitted };
	}
	snapshot() { return structuredClone(this.frozen ?? this.capture()); }
	failureMessage(original: string) {
		if (this.message) return this.message;
		this.frozen = this.capture(); this.active = false;
		const s = this.frozen;
		const hint = s.guardReports.includes("guard_rejected") ? `Guard reported rejection: ${s.guardErrors.guard_rejected ?? "unknown"}. Inspect the startup-file/configuration diagnostics.`
			: s.guardReports.includes("guard_failed") ? `Guard reported a startup exception: ${s.guardErrors.guard_failed ?? "unknown"}. Inspect the startup-file/configuration diagnostics.`
			: s.guardReports.includes("guard_verified") ? "Guard reported successful checks; this is not proof that all session_start hooks or the RPC command loop became ready."
			: s.guardReports.includes("guard_session_start") ? "Guard session_start was observed, but guard success was not observed. Check configuration/startup-file diagnostics and IPC delivery."
			: s.guardReports.includes("guard_loaded") ? "Guard loaded, but its session_start milestone was not observed. Remaining initialization or IPC delivery may be delayed."
			: "No guard milestone was observed. CLI/extension initialization or IPC delivery may be delayed.";
		this.message = `${original}\nStartup observations (before cleanup): phase=${s.phase}; elapsed=${s.elapsedMs} ms; last completed=${s.lastCompleted}.\n`
			+ `Initial task prompt requested: ${s.promptRequested ? "yes" : "no"} (not proof of acceptance or model completion).\n`
			+ `Stdin write completion observed: ${s.request?.writeCompleted ? "yes" : "no"}; matching RPC response observed: ${s.request?.matchingResponse ? "yes" : "no"}. Write completion is not proof that the child read it.\n`
			+ `${hint}\n${s.uiRequests ? "Extension UI requests were observed; check for an interactive initialization wait. " : ""}`
			+ "Exact cause is unknown; these are observations, not readiness/trust authorization. The unchanged 30000 ms RPC response budget includes startup/queue time. No automatic retry.\n"
			+ `Startup observation data: ${JSON.stringify(s)}`;
		return this.message;
	}
	cleanupMessage() {
		return `Cleanup observations: child close observed: ${this.closeSeen ? "yes" : "no"}; exitCode=${this.exitCode ?? "unknown"}; signal=${this.signalCode ?? "none observed"}. Termination requested: ${this.terminationSeen ? "yes" : "no"}. A child close does not confirm its entire process tree stopped.`;
	}
}
