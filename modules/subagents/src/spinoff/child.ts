import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { killProcessTree } from "../spinoff-contract.ts";
import { getPiInvocation } from "../spinoff-contract.ts";
import { RpcPipe } from "../spinoff-contract.ts";
import { CHANNEL } from "./child-guard.ts";
import { SPINOFF_GUARD_ENV, type SpinoffChildGuard } from "./identity.ts";

const LIVE_EVENT = /"type":"(?:message_start|message_update|message_end|tool_execution_start|tool_execution_update|tool_execution_end)"/;
/** Longest accepted stdout line, in UTF-16 code units of the decoded text (not UTF-8 bytes). */
export const MAX_LINE_CODE_UNITS = 4 * 1024 * 1024;
export const STDERR_TAIL_BYTES = 8 * 1024;
export const STARTUP_MS = 90_000;
export const CLOSE_GRACE_MS = 10_000;
export const KILL_GRACE_MS = 5_000;
/** Dialog requests of the child that wait for the user at the same time; more are answered "cancelled" at once. */
export const MAX_PENDING_UI = 8;
const DIALOG = /"method":"(?:select|confirm|input|editor)"/;

/** A dialog the child's extension opened (`ctx.ui.select/confirm/input/editor`). Text is the child's, so it is control-stripped and bounded. */
export interface SpinoffUiRequest { id: string; method: "select" | "confirm" | "input" | "editor"; title: string; message?: string; options?: string[]; placeholder?: string; prefill?: string; timeout?: number }
export type SpinoffUiAnswer = { confirmed: boolean } | { value: string } | { cancelled: true };

export interface SpinoffChildSpec {
	jobId: string;
	sessionId: string;
	/** Originating session id; becomes the child's provider cache identity (see child-guard). */
	parentSessionId: string;
	sessionPath: string;
	sessionDir: string;
	cwd: string;
	model: string;
	thinkingLevel: string;
	tools: string[];
	/** Registered but inactive deferred tools of the parent. Named in `--tools` so they register (Pi activates them there; the child guard deactivates them again). */
	loadable?: string[];
	trusted: boolean;
	guardPath: string;
	/** Parent resource/prompt flags forwarded verbatim (already absolute); never contains task text. */
	forwarded: string[];
	prompt: string;
	/** Receives every finished message (user/assistant/toolResult) the child emits after the task was sent; never inherited history. Must not throw into the stream. */
	onMessage?: (message: unknown) => void;
	/** Every conversation event after the prompt was sent; feeds the in-memory live viewer only. */
	onEvent?: (event: unknown) => void;
	/** Asks the user in the parent for a child dialog. The signal aborts when the child is cancelled or gone. Without it every dialog is answered "cancelled". */
	onUiRequest?: (request: SpinoffUiRequest, signal: AbortSignal) => Promise<SpinoffUiAnswer>;
	invocation?: typeof getPiInvocation;
	spawnImpl?: typeof spawn;
	/** Test seams for the termination ladder; production uses the constants above. */
	closeGraceMs?: number;
	killGraceMs?: number;
}
export interface SpinoffUsage { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost: number }
export interface SpinoffChildOutcome {
	status: "completed" | "failed" | "cancelled";
	output?: string;
	errorCode?: string;
	error?: string;
	usage?: SpinoffUsage;
	usageUnknown?: boolean;
	childClosed: boolean;
	exitCode?: number | null;
	stderrTail: string;
}
export type SpinoffPhase = "starting" | "running" | "finalizing" | "cancelling";
/** `blocked` is not a phase: it is the child guard's non-terminal truth report while nested jobs still run. */
export type SpinoffProgress = SpinoffPhase | "blocked";
export interface SpinoffBlockedDetail { reason: string; error?: string; pending: { shell: number; subagents: number } }
/** `closed` settles only on a real child `close`, even after `done` reported `childClosed: false`. */
/** `steer` appends a user message to the live child's own conversation over the same RPC pipe as the task.
 *  `follow_up` waits for the current turn, `steer` interrupts it. Accepted means the child answered the request. */
export interface SpinoffChildHandle { readonly pid?: number; cancel(): Promise<void>; readonly done: Promise<SpinoffChildOutcome>; readonly closed?: Promise<number | null>; steer(message: string, mode: SpinoffMessageMode): Promise<string> }
export type SpinoffMessageMode = "follow_up" | "steer";

/** Argument vector for the Spinoff child. The task travels over RPC stdin, never on the command line. */
export function buildSpinoffPiArgs(spec: Pick<SpinoffChildSpec, "sessionPath" | "sessionDir" | "model" | "thinkingLevel" | "tools" | "loadable" | "trusted" | "guardPath" | "forwarded">): string[] {
	const args = ["--mode", "rpc", "--session", spec.sessionPath, "--session-dir", spec.sessionDir, "--model", spec.model, "--thinking", spec.thinkingLevel];
	// The allowlist is the active set plus the parent's unloaded deferred tools: without them they would not register in the child, and
	// `tool_search` there could not load what the parent can. Pi activates every named tool, so the child guard deactivates the extras.
	if (spec.tools.length) args.push("--tools", [...spec.tools, ...(spec.loadable ?? [])].join(","));
	else args.push("--no-tools");
	// No --exclude-tools: the child's tool list must equal the parent's to continue its cached prefix. Spinoff tools stay defined and are refused at call time.
	args.push("-e", spec.guardPath, spec.trusted ? "--approve" : "--no-approve", ...spec.forwarded);
	return args;
}

const usageOf = (stats: any): SpinoffUsage | undefined => {
	const t = stats?.tokens;
	if (!t || typeof t.total !== "number") return undefined;
	const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
	return { input: n(t.input), output: n(t.output), cacheRead: n(t.cacheRead), cacheWrite: n(t.cacheWrite), total: n(t.total), cost: n(stats.cost) };
};
const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "total", "cost"] as const satisfies readonly (keyof SpinoffUsage)[];
const delta = (after?: SpinoffUsage, before?: SpinoffUsage): SpinoffUsage | undefined => after && before
	? Object.fromEntries(USAGE_FIELDS.map(field => [field, Math.max(0, after[field] - before[field])])) as unknown as SpinoffUsage : undefined;
// eslint-disable-next-line no-control-regex
const stripControl = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const bounded = (value: unknown, max: number) => typeof value === "string" ? stripControl(value).slice(0, max) : undefined;
/** Undefined when the record is not a well-formed dialog; the child's text never reaches the parent unbounded or with terminal escapes. */
function uiRequestOf(event: any): SpinoffUiRequest | undefined {
	if (typeof event?.id !== "string" || !["select", "confirm", "input", "editor"].includes(event.method)) return undefined;
	const options = Array.isArray(event.options) ? event.options.slice(0, 100).map((option: unknown) => bounded(option, 300)) : undefined;
	if (options && options.some((option: string | undefined) => option === undefined)) return undefined;
	const message = bounded(event.message, 8000), placeholder = bounded(event.placeholder, 300), prefill = bounded(event.prefill, 8000);
	return { id: event.id, method: event.method, title: bounded(event.title, 300) ?? "", ...(message ? { message } : {}), ...(options ? { options: options as string[] } : {}),
		...(placeholder ? { placeholder } : {}), ...(prefill ? { prefill } : {}), ...(typeof event.timeout === "number" && event.timeout > 0 ? { timeout: event.timeout } : {}) };
}
const jobCount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** Opt-in diagnostics (PI_SPINOFF_DEBUG=1): phase names only, never task text, output or credentials. */
const debug = (jobId: string, message: string) => { if (process.env.PI_SPINOFF_DEBUG) { try { process.stderr.write(`[spinoff ${jobId.slice(-6)}] ${message}
`); } catch { /* diagnostics only */ } } };

/** Bounded LF-delimited reader: one oversized line is discarded, the stream keeps draining.
 *  The bound is in UTF-16 code units of the decoded string, not UTF-8 bytes (a CJK/emoji line may be up to ~3x larger in bytes). */
function boundedLineReader(maxCodeUnits: number, onLine: (line: string) => void): (chunk: string) => void {
	let buffer = "", discarding = false;
	return chunk => {
		buffer += chunk;
		for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
			const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
			if (discarding) { discarding = false; continue; }
			onLine(line);
		}
		if (buffer.length > maxCodeUnits) { buffer = ""; discarding = true; }
	};
}

class Deferred<T> {
	promise: Promise<T>; resolve!: (value: T) => void; reject!: (error: Error) => void; settled = false;
	constructor() {
		this.promise = new Promise<T>((resolve, reject) => { this.resolve = v => { this.settled = true; resolve(v); }; this.reject = e => { this.settled = true; reject(e); }; });
		this.promise.catch(() => {});
	}
}

/** Starts the independent Pi process. Every wait is tied to cancellation or child close; nothing relies on a fixed sleep. */
export function startSpinoffChild(spec: SpinoffChildSpec, onProgress: (progress: SpinoffProgress, detail?: SpinoffBlockedDetail) => void = () => {}): SpinoffChildHandle {
	const token = randomBytes(16).toString("hex");
	const guard: SpinoffChildGuard = { spinoffId: spec.jobId, sessionId: spec.sessionId, parentSessionId: spec.parentSessionId, cwd: spec.cwd, model: spec.model, thinkingLevel: spec.thinkingLevel, childTrusted: spec.trusted, tools: spec.tools, loadable: spec.loadable ?? [], token };
	const invocation = (spec.invocation ?? ((args: string[]) => getPiInvocation(args, process.env, { preferHostScript: true })))(buildSpinoffPiArgs(spec));
	const proc: ChildProcess = (spec.spawnImpl ?? spawn)(invocation.command, invocation.args, { cwd: spec.cwd, shell: false, windowsHide: true, detached: process.platform !== "win32",
		stdio: ["pipe", "pipe", "pipe", "ipc"], env: { ...process.env, [SPINOFF_GUARD_ENV]: JSON.stringify(guard) } });
	const pipe = new RpcPipe(proc);
	let stderrTail = "", cancelled = false, closed = false, exitCode: number | null | undefined, rejectedCode: string | undefined, spawnError: Error | undefined;
	let lastAssistant: { stopReason?: string; errorMessage?: string } | undefined;
	const closedSignal = new Deferred<void>(), verified = new Deferred<{ tools: string[]; sessionFile?: string }>(), quiescent = new Deferred<void>(), cancelSignal = new Deferred<void>();
	const kill = (signal: NodeJS.Signals) => killProcessTree(proc, signal, { spawn: (command, args, options) => spawn(command, args, options) });

	// A spawn error is not a close: the child may never have existed, but we do not claim cleanup beyond that observation.
	proc.on("error", error => { spawnError = error; verified.reject(error); quiescent.reject(error); });
	proc.on("close", code => {
		closed = true; exitCode = code; uiAbort.abort(); pipe.dispose(); closedSignal.resolve();
		verified.reject(new Error("CHILD_CLOSED: child exited before startup verification"));
		quiescent.reject(new Error("CHILD_CLOSED: child exited before settlement"));
	});
	proc.stderr?.on("data", (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES); });
	proc.on("message", (value: unknown) => {
		const message = value as Record<string, any> | null;
		if (!message || typeof message !== "object" || message.channel !== CHANNEL || message.token !== token) return;
		if (message.type === "verified" && Array.isArray(message.tools)) verified.resolve({ tools: message.tools.map(String), sessionFile: typeof message.sessionFile === "string" ? message.sessionFile : undefined });
		else if (message.type === "rejected") { rejectedCode = String(message.code ?? "REJECTED").slice(0, 64); verified.reject(new Error(`CHILD_REJECTED: ${rejectedCode}`)); }
		else if (message.type === "blocked" && verified.settled && promptSent) onProgress("blocked", {
			reason: String(message.reason ?? "MODEL_ERROR").slice(0, 64),
			...(typeof message.error === "string" && message.error ? { error: message.error.slice(0, 300) } : {}),
			pending: { shell: jobCount(message.pending?.shell), subagents: jobCount(message.pending?.subagents) } });
		else if (message.type === "unblocked" && verified.settled && promptSent) onProgress("running");
		else if (message.type === "settled" && message.quiet === true && verified.settled && promptSent) quiescent.resolve();
	});
	let promptSent = false;
	// A dialog the child opens waits for an answer forever, so every one gets exactly one: the parent user's, or "cancelled".
	const uiAbort = new AbortController();
	let pendingUi = 0;
	const answerUi = (id: string, answer: SpinoffUiAnswer) => {
		if (closed || !proc.stdin || proc.stdin.destroyed) return;
		try { proc.stdin.write(JSON.stringify({ type: "extension_ui_response", id, ...answer }) + "\n", () => {}); } catch { /* the child is gone */ }
	};
	const forwardUi = (event: any) => {
		const request = uiRequestOf(event);
		if (!request) { if (typeof event?.id === "string") answerUi(event.id, { cancelled: true }); return; }
		if (!spec.onUiRequest || pendingUi >= MAX_PENDING_UI) { answerUi(request.id, { cancelled: true }); return; }
		pendingUi++;
		void Promise.resolve().then(() => spec.onUiRequest!(request, uiAbort.signal)).catch((): SpinoffUiAnswer => ({ cancelled: true }))
			.then(answer => answerUi(request.id, uiAbort.signal.aborted ? { cancelled: true } : answer)).finally(() => { pendingUi--; });
	};
	const handleLine = (line: string) => {
		if (line.length > MAX_LINE_CODE_UNITS || line.charCodeAt(0) !== 123) return;
		if (line.includes('"type":"extension_ui_request"') && DIALOG.test(line)) { try { forwardUi(JSON.parse(line)); } catch { /* not a record */ } return; }
		const response = line.includes('"type":"response"');
		// Non-assistant messages only matter to the auxiliary transcript, so skip their parse unless it is listening.
		const messageEnd = line.includes('"type":"message_end"') && (line.includes('"role":"assistant"') || (promptSent && !!spec.onMessage));
		const live = !!spec.onEvent && promptSent && LIVE_EVENT.test(line);
		if (!response && !messageEnd && !live) return;
		let event: any; try { event = JSON.parse(line); } catch { return; }
		if (live) { try { spec.onEvent!(event); } catch { /* the live viewer never controls the Spinoff */ } }
		if (event.type === "response") { try { pipe.accept(event); } catch { /* uncorrelated response is ignored */ } }
		else if (event.type === "message_end") {
			if (event.message?.role === "assistant") lastAssistant = { stopReason: event.message.stopReason, errorMessage: typeof event.message.errorMessage === "string" ? event.message.errorMessage.slice(0, 500) : undefined };
			if (promptSent && spec.onMessage) { try { spec.onMessage(event.message); } catch { /* auxiliary transcript never controls the Spinoff */ } }
		}
	};
	proc.stdout?.setEncoding("utf8");
	proc.stdout?.on("data", boundedLineReader(MAX_LINE_CODE_UNITS, handleLine));

	const closeGrace = spec.closeGraceMs ?? CLOSE_GRACE_MS, killGrace = spec.killGraceMs ?? KILL_GRACE_MS;
	const waitClosed = async (ms: number) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try { await Promise.race([closedSignal.promise, new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })]); } finally { if (timer) clearTimeout(timer); }
		return closed;
	};
	/** Orderly EOF first, then TERM, then KILL. Returns whether a real `close` was observed. */
	const shutdown = async (): Promise<boolean> => {
		try { await pipe.end(); } catch { try { proc.stdin?.destroy(); } catch { /* already closed */ } }
		if (await waitClosed(closeGrace)) return true;
		kill("SIGTERM"); if (await waitClosed(killGrace)) return true;
		kill("SIGKILL"); return waitClosed(killGrace);
	};
	const raceCancel = <T>(promise: Promise<T>) => Promise.race([promise, cancelSignal.promise.then(() => { throw Object.assign(new Error("CANCELLED"), { cancelled: true }); })]);

	const run = async (): Promise<SpinoffChildOutcome> => {
		debug(spec.jobId, `spawned pid=${proc.pid}`);
		let usage: SpinoffUsage | undefined, output: string | undefined, failure: { code: string; message: string } | undefined;
		try {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const startup = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("startup deadline"), { code: "STARTUP_DEADLINE" })), STARTUP_MS); });
			let ready: { tools: string[]; sessionFile?: string };
			try { ready = await raceCancel(Promise.race([verified.promise, startup])); } finally { if (timer) clearTimeout(timer); }
			const want = new Set(spec.tools), got = new Set(ready.tools);
			if (want.size !== got.size || [...want].some(name => !got.has(name))) throw Object.assign(new Error("tool set differs from the parent selection"), { code: "CAPABILITY_MISMATCH" });
			const state = await raceCancel(pipe.request("get_state"));
			if (state?.sessionId !== spec.sessionId || (typeof state?.sessionFile === "string" && !existsSync(state.sessionFile))) throw Object.assign(new Error("native session identity mismatch"), { code: "CONFIG_CHANGED" });
			const before = usageOf(await raceCancel(pipe.request("get_session_stats")).catch((error: { cancelled?: boolean }) => { if (error?.cancelled) throw error; return undefined; }));
			debug(spec.jobId, "verified; sending prompt");
			onProgress("running");
			promptSent = true;
			const accepted = await raceCancel(pipe.request("prompt", { message: spec.prompt }));
			if (accepted?.disposition !== "started") throw Object.assign(new Error(`prompt disposition ${String(accepted?.disposition)}`), { code: "PROMPT_NOT_STARTED" });
			await raceCancel(quiescent.promise);
			debug(spec.jobId, "quiescent; collecting result");
			onProgress("finalizing");
			const text = await pipe.request("get_last_assistant_text").catch(() => undefined);
			output = typeof text?.text === "string" ? text.text : undefined;
			usage = delta(usageOf(await pipe.request("get_session_stats").catch(() => undefined)), before);
			if (lastAssistant?.stopReason === "error" || lastAssistant?.stopReason === "aborted") failure = { code: "CHILD_MODEL_ERROR", message: lastAssistant.errorMessage ?? `assistant stopped with ${lastAssistant.stopReason}` };
		} catch (error) {
			const e = error as { code?: string; message?: string; cancelled?: boolean };
			if (e?.cancelled || cancelled) cancelled = true;
			else failure = { code: rejectedCode ?? e?.code ?? (closed ? "CHILD_EXITED" : "CHILD_FAILED"), message: String(e?.message ?? error).slice(0, 500) };
		}
		if (cancelled) { onProgress("cancelling"); await Promise.race([pipe.request("abort").catch(() => undefined), waitClosed(1000)]); }
		debug(spec.jobId, `shutting down (closed=${closed}, cancelled=${cancelled})`);
		const childClosed = closed ? true : spawnError && proc.pid === undefined ? true : await shutdown();
		const base = { childClosed, exitCode, stderrTail, ...(usage ? { usage } : { usageUnknown: true }) };
		if (spawnError) return { ...base, status: "failed", errorCode: "SPAWN_FAILED", error: spawnError.message.slice(0, 500) };
		if (cancelled) return { ...base, status: "cancelled" };
		if (failure) return { ...base, status: "failed", errorCode: failure.code, error: failure.message };
		return { ...base, status: "completed", ...(output !== undefined ? { output } : {}) };
	};
	const done = run();
	return {
		get pid() { return proc.pid; },
		done,
		closed: closedSignal.promise.then(() => exitCode ?? null),
		// Only after the task was sent: queuing a message before the first prompt would reorder the Spinoff's own task.
		async steer(message: string, mode: SpinoffMessageMode) {
			if (!promptSent) throw Object.assign(new Error("CHILD_NOT_READY: the Spinoff child has not started its task yet"), { code: "CHILD_NOT_READY" });
			const response = await pipe.request(mode === "steer" ? "steer" : "follow_up", { message });
			return typeof response?.disposition === "string" ? response.disposition : "unknown";
		},
		async cancel() { if (cancelled) return; cancelled = true; cancelSignal.resolve(); uiAbort.abort(); },
	};
}
