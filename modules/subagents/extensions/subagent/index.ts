/**
 * Subagent Tool - delegates self-contained work to isolated child Pi processes.
 * Every task owns a managed native session and readable transcript; parent details are compact.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { ulid } from "ulid";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { buildSubagentPiArgs } from "./child-args.ts";
import { selectDispatchDefaults } from "./model-selection.ts";
import { ManagedSession, SessionError, ConversationDigest, canonicalCwd, snapshotConfig, validateConfig } from "./session-store.ts";
import {
	aggregateUsage,
	addUsage,
	compactResult,
	emptyUsage,
	formatParentResults,
	getResultOutput,
	isFailedResult,
	withLogPath,
	type CompactSubagentResult,
	type UsageStats,
} from "./result.ts";
import { consumeStdoutChunkAsync, isTerminalAssistantStopReason } from "./protocol.ts";
import { IoGate } from "./io-gate.ts";
import { ToolResultSpool, toolResultKey, type ToolSpoolRecord } from "./tool-result-spool.ts";
import { readGlobalDebugLogSetting, writeSubagentDebugFailure } from "./debug-log.ts";
import {
	appendBoundedUtf8,
	applyAssistantMessageUpdate,
	applyToolExecutionEnd,
	applyToolExecutionStart,
	applyToolExecutionUpdate,
	createLiveProgressState,
	hasLiveProgress,
	resetAssistantProgress,
	snapshotLiveProgress,
	type LiveProgress,
	type LiveProgressEntry,
} from "./progress.ts";
import {
	SubsessionWriter,
	collectAssistantText,
	callAlias,
	readableText,
	transcriptTimestamp,
	userRecords,
	type ReadableRecord,
	serializeAssistantContent,
	serializeToolResultContent,
	type SubsessionStatus,
} from "./subsession-log.ts";

const MAX_PARALLEL_TASKS = 32;
const MAX_CONCURRENCY = 8;
const PROGRESS_UPDATE_INTERVAL_MS = 80;
export const SUBAGENT_INACTIVITY_TIMEOUT_MS = 300_000;
const FORCE_KILL_DELAY_MS = 5000;
// Pi shell structuredContent can contain 1 MiB of output: JSON control-character
// escaping alone can expand it to 6 MiB. Leave bounded room for the event envelope.
export const SUBAGENT_MAX_STDOUT_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 512 * 1024;
// Retained content only: there is no cumulative wire-output limit.
const MAX_CAPTURED_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_RENDERED_ERROR_BYTES = 8 * 1024;
const MAX_PROMPT_AGENT_COUNT_PER_SCOPE = 64;
const MAX_PROMPT_AGENT_DESCRIPTION_CHARS = 240;

type SingleResult = CompactSubagentResult;

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	errorCode?: string;
	/** Ephemeral renderer-only progress; omitted from the final tool result. */
	progress?: LiveProgress[];
}

interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
	modelWasExplicit: boolean;
	thinkingLevelWasExplicit: boolean;
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(usage: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function appendBoundedText(current: string, next: string, maxBytes: number): string {
	return appendBoundedUtf8(current, next, maxBytes);
}

function errorToString(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAssistantContent(content: unknown): boolean {
	return Array.isArray(content) && content.every((part) => {
		if (!isRecord(part)) return false;
		if (part.type === "text") return typeof part.text === "string";
		if (part.type === "thinking") return typeof part.thinking === "string";
		if (part.type === "toolCall") {
			return typeof part.id === "string" && typeof part.name === "string" && isRecord(part.arguments);
		}
		return false;
	});
}

function getResultStatus(result: SingleResult): SubsessionStatus {
	if (result.stopReason === "aborted") return "aborted";
	return result.exitCode === 0 && result.stopReason !== "error" ? "completed" : "failed";
}

function getFailureDiagnostic(result: SingleResult): string {
	const diagnostic = result.errorMessage || "Subagent failed; inspect the sub-session log for diagnostics.";
	if (Buffer.byteLength(diagnostic, "utf8") <= MAX_RENDERED_ERROR_BYTES) return diagnostic;
	const suffix = "\n[Diagnostic truncated for display.]";
	const diagnosticBytes = Math.max(0, MAX_RENDERED_ERROR_BYTES - Buffer.byteLength(suffix, "utf8"));
	return `${appendBoundedText("", diagnostic, diagnosticBytes)}${suffix}`;
}

function singleLine(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

function liveEntryText(entry: LiveProgressEntry, width: number): string {
	if (width <= 0) return "";
	if (entry.kind !== "tool") return truncateToWidth(`${entry.kind}: ${singleLine(entry.text)}`, width, "…");
	const name = singleLine(entry.name) || "unknown";
	const prefix = `[${entry.status}] ${name}(`;
	const suffix = ")";
	if (visibleWidth(prefix) + visibleWidth(suffix) >= width) {
		return truncateToWidth(`${prefix}${singleLine(entry.arguments) || "..."}${suffix}`, width, "…");
	}
	const argumentWidth = width - visibleWidth(prefix) - visibleWidth(suffix);
	const argumentsText = truncateToWidth(singleLine(entry.arguments) || "...", argumentWidth, "…");
	return `${prefix}${argumentsText}${suffix}`;
}

class LiveProgressLine implements Component {
	private readonly entry: LiveProgressEntry;
	private readonly style: (text: string) => string;

	constructor(entry: LiveProgressEntry, style: (text: string) => string) {
		this.entry = entry;
		this.style = style;
	}

	render(width: number): string[] {
		return [this.style(liveEntryText(this.entry, width))];
	}

	invalidate(): void {}
}

function addLiveProgress(container: Container, progress: LiveProgress | undefined, style: (text: string) => string): void {
	for (const entry of progress?.entries ?? []) container.addChild(new LiveProgressLine(entry, style));
}

function formatAgentCatalog(agents: AgentConfig[]): string {
	if (agents.length === 0) return "  (none)";
	const shown = agents.slice(0, MAX_PROMPT_AGENT_COUNT_PER_SCOPE);
	const entries = shown.map((agent) => {
		const normalizedDescription = agent.description.replace(/\s+/g, " ").trim();
		const description =
			normalizedDescription.length > MAX_PROMPT_AGENT_DESCRIPTION_CHARS
				? `${normalizedDescription.slice(0, MAX_PROMPT_AGENT_DESCRIPTION_CHARS)}...`
				: normalizedDescription;
		return `  - ${JSON.stringify(agent.name)} (${agent.source}): ${JSON.stringify(description)}`;
	});
	if (agents.length > shown.length) entries.push(`  - ... ${agents.length - shown.length} more agents omitted from this prompt.`);
	return entries.join("\n");
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	try {
		await withFileMutationQueue(filePath, async () => {
			await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
		});
		return { dir: tmpDir, filePath };
	} catch (error) {
		await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function asToolUsage(results: SingleResult[]) {
	const usage = aggregateUsage(results);
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
	};
}

function appendAssistantOutput(current: string, message: unknown): string {
	const text = collectAssistantText([message]);
	return text ? (current ? `${current}\n\n${text}` : text) : current;
}

// Internal test seam: production always uses the same runner and argument builder.
export interface RunnerRuntime {
	invocation?: typeof getPiInvocation;
	inactivityTimeoutMs?: number;
	forceKillDelayMs?: number;
	ioTimeoutMs?: number;
	onResourceStats?: (stats: { retainedMessageBytes: number; maxStdoutRecordBytes: number; maxStdoutChunkBytes: number; maxStderrChunkBytes: number }) => void;
	/** Test seam; production reads `settings["pi-subagents"].debugLog` from global settings.json. */
	debugLog?: boolean;
	/** Test seam; production resolves the global settings directory via getAgentDir(). */
	settingsAgentDir?: string;
	debugLogDir?: string;
	debugLogWriter?: typeof writeSubagentDebugFailure;
	sessionRootDir?: string;
	resumeSession?: ManagedSession;
	agentScope?: AgentScope;
	projectTrusted?: boolean;
	validateResumeConfig?: () => Promise<void>;
}

export function expandChainTask(task: string, previousOutput: string): string {
	return task.replace(/\{previous\}/g, () => previousOutput);
}

export async function runSingleAgent(
	defaultCwd: string, dispatchDefaults: DispatchDefaults, agents: AgentConfig[], agentName: string,
	task: string, cwd: string | undefined, step: number | undefined, signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[], progress?: LiveProgress[]) => SubagentDetails,
	parentSessionId: string, parentToolCallId: string, runtime: RunnerRuntime = {},
): Promise<SingleResult> {
	const agent = runtime.resumeSession?.manifest.config.agent ?? agents.find((candidate) => candidate.name === agentName);
	const model = runtime.resumeSession?.manifest.config.model ?? (dispatchDefaults.modelWasExplicit ? dispatchDefaults.model : agent?.model ?? dispatchDefaults.model);
	const taskId = ulid().toLowerCase();
	const debugInput = { agent: agentName, task, taskPrompt: `Task: ${task}`, systemPrompt: agent?.systemPrompt };
	const currentResult = compactResult({ taskId, agent: agentName, agentSource: agent?.source ?? "unknown",
		task, status: "running", exitCode: -1, output: "", usage: emptyUsage(), model, step });
	const io = new IoGate(runtime.ioTimeoutMs);
	let managed = runtime.resumeSession;
	let lockHeld = false;
	let runStarted = false;
	let integrityFailure = false;
	const digest = new ConversationDigest();
	let nativeHeaderReceived = false;
	const loggedCalls = new Set<string>();
	const toolResultStates = new Map<string, { canonical: boolean; logged: boolean }>();
	let userOrdinal = 0;
	let writer: SubsessionWriter | undefined;
	let spool: ToolResultSpool | undefined;
	let tmpPromptDir: string | undefined;
	let wasAborted = false;
	let cause: "abort" | "timeout" | "protocol" | "io" | undefined;
	const startupAbort = () => {
		if (io.stopped || cause) return;
		cause = "abort";
		wasAborted = true;
		io.stop(new Error("Subagent was aborted during log initialization"));
	};
	signal?.addEventListener("abort", startupAbort, { once: true });
	let transcriptBroken = false;
	let stderrDiagnostic = "";
	let internalDiagnostic = "";
	let capturedMessageBytes = 0;
	let maxStdoutRecordBytes = 0;
	let maxStdoutChunkBytes = 0;
	let maxStderrChunkBytes = 0;
	const liveProgress = createLiveProgressState();
	let progressTimer: ReturnType<typeof setTimeout> | undefined;
	let progressPending = false;
	let progressClosed = false;
	const recordInternalError = (text: string) => {
		internalDiagnostic = appendBoundedText(internalDiagnostic, `\n[${text}]`, MAX_RENDERED_ERROR_BYTES);
	};
	const reserveCapturedBytes = (bytes: number) => {
		if (capturedMessageBytes + bytes > MAX_CAPTURED_MESSAGE_BYTES) throw new Error("Subagent retained message memory exceeded the safety limit; inspect the sub-session log for diagnostics.");
		capturedMessageBytes += bytes;
	};
	const emitUpdateNow = () => {
		if (!onUpdate || progressClosed) return;
		try {
			const progress = snapshotLiveProgress(liveProgress, currentResult);
			onUpdate({ content: [{ type: "text", text: withLogPath(currentResult, currentResult.output || "(running...)") }], details: makeDetails([currentResult], hasLiveProgress(progress) ? [progress] : undefined) });
		} catch (error) { recordInternalError(`Subagent progress update failed: ${errorToString(error)}`); }
	};
	const flushProgress = () => {
		if (progressTimer) clearTimeout(progressTimer);
		progressTimer = undefined;
		if (!progressPending) return;
		progressPending = false;
		emitUpdateNow();
	};
	const requestProgressUpdate = (immediate = false) => {
		if (!onUpdate || progressClosed) return;
		progressPending = true;
		if (immediate) flushProgress();
		else if (!progressTimer) progressTimer = setTimeout(flushProgress, PROGRESS_UPDATE_INTERVAL_MS);
	};
	const loggingIo = async <T>(operation: () => Promise<T>, label: string, gate = io): Promise<T> => {
		try { return await gate.run(operation, label); }
		catch (error) { transcriptBroken = true; throw error; }
	};
	const writeRecord = async (record: ReadableRecord, gate = io) => {
		if (!writer) return;
		while (true) {
			if (gate.stopped) throw new Error("Sub-session write interrupted before admission");
			const admission = writer.tryAppend(record);
			if (admission.status === "failed") { transcriptBroken = true; throw new Error(admission.error); }
			if (admission.status === "backpressure") { await loggingIo(() => admission.ready, "writer capacity", gate); continue; }
			const completion = await loggingIo(() => admission.completion, "JSONL write", gate);
			if (completion.error) { transcriptBroken = true; throw new Error(completion.error); }
			return;
		}
	};
	const writeCall = async (id: string, name: string, argumentsValue: Record<string, unknown>, timestamp?: unknown) => {
		const alias = callAlias(taskId, id);
		if (loggedCalls.has(alias)) return;
		reserveCapturedBytes(Buffer.byteLength(alias) + 64);
		await writeRecord({ type: "tool_call", timestamp: transcriptTimestamp(timestamp), callId: alias, name, arguments: argumentsValue });
		loggedCalls.add(alias);
	};
	const toolResultState = (key: string) => {
		let state = toolResultStates.get(key);
		if (!state) {
			// One bounded identity for both native digest and readable-log acknowledgement.
			reserveCapturedBytes(Buffer.byteLength(key, "utf8") + 64);
			state = { canonical: false, logged: false };
			toolResultStates.set(key, state);
		}
		return state;
	};
	const appendToolResult = async (record: ToolSpoolRecord, gate = io, sourceUsage?: unknown) => {
		const key = toolResultKey(record), state = toolResultState(key);
		if (state.logged) return;
		// Only canonical message usage is authoritative. Root results already include
		// nested execution usage; execution-only fallbacks must not add it again.
		const usage = isRecord(sourceUsage) ? emptyUsage() : undefined;
		if (usage) { addUsage(usage, sourceUsage); addUsage(currentResult.usage, sourceUsage); }
		await writeRecord({ type: "tool_result", timestamp: record.timestamp, callId: callAlias(taskId, record.toolCallId ?? `anonymous:${key}`), isError: record.isError === true, content: readableText(record.serialized) }, gate);
		state.logged = true;
		if (spool) await loggingIo(() => spool!.remove(record), "remove acknowledged fallback", gate);
	};
	const queueToolResult = async (record: ToolSpoolRecord) => {
		if (io.stopped || !writer || toolResultStates.get(toolResultKey(record))?.logged) return;
		if (!spool) {
			spool = await loggingIo(() => ToolResultSpool.create(path.dirname(writer!.partialPath)), "create tool spool");
		}
		await loggingIo(() => spool!.put(record), "persist tool fallback");
	};
	const makeToolResult = (message: Record<string, unknown>, content: unknown): ToolSpoolRecord => ({
		toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
		toolName: typeof message.toolName === "string" ? message.toolName : undefined,
		isError: typeof message.isError === "boolean" ? message.isError : undefined,
		serialized: serializeToolResultContent(content),
		timestamp: transcriptTimestamp(message.timestamp),
	});
	try {
		if (signal?.aborted) { wasAborted = true; throw new Error("Subagent dispatch skipped because the parent request was aborted."); }
		if (!agent) throw new Error(`Unknown agent: "${agentName}". Available agents: ${agents.map((entry) => `"${entry.name}"`).join(", ") || "none"}.`);
		if (Buffer.byteLength(JSON.stringify(`Task: ${task}`)) + 64 * 1024 > SUBAGENT_MAX_STDOUT_RECORD_BYTES) throw new SessionError("INVALID_DISPATCH", "Task may exceed the bounded CLI user envelope");
		if (!managed) {
			const owner = { parentSessionId, parentCwd: await io.run(() => canonicalCwd(defaultCwd), "canonical parent cwd") };
			const shouldPass = dispatchDefaults.thinkingLevelWasExplicit || (!agent.model && !dispatchDefaults.modelWasExplicit);
			const config = await io.run(() => snapshotConfig(agent, runtime.agentScope ?? "user", cwd ?? defaultCwd, model, shouldPass ? dispatchDefaults.thinkingLevel : undefined, runtime.projectTrusted === true), "snapshot configuration");
			managed = await io.run(() => ManagedSession.allocate(runtime.sessionRootDir ?? path.join(getAgentDir(), "subagent-sessions"), owner, config), "allocate managed session");
		}
		currentResult.subagentSessionId = managed.id; currentResult.canResume = false;
		await io.run(() => managed!.acquire(taskId), "acquire managed writer"); lockHeld = true;
		if (runtime.resumeSession) {
			try { await io.run(() => managed!.validateCheckpoint(), "validate native checkpoint"); }
			catch (error) { integrityFailure = error instanceof SessionError && ["CHECKPOINT_MISMATCH"].includes(error.code); throw error; }
			if (runtime.validateResumeConfig) await io.run(runtime.validateResumeConfig, "revalidate saved configuration");
		}
		await io.run(() => managed!.begin(taskId, parentToolCallId, task, () => !io.stopped), "begin managed run"); runStarted = true;
		try {
			writer = await io.run(async () => {
				const created = await SubsessionWriter.create({ formatVersion: 2, stagingDir: managed!.runDir, rootDir: managed!.directory, parentSessionId, parentToolCallId, taskId, agent: agentName, agentSource: currentResult.agentSource, task, cwd: cwd ?? defaultCwd, model });
				if (io.stopped) created.abandon("Log creation completed after I/O timeout");
				return created;
			}, "create sub-session log");
		} catch (error) {
			currentResult.logError = `Unable to create sub-session log: ${errorToString(error)}`;
			throw error;
		}
		if (signal?.aborted) {
			wasAborted = true;
			throw new Error("Subagent dispatch skipped because the parent request was aborted.");
		}
		if (!agent) throw new Error(`Unknown agent: "${agentName}". Available agents: ${agents.map((entry) => `"${entry.name}"`).join(", ") || "none"}.`);
		const shouldPassThinking = dispatchDefaults.thinkingLevelWasExplicit || (!agent.model && !dispatchDefaults.modelWasExplicit);
		const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
		tmpPromptDir = tmp.dir;
		const taskPath = path.join(tmp.dir, "task.txt");
		await fs.promises.writeFile(taskPath, `Task: ${task}`, { encoding: "utf8", mode: 0o600 });
		if (signal?.aborted) { wasAborted = true; throw new Error("Subagent was aborted before spawn"); }
		const args = buildSubagentPiArgs({ persistence: managed.persistence, guardPath: fileURLToPath(new URL("./child-guard.ts", import.meta.url)), model, thinkingLevel: runtime.resumeSession?.manifest.config.thinkingLevel ?? (shouldPassThinking ? dispatchDefaults.thinkingLevel : undefined), tools: agent.tools, promptPath: agent.systemPrompt.trim() ? tmp.filePath : undefined, taskPath });
		signal?.removeEventListener("abort", startupAbort);
		const invocation = (runtime.invocation ?? getPiInvocation)(args);
		currentResult.exitCode = await new Promise<number>((resolve) => {
			let proc: ReturnType<typeof spawn>;
			try { proc = spawn(invocation.command, invocation.args, { cwd: cwd ?? defaultCwd, shell: false, stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, PI_SUBAGENTS_GUARD: JSON.stringify({ id: managed!.id, cwd: managed!.manifest.config.cwd, model, thinkingLevel: managed!.manifest.config.thinkingLevel, childTrusted: managed!.manifest.config.childTrusted, startupPath: managed!.startupPath }) } }); }
			catch (error) { currentResult.errorMessage = `Subagent process failed to start: ${errorToString(error)}`; resolve(1); return; }
			// Count activity before decoding, including incomplete UTF-8 code points.
			const stdoutDecoder = new StringDecoder("utf8");
			const stderrDecoder = new StringDecoder("utf8");
			const stdoutState = { buffer: "", finished: false };
			let terminalAssistantReceived = false;
			let settled = false;
			let childClosed = false;
			let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
			let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
			const inactivityMs = Number.isFinite(runtime.inactivityTimeoutMs) ? Math.max(1, runtime.inactivityTimeoutMs!) : SUBAGENT_INACTIVITY_TIMEOUT_MS;
			const forceKillMs = Number.isFinite(runtime.forceKillDelayMs) ? Math.max(1, runtime.forceKillDelayMs!) : FORCE_KILL_DELAY_MS;
			let remaining = inactivityMs;
			let deadline = 0;
			let ioPaused = false;
			const clearInactivity = () => { if (inactivityTimer) clearTimeout(inactivityTimer); inactivityTimer = undefined; };
			const terminate = () => {
				try { proc.kill("SIGTERM"); } catch { /* already gone */ }
				if (!forceKillTimer && !childClosed) {
					forceKillTimer = setTimeout(() => {
						if (proc.exitCode === null && proc.signalCode === null) { try { proc.kill("SIGKILL"); } catch { /* gone */ } }
					}, forceKillMs);
					forceKillTimer.unref();
				}
			};
			const fail = (reason: typeof cause, message: string) => {
				if (cause || settled) return;
				cause = reason;
				stdoutState.finished = true;
				clearInactivity();
				if (reason === "abort") wasAborted = true;
				currentResult.stopReason = reason === "abort" ? "aborted" : "error";
				currentResult.errorMessage = message;
				recordInternalError(message);
				if (reason === "io") transcriptBroken = true;
				io.stop(new Error(message));
				terminate();
				// Breaking the stream pumps is independent of slow/stalled filesystem writes.
				proc.stdout.destroy();
				proc.stderr.destroy();
			};
			const armInactivity = () => {
				clearInactivity();
				if (settled || childClosed || cause || ioPaused) return;
				deadline = performance.now() + remaining;
				inactivityTimer = setTimeout(() => {
					const duration = inactivityMs % 1000 === 0 ? `${inactivityMs / 1000} seconds` : `${inactivityMs} ms`;
					fail("timeout", `Subagent produced no stdout or stderr for ${duration} and was terminated.`);
				}, remaining);
				inactivityTimer.unref();
			};
			const activity = () => { if (!stdoutState.finished && !cause) { remaining = inactivityMs; armInactivity(); } };
			io.onWaitingChange = (count) => {
				if (stdoutState.finished) return; // trailing writes cannot renew the settled close deadline
				if (count > 0 && !ioPaused) {
					if (inactivityTimer) remaining = Math.max(1, deadline - performance.now());
					ioPaused = true;
					clearInactivity();
				} else if (count === 0 && ioPaused) { ioPaused = false; armInactivity(); }
			};
			const abortListener = () => fail("abort", "Subagent was aborted");
			const settle = (code: number) => {
				if (settled) return;
				settled = true;
				progressClosed = true;
				if (progressTimer) clearTimeout(progressTimer);
				progressTimer = undefined;
				clearInactivity();
				if (forceKillTimer) clearTimeout(forceKillTimer);
				signal?.removeEventListener("abort", abortListener);
				io.onWaitingChange = () => {};
				resolve(code);
			};
			const validateKnownEvent = (event: Record<string, unknown>): void => {
				if (event.type === "message_update") {
					const update = event.assistantMessageEvent;
					if (!isRecord(update) || typeof update.type !== "string") throw new Error("Subagent emitted an invalid message_update.");
					if (["text_start", "text_delta", "text_end", "thinking_start", "thinking_delta", "thinking_end", "toolcall_start", "toolcall_delta", "toolcall_end"].includes(update.type) && (!Number.isInteger(update.contentIndex) || (update.contentIndex as number) < 0)) throw new Error("Invalid streaming content index.");
					if (["text_delta", "thinking_delta", "toolcall_delta"].includes(update.type) && typeof update.delta !== "string") throw new Error("Invalid streaming delta.");
					if (["text_end", "thinking_end"].includes(update.type) && typeof update.content !== "string") throw new Error("Invalid streaming end.");
					if (update.type === "toolcall_start" && (typeof update.id !== "string" || typeof update.toolName !== "string")) throw new Error("Invalid toolcall_start.");
					if (update.type === "toolcall_end" && !isRecord(update.toolCall)) throw new Error("Invalid toolcall_end.");
				}
				if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(String(event.type))) {
					if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string" || (event.type === "tool_execution_end" && typeof event.isError !== "boolean")) throw new Error("Invalid tool execution event.");
				}
				if (["message_start", "message_end", "tool_result_end"].includes(String(event.type)) && !isRecord(event.message)) throw new Error("Invalid message event.");
			};
			const processLine = async (line: string) => {
				if (stdoutState.finished || !line.trim()) return;
				maxStdoutRecordBytes = Math.max(maxStdoutRecordBytes, Buffer.byteLength(line, "utf8"));
				const event: unknown = JSON.parse(line);
				if (!isRecord(event)) throw new Error("Subagent emitted a malformed JSON protocol record.");
				validateKnownEvent(event);
				if (event.type === "session" && managed) {
					if (nativeHeaderReceived || event.id !== managed.id || event.version !== 3 || event.cwd !== managed.manifest.config.cwd) throw new SessionError("CHECKPOINT_MISMATCH", "Stdout native session identity mismatch");
					nativeHeaderReceived = true; return;
				}
				if (event.type === "agent_settled") {
					// A completed assistant response may be followed by retry/recovery or
					// queued work. Only session settlement closes this one-prompt protocol.
					stdoutState.finished = true; ioPaused = false; remaining = inactivityMs; armInactivity(); return;
				}
				if (event.type === "agent_start") { terminalAssistantReceived = false; return; }
				if (event.type === "message_start" && isRecord(event.message) && event.message.role === "assistant") { terminalAssistantReceived = false; resetAssistantProgress(liveProgress); requestProgressUpdate(); return; }
				if (event.type === "message_update") {
					applyAssistantMessageUpdate(liveProgress, event);
					const type = (event.assistantMessageEvent as Record<string, unknown>).type;
					requestProgressUpdate(type === "text_end" || type === "thinking_end" || type === "toolcall_end"); return;
				}
				if (event.type === "tool_execution_start") {
					applyToolExecutionStart(liveProgress, event); requestProgressUpdate(true);
					const serialized = serializeAssistantContent([{ type: "toolCall", id: event.toolCallId, name: event.toolName, arguments: event.args ?? {} }]);
					const call = serialized.content[0];
					if (call?.type === "toolCall") await writeCall(event.toolCallId as string, call.name, call.arguments, event.timestamp);
					return;
				}
				if (event.type === "tool_execution_update") { applyToolExecutionUpdate(liveProgress, event); requestProgressUpdate(); return; }
				if (event.type === "tool_execution_end") {
					applyToolExecutionEnd(liveProgress, event); requestProgressUpdate(true);
					await queueToolResult(makeToolResult(event, isRecord(event.result) ? event.result.content : event.result)); return;
				}
				if (!isRecord(event.message)) return;
				const message = event.message;
				if ((event.type === "message_end" || event.type === "tool_result_end") && message.role === "toolResult") {
					const resultRecord = makeToolResult(message, message.content), key = toolResultKey(resultRecord);
					const state = toolResultState(key);
					if (event.type === "message_end" && !state.canonical) { state.canonical = true; digest.add(message); }
					await appendToolResult(resultRecord, io, message.usage); requestProgressUpdate(); return;
				}
				if (event.type === "message_end" && message.role === "user") {
					digest.add(message);
					const text = typeof message.content === "string" ? message.content : readableText(serializeToolResultContent(message.content));
					for (const user of userRecords(text, taskId, userOrdinal++, message.timestamp)) await writeRecord(user);
					return;
				}
				if (event.type !== "message_end" || message.role !== "assistant") return;
				if (!isAssistantContent(message.content) || (!isTerminalAssistantStopReason(message.stopReason) && message.stopReason !== "toolUse")) throw new Error("Subagent emitted a malformed assistant message.");
				digest.add(message);
				const serialized = serializeAssistantContent(message.content);
				for (const part of serialized.content) {
					if (part.type === "text") await writeRecord({ type: "assistant", timestamp: transcriptTimestamp(message.timestamp), content: part.text });
					else await writeCall(part.id ?? `anonymous:${loggedCalls.size}`, part.name, part.arguments, message.timestamp);
				}
				if (cause) return;
				const nextOutput = appendAssistantOutput(currentResult.output, message);
				reserveCapturedBytes(Buffer.byteLength(nextOutput, "utf8") - Buffer.byteLength(currentResult.output, "utf8"));
				currentResult.output = nextOutput;
				currentResult.usage.turns++;
				if (isRecord(message.usage)) {
					addUsage(currentResult.usage, message.usage);
					currentResult.usage.contextTokens = finiteNumber(message.usage.totalTokens);
				}
				if (!currentResult.model && typeof message.model === "string") currentResult.model = message.model;
				currentResult.stopReason = message.stopReason as string;
				currentResult.errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
				terminalAssistantReceived = isTerminalAssistantStopReason(message.stopReason);
				requestProgressUpdate(true);
				resetAssistantProgress(liveProgress, message.stopReason === "toolUse");
			};
			const pumpStdout = async () => {
				try {
					for await (const chunk of proc.stdout) {
						maxStdoutChunkBytes = Math.max(maxStdoutChunkBytes, Buffer.byteLength(chunk, "utf8"));
						activity();
						if (await consumeStdoutChunkAsync(stdoutState, stdoutDecoder.write(chunk), SUBAGENT_MAX_STDOUT_RECORD_BYTES, processLine)) throw new Error("Subagent stdout record exceeded the safety limit; inspect the sub-session log for diagnostics.");
					}
					if (await consumeStdoutChunkAsync(stdoutState, stdoutDecoder.end(), SUBAGENT_MAX_STDOUT_RECORD_BYTES, processLine)) throw new Error("Subagent stdout record exceeded the safety limit.");
					if (!stdoutState.finished && stdoutState.buffer.trim()) { await processLine(stdoutState.buffer); stdoutState.buffer = ""; }
				} catch (error) { fail(transcriptBroken || io.stopped ? "io" : "protocol", `Subagent stdout processing failed: ${errorToString(error)}`); }
			};
			const pumpStderr = async () => {
				try {
					for await (const chunk of proc.stderr) {
						maxStderrChunkBytes = Math.max(maxStderrChunkBytes, Buffer.byteLength(chunk, "utf8"));
						activity();
						const text = stderrDecoder.write(chunk);
						stderrDiagnostic = appendBoundedText(stderrDiagnostic, text, MAX_STDERR_BYTES);

					}
					const tail = stderrDecoder.end();
					stderrDiagnostic = appendBoundedText(stderrDiagnostic, tail, MAX_STDERR_BYTES);
				} catch (error) { fail("io", `Subagent stderr processing failed: ${errorToString(error)}`); }
			};
			// Start at most two bounded consumers; no data-event promise queues.
			const pumps = [pumpStdout(), pumpStderr()];
			proc.on("close", (code, signalCode) => {
				childClosed = true;
				clearInactivity();
				if (forceKillTimer) clearTimeout(forceKillTimer);
				void Promise.all(pumps).then(() => {
					if (!terminalAssistantReceived && !cause) { currentResult.stopReason = "error"; currentResult.errorMessage ??= "Subagent exited without a terminal assistant message (incomplete JSON protocol)."; }
					if (signalCode && !wasAborted && currentResult.stopReason !== "aborted") { currentResult.stopReason = "error"; currentResult.errorMessage ??= `Subagent process terminated by ${signalCode}.`; }
					flushProgress(); settle(code ?? (signalCode ? 1 : 0));
				}).catch((error) => { recordInternalError(errorToString(error)); settle(1); });
			});
			proc.on("error", (error) => { fail("protocol", `Subagent process failed to start: ${errorToString(error)}`); settle(1); });
			if (signal?.aborted) abortListener(); else signal?.addEventListener("abort", abortListener, { once: true });
			armInactivity();
		});
		if (!wasAborted && !cause) await io.run(() => managed!.acceptStartup(), "verify child startup handshake");
		if (wasAborted) currentResult.stopReason = "aborted";
		if (currentResult.exitCode !== 0 && !currentResult.errorMessage) currentResult.errorMessage = `Subagent process exited with code ${currentResult.exitCode}; inspect the sub-session log for diagnostics.`;
	} catch (error) {
		cause ??= wasAborted ? "abort" : "protocol";
		currentResult.exitCode = 1;
		currentResult.stopReason = wasAborted ? "aborted" : "error";
		currentResult.errorMessage ??= errorToString(error);
		if (error instanceof SessionError) { currentResult.errorCode = error.code; currentResult.errorMessage = errorToString(error); }
		recordInternalError(`Subagent dispatch failed: ${errorToString(error)}`);
	} finally {
		progressClosed = true;
		if (progressTimer) clearTimeout(progressTimer);
		io.onWaitingChange = () => {};
		signal?.removeEventListener("abort", startupAbort);
		const finalIo = new IoGate(runtime.ioTimeoutMs);
		const cleanupIo = new IoGate(runtime.ioTimeoutMs);
		const finalAbort = () => {
			if (cause || finalIo.stopped) return;
			cause = "abort";
			wasAborted = true;
			currentResult.stopReason = "aborted";
			currentResult.errorMessage ??= "Subagent was aborted during log finalization";
			finalIo.stop(new Error(currentResult.errorMessage));
		};
		// Already-aborted children may still finish a healthy log; new aborts interrupt finalization.
		if (!signal?.aborted) signal?.addEventListener("abort", finalAbort, { once: true });
		try {
			if (io.pendingOperations > 0 || transcriptBroken) throw new Error("Sub-session logging interrupted; active I/O or failed transcript preserved");
			if (spool) {
				const iterator = spool.records();
				try {
					while (true) {
						const next = await finalIo.run(() => iterator.next(), "read tool fallback");
						if (next.done) break;
						await appendToolResult(next.value, finalIo);
					}
				} finally {
					// return() queues behind a pending next(); do not wait forever or delete its files.
					const closing = iterator.return(undefined);
					if (finalIo.stopped) void closing.catch(() => {});
					else await finalIo.run(() => closing, "close spool iterator");
				}
			}
			currentResult.status = getResultStatus(currentResult);
			if (writer) {
				const result = await finalIo.run(() => writer!.finalize({ status: currentResult.status as SubsessionStatus, exitCode: currentResult.exitCode, stopReason: currentResult.stopReason, errorMessage: currentResult.errorMessage, usage: currentResult.usage }), "finalize sub-session log");
				if (result.error) throw new Error(result.error);
				currentResult.logPath = result.logPath;
			}
			if (spool) await finalIo.run(() => spool!.cleanup(), "cleanup tool spool");
			if (managed && runStarted && currentResult.status === "completed") {
				if (!nativeHeaderReceived) throw new SessionError("CHECKPOINT_MISMATCH", "Missing stdout native session header");
				if (!writer || !currentResult.logPath) throw new SessionError("COMMIT_FAILED", "No complete readable segment");
				await finalIo.run(() => managed!.commit(writer!.finalPath, digest, { ...invocationMetadata(currentResult), stderr: appendBoundedText("", stderrDiagnostic, 32 * 1024), diagnostic: internalDiagnostic }, () => !finalIo.stopped && !io.stopped), "commit managed run");
				currentResult.logPath = managed.logPath;
				currentResult.canResume = true;
			}
		} catch (error) {
			const diagnostic = `${errorToString(error)}${writer ? `; partial log: ${writer.partialPath}; final target (rename may still be pending): ${writer.finalPath}` : ""}${spool ? `; spool: ${spool.directory}` : ""}`;
			currentResult.logError ??= diagnostic;
			const abandonment = writer?.abandon(diagnostic);
			if (managed && abandonment && io.pendingOperations === 0 && finalIo.pendingOperations === 0) {
				try { await cleanupIo.run(() => abandonment, "close abandoned managed transcript"); }
				catch (closeError) { currentResult.logError = `${currentResult.logError}; ${errorToString(closeError)}`; }
			}
			if (error instanceof SessionError) currentResult.errorCode = error.code;
			if ((!currentResult.logPath || managed) && currentResult.stopReason !== "aborted") { currentResult.stopReason = "error"; currentResult.errorMessage ??= diagnostic; }
			currentResult.canResume = false;
		}
		if (managed && !currentResult.canResume && runStarted) currentResult.errorCode ??= "COMMIT_FAILED";
		if (managed && lockHeld && io.pendingOperations === 0 && finalIo.pendingOperations === 0 && cleanupIo.pendingOperations === 0 && !cleanupIo.stopped) {
			try {
				if (!currentResult.canResume && (runStarted || integrityFailure)) await cleanupIo.run(() => managed!.blocked(currentResult.errorCode ?? "COMMIT_FAILED", { ...invocationMetadata(currentResult), stderr: appendBoundedText("", stderrDiagnostic, 32 * 1024), diagnostic: internalDiagnostic }, () => !cleanupIo.stopped), "block managed run");
				if (!cleanupIo.stopped && cleanupIo.pendingOperations === 0) await cleanupIo.run(() => managed!.release(), "release managed writer");
			} catch (error) { currentResult.canResume = false; currentResult.stopReason = "error"; currentResult.errorMessage ??= errorToString(error); currentResult.logError ??= errorToString(error); }
		}
		signal?.removeEventListener("abort", finalAbort);
		if (tmpPromptDir) { try { await fs.promises.rm(tmpPromptDir, { recursive: true, force: true }); } catch (error) { currentResult.logError ??= `Prompt cleanup failed: ${errorToString(error)}`; } }
		currentResult.status = getResultStatus(currentResult);
		if (runtime.debugLog === true && currentResult.status === "failed") {
			// Bounded like other finalization I/O; aborts stop waiting without changing the result.
			const debugIo = new IoGate(runtime.ioTimeoutMs);
			const debugAbort = () => debugIo.stop(new Error("Subagent was aborted during debug log write"));
			if (!signal?.aborted) signal?.addEventListener("abort", debugAbort, { once: true });
			const writeDebugFailure = runtime.debugLogWriter ?? writeSubagentDebugFailure;
			try {
				await debugIo.run(() => writeDebugFailure({
					taskId,
					input: debugInput,
					status: currentResult.status,
					exitCode: currentResult.exitCode,
					stopReason: currentResult.stopReason,
					errorMessage: currentResult.errorMessage,
					finalResponse: currentResult.output,
					subsessionLogPath: currentResult.logPath,
					subsessionLogError: currentResult.logError,
				}, { logsDir: runtime.debugLogDir }), "write debug failure log");
			} catch { /* optional diagnostics must never change dispatch results */ }
			signal?.removeEventListener("abort", debugAbort);
		}
	}
	try { runtime.onResourceStats?.({ retainedMessageBytes: capturedMessageBytes, maxStdoutRecordBytes, maxStdoutChunkBytes, maxStderrChunkBytes }); } catch { /* test observers cannot affect settlement */ }
	return currentResult;
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});
const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});
const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user".',
	default: "user",
});
const ThinkingLevelSchema = Type.String({
	description: "Omit by default; pass only when explicitly requested by the user or a skill. Pi thinking level (off, minimal, low, medium, high, xhigh, max). Checked after resolving the model; unknown or unsupported levels are ignored and defaults are used.",
});
const SubagentParams = Type.Object({
	resume: Type.Optional(Type.String({ description: "Complete managed subagentSessionId to continue; only accepts a new task, no config overrides." })),
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	provider: Type.Optional(Type.String({ description: "Omit by default; pass only when the user or a skill explicitly requests a model/provider override. Requires a bare model ID and combines as provider/model; an unregistered selection is ignored." })),
	model: Type.Optional(Type.String({ description: "Omit by default; pass only when explicitly requested by the user or a skill. Exact model ID or provider/model; a registered selection overrides the agent/current session model. Unknown or ambiguous selections are ignored and defaults are used." })),
	thinkingLevel: Type.Optional(ThinkingLevelSchema),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export function normalizeDispatch(params: Record<string, any>): "single" | "parallel" | "chain" | "resume" {
	if (Object.hasOwn(params, "resumable")) throw new SessionError("INVALID_DISPATCH", "resumable was removed: every initial task automatically uses a managed native session. Omit this parameter.");
	const present = (key: string) => params[key] !== undefined;
	const nonblank = (v: unknown) => typeof v === "string" && !!v.trim();
	if (present("resume")) {
		if (Object.keys(params).some((key) => !["resume", "task"].includes(key)) || !nonblank(params.resume) || !nonblank(params.task)) throw new SessionError("INVALID_DISPATCH", "resume accepts only a complete session ID and nonempty new task");
		return "resume";
	}
	const modes = Number(present("agent")) + Number(present("tasks")) + Number(present("chain"));
	if (modes !== 1) throw new SessionError("INVALID_DISPATCH", "Invalid parameters. Provide exactly one dispatch mode");
	if (present("agent")) {
		if (!nonblank(params.agent) || !nonblank(params.task)) throw new SessionError("INVALID_DISPATCH", "Single mode requires a nonempty agent and task");
		return "single";
	}
	if (present("task")) throw new SessionError("INVALID_DISPATCH", "Top-level task requires single or resume mode");
	const mode = present("tasks") ? "parallel" : "chain", items = params[mode === "parallel" ? "tasks" : "chain"];
	if (!Array.isArray(items) || !items.length || items.some((item) => !isRecord(item) || !nonblank(item.agent) || !nonblank(item.task) || Object.keys(item).some((key) => !["agent", "task", "cwd"].includes(key)))) throw new SessionError("INVALID_DISPATCH", "Dispatch items require nonempty agent/task; nested resume is unsupported");
	return mode;
}

function invocationMetadata(result: SingleResult) {
	return { taskId: result.taskId, subagentSessionId: result.subagentSessionId, status: getResultStatus(result), exitCode: result.exitCode,
		stopReason: result.stopReason, errorCode: result.errorCode, errorMessage: result.errorMessage ? appendBoundedText("", result.errorMessage, MAX_RENDERED_ERROR_BYTES) : undefined,
		usage: result.usage, logPath: result.logPath, model: result.model };
}

export default function (pi: ExtensionAPI, runtime: RunnerRuntime = {}) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized agents with isolated context.",
			"Provide exactly one mode: single (agent + task), parallel (tasks array), chain (steps with {previous}), or resume (complete subagentSessionId + new task).",
			"Every initial task automatically saves a managed native session; there is no non-persistent mode or resumable parameter. Resume accepts no configuration overrides and belongs to the same parent session/cwd; only verified ready sessions can continue.",
			`Dispatch limits: parallel mode accepts at most ${MAX_PARALLEL_TASKS} tasks and runs at most ${MAX_CONCURRENCY} at once.`,
			"Chain steps run in order, pass each complete assistant-text output into {previous}, and stop at the first failed step.",
			"Each task records its non-reasoning child transcript in a sub-session JSONL log; parent results contain only assistant output, status, usage, and the log path.",
			"Omit provider, model, and thinkingLevel by default; pass overrides only when explicitly requested by the user or a skill. Resolve the model first, then check its supported thinking levels before spawning each child. Unknown or ambiguous models and unknown or unsupported thinking levels are ignored in favor of defaults. provider requires a bare model ID; alternatively pass provider/model as model.",
			"Child Pi processes always exclude the subagent tool, so subagents cannot recursively dispatch further subagents through this tool.",
			"Default agent scope is \"user\": bundled package agents plus user agents.",
			`User agents are loaded from ${path.join(getAgentDir(), "agents")}. To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		promptSnippet: "Delegate a self-contained task to an isolated subagent context",
		promptGuidelines: [
			"Omit model, provider, and thinkingLevel unless the user or a skill explicitly specifies them. Do not choose overrides on your own; invalid selections fall back to defaults after model-first validation.",
			"Initial subagent dispatches have clean isolated context, with no parent conversation. Include the goal, complete action, relevant paths/references, constraints/non-goals, operating instructions, and handoff format.",
			"Every task is automatically persisted. A child can return questions and exit normally; use its returned ready subagentSessionId to resume after a decision. Do not keep it alive waiting for decisions.",
			"Resume with the returned complete subagentSessionId and a concrete new decision/task. It loads only that child's native history, not the parent chat. Do not repost logs or omit necessary new information.",
		],
		parameters: SubagentParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			let mode: ReturnType<typeof normalizeDispatch>;
			try { mode = normalizeDispatch(params); }
			catch (error) { return { content: [{ type: "text", text: errorToString(error) }], details: { mode: "single", agentScope: "user", projectAgentsDir: null, results: [], errorCode: "INVALID_DISPATCH" }, isError: true }; }
			const debugLog = runtime.debugLog ?? await readGlobalDebugLogSetting(runtime.settingsAgentDir ?? getAgentDir());
			const taskRuntime: RunnerRuntime = { ...runtime, debugLog, agentScope: params.agentScope ?? "user", projectTrusted: ctx.isProjectTrusted() };
			let agentScope: AgentScope = params.agentScope ?? "user";
			if (mode === "resume") {
				const preflight = new IoGate(runtime.ioTimeoutMs);
				const abort = () => preflight.stop(new Error("Resume preflight aborted"));
				if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
				try {
					const owner = { parentSessionId: ctx.sessionManager.getSessionId(), parentCwd: await preflight.run(() => canonicalCwd(ctx.cwd), "canonical resume owner") };
					const session = await preflight.run(() => ManagedSession.resolve(runtime.sessionRootDir ?? path.join(getAgentDir(), "subagent-sessions"), params.resume!, owner), "resolve managed session");
					await preflight.run(() => session.assertResumable(), "check ready state and existing writer");
					agentScope = session.manifest.config.agentScope;
					const validate = async () => {
						const current = discoverAgents(ctx.cwd, agentScope).agents.find((agent) => agent.name === session.manifest.config.agent.name);
						await validateConfig(session.manifest.config, current, ctx.isProjectTrusted());
						// Pi can otherwise fall back when an exact saved selection disappeared.
						const selection = session.manifest.config.model!, slash = selection.indexOf("/");
						if (slash < 1 || !ctx.modelRegistry.find(selection.slice(0, slash), selection.slice(slash + 1))) throw new SessionError("MODEL_UNAVAILABLE", "Saved model selection is not registered in the current host");
					};
					await preflight.run(validate, "validate continuation configuration");
					const details = (results: SingleResult[], progress?: LiveProgress[]): SubagentDetails => ({ mode: "single", agentScope, projectAgentsDir: discoverAgents(ctx.cwd, agentScope).projectAgentsDir, results, ...(progress ? { progress } : {}) });
					const result = await runSingleAgent(ctx.cwd, { modelWasExplicit: true, thinkingLevelWasExplicit: true }, [], session.manifest.config.agent.name, params.task!, session.manifest.config.cwd, undefined, signal, onUpdate, details, owner.parentSessionId, toolCallId, { ...taskRuntime, resumeSession: session, validateResumeConfig: validate });
					return { content: [{ type: "text", text: formatParentResults("single", [result]) }], details: details([result]), usage: asToolUsage([result]), ...(isFailedResult(result) ? { isError: true } : {}) };
				} catch (error) {
					return { content: [{ type: "text", text: errorToString(error) }], details: { mode: "single", agentScope, projectAgentsDir: null, results: [], errorCode: error instanceof SessionError ? error.code : "COMMIT_FAILED" }, isError: true };
				} finally { signal?.removeEventListener("abort", abort); }
			}
			const provider = params.provider?.trim();
			const requestedModel = params.model?.trim();
			const emptyDetails = (mode: SubagentDetails["mode"]): SubagentDetails => ({
				mode,
				agentScope,
				projectAgentsDir: null,
				results: [],
			});
			if (params.provider && !provider) return { content: [{ type: "text", text: "Invalid provider: it must not be blank." }], details: emptyDetails("single") };
			if (provider && !requestedModel) return { content: [{ type: "text", text: "provider requires model. Supply a bare model ID with provider, or use model: provider/model." }], details: emptyDetails("single") };
			if (provider && requestedModel?.includes("/")) return { content: [{ type: "text", text: "Use either provider + a bare model ID, or a provider/model value for model; do not provide both." }], details: emptyDetails("single") };

			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const dispatchDefaultsFor = (agentName: string): DispatchDefaults => selectDispatchDefaults(
				ctx, { provider, model: requestedModel, thinkingLevel: params.thinkingLevel },
				agents.find(agent => agent.name === agentName)?.model,
			);
			const parentSessionId = ctx.sessionManager.getSessionId();
			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const makeDetails =
				(mode: SubagentDetails["mode"]) =>
				(results: SingleResult[], progress?: LiveProgress[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
					...(progress && progress.length > 0 ? { progress } : {}),
				});
			if (params.tasks && params.tasks.length > MAX_PARALLEL_TASKS) {
				return { content: [{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }], details: makeDetails("parallel")([]), isError: true };
			}

			const confirmProjectAgents = params.confirmProjectAgents ?? true;
			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI && !ctx.isProjectTrusted()) {
				const requestedNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedNames.add(step.agent);
				if (params.tasks) for (const task of params.tasks) requestedNames.add(task.agent);
				if (params.agent) requestedNames.add(params.agent);
				const projectAgents = Array.from(requestedNames).map((name) => agents.find((agent) => agent.name === name)).filter((agent): agent is AgentConfig => agent?.source === "project");
				if (projectAgents.length > 0) {
					const approved = await ctx.ui.confirm("Run project-local agents?", `Agents: ${projectAgents.map((agent) => agent.name).join(", ")}\nSource: ${discovery.projectAgentsDir ?? "(unknown)"}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`);
					if (!approved) {
						const canceled = new AbortController();
						canceled.abort();
						const mode: SubagentDetails["mode"] = hasChain ? "chain" : hasTasks ? "parallel" : "single";
						const requested = hasChain
							? (params.chain ?? []).map((step, index) => ({ agent: step.agent, task: step.task, cwd: step.cwd, step: index + 1 }))
							: hasTasks
								? (params.tasks ?? []).map((task) => ({ agent: task.agent, task: task.task, cwd: task.cwd, step: undefined }))
								: [{ agent: params.agent!, task: params.task!, cwd: params.cwd, step: undefined }];
						const results = await mapWithConcurrencyLimit(requested, MAX_CONCURRENCY, (item) =>
							runSingleAgent(ctx.cwd, dispatchDefaultsFor(item.agent), agents, item.agent, item.task, item.cwd, item.step, canceled.signal, undefined, makeDetails(mode), parentSessionId, toolCallId, taskRuntime),
						);
						return { content: [{ type: "text", text: `Canceled: project-local agents not approved.\n\n${formatParentResults(mode, results)}` }], details: makeDetails(mode)(results), usage: asToolUsage(results), isError: true };
					}
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";
				for (let index = 0; index < params.chain.length; index++) {
					const step = params.chain[index];
					const taskWithContext = expandChainTask(step.task, previousOutput);
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								const current = partial.details?.results[0];
								if (!current) return;
								try { onUpdate({ content: partial.content, details: makeDetails("chain")([...results, current], partial.details?.progress) }); } catch { /* progress delivery is contained */ }
							}
						: undefined;
					const result = await runSingleAgent(ctx.cwd, dispatchDefaultsFor(step.agent), agents, step.agent, taskWithContext, step.cwd, index + 1, signal, chainUpdate, makeDetails("chain"), parentSessionId, toolCallId, taskRuntime);
					results.push(result);
					if (isFailedResult(result)) {
						return { content: [{ type: "text", text: formatParentResults("chain", results) }], details: makeDetails("chain")(results), usage: asToolUsage(results), isError: true };
					}
					previousOutput = result.output;
				}
				return { content: [{ type: "text", text: formatParentResults("chain", results) }], details: makeDetails("chain")(results), usage: asToolUsage(results) };
			}

			if (params.tasks && params.tasks.length > 0) {
				const liveProgress: Array<LiveProgress | undefined> = new Array(params.tasks.length);
				const allResults: SingleResult[] = params.tasks.map((task) => compactResult({
					taskId: ulid().toLowerCase(), agent: task.agent, agentSource: "unknown", task: task.task, status: "running", exitCode: -1, output: "", usage: emptyUsage(),
				}));
				const emitParallelUpdate = () => {
					if (!onUpdate) return;
					try {
						const running = allResults.filter((result) => result.status === "running").length;
						const done = allResults.length - running;
						onUpdate({ content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }], details: makeDetails("parallel")([...allResults], liveProgress.filter((entry): entry is LiveProgress => Boolean(entry))) });
					} catch { /* progress delivery is contained */ }
				};
				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (task, index) => {
					const result = await runSingleAgent(ctx.cwd, dispatchDefaultsFor(task.agent), agents, task.agent, task.task, task.cwd, undefined, signal, (partial) => {
						if (partial.details?.results[0]) allResults[index] = partial.details.results[0];
						liveProgress[index] = partial.details?.progress?.[0];
						emitParallelUpdate();
					}, makeDetails("parallel"), parentSessionId, toolCallId, taskRuntime);
					allResults[index] = result;
					liveProgress[index] = undefined;
					emitParallelUpdate();
					return result;
				});
				const successCount = results.filter((result) => !isFailedResult(result)).length;
				return { content: [{ type: "text", text: `Parallel: ${successCount}/${results.length} succeeded\n\n${formatParentResults("parallel", results)}` }], details: makeDetails("parallel")(results), usage: asToolUsage(results), ...(successCount === results.length ? {} : { isError: true }) };
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(ctx.cwd, dispatchDefaultsFor(params.agent), agents, params.agent, params.task, params.cwd, undefined, signal, onUpdate, makeDetails("single"), parentSessionId, toolCallId, taskRuntime);
				return { content: [{ type: "text", text: formatParentResults("single", [result]) }], details: makeDetails("single")([result]), usage: asToolUsage([result]), ...(isFailedResult(result) ? { isError: true } : {}) };
			}
			return { content: [{ type: "text", text: "Invalid parameters." }], details: makeDetails("single")([]) };
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.resume) return new Text(`${theme.fg("toolTitle", theme.bold("subagent resume "))}${theme.fg("accent", args.resume)}`, 0, 0);
			if (args.chain?.length) return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `chain (${args.chain.length} steps)`)}${theme.fg("muted", ` [${scope}]`)}`, 0, 0);
			if (args.tasks?.length) return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `parallel (${args.tasks.length} tasks)`)}${theme.fg("muted", ` [${scope}]`)}`, 0, 0);
			return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent || "...")}${theme.fg("muted", ` [${scope}]`)}`, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details?.results.length) {
				const content = result.content[0];
				return new Text(content?.type === "text" ? content.text : "(no output)", 0, 0);
			}
			const completed = details.results.filter((entry) => entry.status !== "running").length;
			const title = details.mode === "single" ? details.results[0].agent : `${details.mode} ${completed}/${details.results.length}`;
			if (!expanded) {
				const container = new Container();
				container.addChild(new Text(theme.fg("toolTitle", theme.bold(title)), 0, 0));
				for (const entry of details.results) {
					const statusColor = entry.status === "completed" ? "success" : entry.status === "running" ? "warning" : "error";
					container.addChild(new Spacer(1));
					container.addChild(new Text(`${theme.fg(statusColor, `${entry.status}: `)}${theme.fg("accent", entry.agent)}`, 0, 0));
					const live = details.progress?.find((progress) => progress.taskId === entry.taskId);
					addLiveProgress(container, live, (text) => theme.fg("dim", text));
					if (entry.status !== "running") container.addChild(new Text(theme.fg("toolOutput", getResultOutput(entry)), 0, 0));
					if (entry.subagentSessionId) container.addChild(new Text(theme.fg("muted", `Subagent session: ${entry.subagentSessionId} (${entry.canResume ? "ready" : "blocked"})`), 0, 0));
					container.addChild(new Text(theme.fg("muted", entry.logPath ? `Subsession log: ${entry.logPath}` : entry.logError ? `Subsession log unavailable: ${entry.logError}` : "Subsession log pending..."), 0, 0));
				}
				return container;
			}
			const container = new Container();
			container.addChild(new Text(theme.fg("toolTitle", theme.bold(title)), 0, 0));
			for (const entry of details.results) {
				const statusColor = entry.status === "completed" ? "success" : entry.status === "running" ? "warning" : "error";
				container.addChild(new Spacer(1));
				container.addChild(new Text(`${theme.fg(statusColor, entry.status)} ${theme.fg("accent", entry.agent)}`, 0, 0));
				container.addChild(new Text(theme.fg("muted", `Task: ${entry.task}`), 0, 0));
				const live = details.progress?.find((progress) => progress.taskId === entry.taskId);
				addLiveProgress(container, live, (text) => theme.fg("dim", text));
				if (isFailedResult(entry)) container.addChild(new Text(theme.fg("error", `Error: ${getFailureDiagnostic(entry)}`), 0, 0));
				if (entry.status !== "running") {
					if (entry.output) container.addChild(new Markdown(entry.output, 0, 0, getMarkdownTheme()));
					else container.addChild(new Text(theme.fg("muted", "(no assistant output)"), 0, 0));
				}
				if (entry.subagentSessionId) container.addChild(new Text(theme.fg("muted", `Subagent session: ${entry.subagentSessionId} (${entry.canResume ? "ready" : "blocked"})`), 0, 0));
				container.addChild(new Text(theme.fg("muted", entry.logPath ? `Subsession log: ${entry.logPath}` : entry.logError ? `Subsession log unavailable: ${entry.logError}` : "Subsession log pending..."), 0, 0));
				const usage = formatUsageStats(entry.usage, entry.model);
				if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
			}
			return container;
		},
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!pi.getActiveTools().includes("subagent")) return;
		const userAgents = discoverAgents(ctx.cwd, "user").agents;
		const trustedProject = ctx.isProjectTrusted();
		const projectAgents = trustedProject ? discoverAgents(ctx.cwd, "project").agents : [];
		const allAgents = trustedProject ? discoverAgents(ctx.cwd, "both").agents : [];
		const projectCatalog = trustedProject ? formatAgentCatalog(projectAgents) : "  (not listed until the current project is trusted)";
		const allCatalog = trustedProject ? formatAgentCatalog(allAgents) : "  (not listed until the current project is trusted)";
		return { systemPrompt: `${event.systemPrompt}\n\n### subagent agent catalog\nUse only the exact, case-sensitive agent names shown below when calling subagent. Do not make a trial subagent call to discover an agent name. The source shown is the resolved definition after precedence.\n\nagentScope: "user" (default)\n${formatAgentCatalog(userAgents)}\n\nagentScope: "project"\n${projectCatalog}\n\nagentScope: "both"\n${allCatalog}` };
	});
}
