import { createHash } from "node:crypto";
import { ulid } from "ulid";
import * as fs from "node:fs";
import * as path from "node:path";
import { renameWithRetry } from "./session-store.ts";

export type SubsessionStatus = "completed" | "failed" | "aborted";

export interface UsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SubsessionHeader {
	type: "header";
	version: 1;
	taskId: string;
	parentSessionId: string;
	parentToolCallId: string;
	agent: string;
	agentSource: string;
	task: string;
	cwd: string;
	startedAt: string;
	model?: string;
}

export interface AssistantRecord {
	type: "assistant";
	seq: number;
	timestamp: string;
	content: Array<
		| { type: "text"; text: string }
		| { type: "toolCall"; id?: string; name: string; arguments: Record<string, unknown> }
	>;
}

export interface ToolResultRecord {
	type: "toolResult";
	seq: number;
	timestamp: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	/** Canonical nested-model usage, when supplied by the child. */
	usage?: UsageSummary;
	content: Array<{ type: "text"; text: string }>;
}

export interface ContentOmittedRecord {
	type: "contentOmitted";
	seq: number;
	timestamp: string;
	role: "assistant" | "toolResult";
	contentType: "image" | "binary";
	mimeType?: string;
	byteLength?: number;
	path?: string;
	reason: "binary/base64 omitted from sub-session JSONL";
}

export interface StderrRecord {
	type: "stderr";
	seq: number;
	timestamp: string;
	text: string;
}

export interface FinalRecord {
	type: "final";
	timestamp: string;
	status: SubsessionStatus;
	exitCode: number;
	stopReason?: string;
	errorMessage?: string;
	usage: UsageSummary;
}

export type SubsessionRecord =
	| SubsessionHeader
	| AssistantRecord
	| ToolResultRecord
	| ContentOmittedRecord
	| StderrRecord
	| FinalRecord;

export type ReadableRecord =
	| { type: "user"; timestamp?: string; content: string; messageId?: string; part?: number; last?: boolean }
	| { type: "assistant"; timestamp?: string; content: string }
	| { type: "tool_call"; timestamp?: string; callId: string; name: string; arguments: Record<string, unknown> }
	| { type: "tool_result"; timestamp?: string; callId: string; isError: boolean; content: string };

export function transcriptTimestamp(value: unknown): string {
	const time = typeof value === "number" || typeof value === "string" ? new Date(value) : new Date();
	return Number.isFinite(time.getTime()) ? time.toISOString() : new Date().toISOString();
}
export function callAlias(taskId: string, rawId: string): string {
	return `${taskId}:${createHash("sha256").update(rawId).digest("hex")}`;
}
export function readableText(serialized: SerializedToolResult): string {
	return [...serialized.content.map((p) => p.text), ...serialized.omitted.map((p) => `[${p.contentType} omitted]`)].join("\n\n");
}
/** Only user messages have explicit lossless segmentation; never represent chunks as separate messages. */
export function* userRecords(content: string, taskId: string, ordinal: number, timestamp?: unknown): Generator<ReadableRecord> {
	const time = transcriptTimestamp(timestamp);
	if (Buffer.byteLength(JSON.stringify({ type: "user", timestamp: time, content }) + "\n") <= MAX_PENDING_LOG_BYTES) {
		yield { type: "user", timestamp: time, content }; return;
	}
	let offset = 0, part = 0;
	while (offset < content.length) {
		let end = Math.min(content.length, offset + 128 * 1024);
		if (end < content.length && /[\uD800-\uDBFF]/u.test(content[end - 1])) end--;
		yield { type: "user", timestamp: time, content: content.slice(offset, end), messageId: `${taskId}:user:${ordinal}`, part: part++, last: end === content.length };
		offset = end;
	}
}

export interface SubsessionWriterOptions {
	/** v1 remains an internal legacy writer fixture; all production dispatches explicitly select v2. */
	formatVersion?: 2;
	stagingDir?: string;
	rootDir: string;
	parentSessionId: string;
	parentToolCallId: string;
	taskId?: string;
	agent: string;
	agentSource: string;
	task: string;
	cwd: string;
	model?: string;
}

export interface LogWriteResult {
	logPath?: string;
	error?: string;
}

export interface OmittedContent {
	role: "assistant" | "toolResult";
	contentType: "image" | "binary";
	mimeType?: string;
	byteLength?: number;
	path?: string;
}

export interface SerializedAssistant {
	content: AssistantRecord["content"];
	text: string[];
	omitted: OmittedContent[];
}

export interface SerializedToolResult {
	content: ToolResultRecord["content"];
	omitted: OmittedContent[];
}

function errorToString(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function safePathSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown";
}

function byteLength(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	try {
		return Buffer.from(value.replace(/\s/g, ""), "base64").byteLength;
	} catch {
		return Buffer.byteLength(value, "utf8");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function binaryOmission(
	role: OmittedContent["role"],
	value: Record<string, unknown>,
	contentPath: string,
): OmittedContent {
	const declaredType = value.type;
	const isImage = declaredType === "image" || typeof value.mimeType === "string";
	return {
		role,
		contentType: isImage ? "image" : "binary",
		mimeType: typeof value.mimeType === "string" ? value.mimeType : undefined,
		byteLength: byteLength(value.data) ?? byteLength(value.base64),
		path: contentPath,
	};
}

function isBinaryContent(value: Record<string, unknown>): boolean {
	return (
		value.type === "image" ||
		value.type === "binary" ||
		(typeof value.data === "string" && typeof value.mimeType === "string") ||
		(typeof value.base64 === "string" && (typeof value.mimeType === "string" || value.type === "binary"))
	);
}

function sanitizeArguments(
	value: unknown,
	role: OmittedContent["role"],
	valuePath: string,
	omitted: OmittedContent[],
): unknown {
	if (Array.isArray(value)) {
		return value.map((entry, index) => sanitizeArguments(entry, role, `${valuePath}[${index}]`, omitted));
	}
	if (!isRecord(value)) return value;
	if (isBinaryContent(value)) {
		omitted.push(binaryOmission(role, value, valuePath));
		return { omitted: "binary/base64 omitted from sub-session JSONL" };
	}

	const sanitized: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (key.toLowerCase().includes("base64") && typeof child === "string") {
			omitted.push({
				role,
				contentType: "binary",
				byteLength: byteLength(child),
				path: `${valuePath}.${key}`,
			});
			sanitized[key] = "[binary/base64 omitted from sub-session JSONL]";
		} else {
			sanitized[key] = sanitizeArguments(child, role, `${valuePath}.${key}`, omitted);
		}
	}
	return sanitized;
}

export function serializeAssistantContent(content: unknown): SerializedAssistant {
	const serialized: SerializedAssistant = { content: [], text: [], omitted: [] };
	if (!Array.isArray(content)) return serialized;

	for (let index = 0; index < content.length; index++) {
		const part = content[index];
		if (!isRecord(part)) continue;
		if (part.type === "text" && typeof part.text === "string") {
			serialized.content.push({ type: "text", text: part.text });
			serialized.text.push(part.text);
			continue;
		}
		if (part.type === "toolCall" && typeof part.name === "string") {
			const argumentsValue = sanitizeArguments(part.arguments ?? {}, "assistant", `content[${index}].arguments`, serialized.omitted);
			serialized.content.push({
				type: "toolCall",
				id: typeof part.id === "string" ? part.id : undefined,
				name: part.name,
				arguments: isRecord(argumentsValue) ? argumentsValue : {},
			});
		}
	}
	return serialized;
}

export function serializeToolResultContent(content: unknown): SerializedToolResult {
	const serialized: SerializedToolResult = { content: [], omitted: [] };
	if (typeof content === "string") {
		serialized.content.push({ type: "text", text: content });
		return serialized;
	}
	if (!Array.isArray(content)) return serialized;

	for (let index = 0; index < content.length; index++) {
		const part = content[index];
		if (!isRecord(part)) continue;
		if (part.type === "text" && typeof part.text === "string") {
			serialized.content.push({ type: "text", text: part.text });
		} else if (isBinaryContent(part)) {
			serialized.omitted.push(binaryOmission("toolResult", part, `content[${index}]`));
		}
	}
	return serialized;
}

export function collectAssistantText(messages: Iterable<unknown>): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "assistant") continue;
		parts.push(...serializeAssistantContent(message.content).text);
	}
	return parts.join("\n\n");
}

// Includes the in-flight write. A record-count cap also bounds promise/closure overhead.
export const MAX_PENDING_LOG_BYTES = 1024 * 1024;
export const MAX_PENDING_LOG_RECORDS = 1024;

type WithoutTiming<T> = T extends SubsessionRecord ? Omit<T, "seq" | "timestamp"> : never;
export type TranscriptInput = WithoutTiming<SubsessionRecord> | SubsessionRecord | ReadableRecord;
export type WriteAdmission =
	| { status: "accepted"; completion: Promise<{ error?: string }> }
	| { status: "backpressure"; ready: Promise<void> }
	| { status: "failed"; error: string };

export class SubsessionWriter {
	readonly taskId: string;
	readonly partialPath: string;
	readonly finalPath: string;
	private sequence = 0;
	private readonly formatVersion: 1 | 2;
	private writeChain: Promise<void> = Promise.resolve();
	private writeError: string | undefined;
	private finalized = false;
	private finalization: Promise<LogWriteResult> | undefined;
	private closing: Promise<void> | undefined;
	private pendingBytes = 0;
	private pendingRecords = 0;
	private peakBytes = 0;
	private peakRecords = 0;
	private capacity: { promise: Promise<void>; resolve: () => void } | undefined;
	private readonly handle: fs.promises.FileHandle;

	private constructor(handle: fs.promises.FileHandle, options: SubsessionWriterOptions) {
		this.handle = handle;
		this.taskId = options.taskId ?? ulid().toUpperCase();
		this.formatVersion = options.formatVersion ?? 1;
		const sessionDir = SubsessionWriter.directory(options, this.taskId);
		this.partialPath = path.join(sessionDir, this.formatVersion === 2 ? "transcript.jsonl.partial" : `${this.taskId}.jsonl.partial`);
		this.finalPath = path.join(sessionDir, this.formatVersion === 2 ? "transcript.jsonl" : `${this.taskId}.jsonl`);
	}

	private static directory(options: SubsessionWriterOptions, taskId: string): string {
		return options.stagingDir ?? (options.formatVersion === 2
			? path.join(options.rootDir, "v2", createHash("sha256").update(JSON.stringify([options.parentSessionId, options.cwd])).digest("hex"), taskId)
			: path.join(options.rootDir, safePathSegment(options.parentSessionId)));
	}

	static async create(options: SubsessionWriterOptions): Promise<SubsessionWriter> {
		const taskId = options.taskId ?? ulid().toUpperCase();
		const sessionDir = SubsessionWriter.directory(options, taskId);
		await fs.promises.mkdir(sessionDir, { recursive: true, mode: 0o700 });
		const handle = await fs.promises.open(path.join(sessionDir, options.formatVersion === 2 ? "transcript.jsonl.partial" : `${taskId}.jsonl.partial`), "wx", 0o600);
		const writer = new SubsessionWriter(handle, { ...options, taskId });
		if (options.formatVersion === 2) {
			if (!options.stagingDir) {
				try { await fs.promises.writeFile(path.join(sessionDir, "run.json"), JSON.stringify({ version: 2, taskId,
					parentSessionId: options.parentSessionId, parentToolCallId: options.parentToolCallId, agent: options.agent,
					agentSource: options.agentSource, requestHash: createHash("sha256").update(options.task).digest("hex"), cwd: options.cwd, model: options.model, state: "running" }), { flag: "wx", mode: 0o600 }); }
				catch (error) { writer.fail(error); await writer.closeHandle(); throw error; }
			}
			return writer;
		}
		writer.admit({ type: "header", version: 1, taskId, parentSessionId: options.parentSessionId,
			parentToolCallId: options.parentToolCallId, agent: options.agent, agentSource: options.agentSource,
			task: options.task, cwd: options.cwd, startedAt: new Date().toISOString(), model: options.model }, true);
		await writer.writeChain;
		if (writer.writeError) {
			await writer.closeHandle();
			throw new Error(writer.writeError);
		}
		return writer;
	}

	getPendingStats() {
		return { bytes: this.pendingBytes, records: this.pendingRecords, peakBytes: this.peakBytes, peakRecords: this.peakRecords };
	}

	tryAppend(record: TranscriptInput): WriteAdmission {
		if (this.finalized) return { status: "failed", error: this.writeError ?? "Sub-session log is finalized" };
		return this.admit(record);
	}

	private wake(): void {
		this.capacity?.resolve();
		this.capacity = undefined;
	}

	private fail(error: unknown): string {
		this.writeError ??= errorToString(error);
		this.wake();
		return this.writeError;
	}

	private admit(record: TranscriptInput, reserved = false): WriteAdmission {
		if (this.writeError) return { status: "failed", error: this.writeError };
		let serialized: string;
		const numbered = this.formatVersion === 1 && record.type !== "header" && record.type !== "final";
		try {
			if (this.formatVersion === 2 && (!["user", "assistant", "tool_call", "tool_result"].includes(record.type) || (record.type !== "tool_call" && (!("content" in record) || typeof record.content !== "string")))) throw new Error("Invalid readable transcript record");
			serialized = `${JSON.stringify({ ...record,
				...(numbered ? { seq: "seq" in record && typeof record.seq === "number" ? record.seq : this.sequence + 1 } : {}),
				...(record.type !== "header" ? { timestamp: transcriptTimestamp("timestamp" in record ? record.timestamp : undefined) } : {}),
			})}\n`;
		} catch (error) {
			return { status: "failed", error: this.fail(error) };
		}
		const bytes = Buffer.byteLength(serialized, "utf8");
		if (!reserved && bytes > MAX_PENDING_LOG_BYTES) return { status: "failed", error: this.fail("Sub-session log record exceeds writer capacity") };
		if (!reserved && (this.pendingBytes + bytes > MAX_PENDING_LOG_BYTES || this.pendingRecords >= MAX_PENDING_LOG_RECORDS)) {
			if (!this.capacity) {
				let resolve!: () => void;
				const promise = new Promise<void>((done) => { resolve = done; });
				this.capacity = { promise, resolve };
			}
			return { status: "backpressure", ready: this.capacity.promise };
		}
		if (numbered) this.sequence++;
		this.pendingBytes += bytes;
		this.pendingRecords++;
		if (!reserved) {
			this.peakBytes = Math.max(this.peakBytes, this.pendingBytes);
			this.peakRecords = Math.max(this.peakRecords, this.pendingRecords);
		}
		const completion = this.writeChain.then(async (): Promise<{ error?: string }> => {
			try {
				if (!this.writeError) await this.handle.writeFile(serialized, "utf8");
			} catch (error) {
				this.fail(error);
			} finally {
				this.pendingBytes -= bytes;
				this.pendingRecords--;
				this.wake();
			}
			return this.writeError ? { error: this.writeError } : {};
		});
		this.writeChain = completion.then(() => {});
		return { status: "accepted", completion };
	}




	/** Return immediately, but close only after actual I/O has settled. Never rename abandoned logs. */
	abandon(reason: string): Promise<void> {
		this.fail(reason);
		this.finalized = true;
		const abandonment = this.writeChain.then(() => this.closeHandle());
		// Some owners cannot await until their IoGate becomes idle. Observe immediately,
		// without converting the rejecting ownership barrier into a successful close.
		void abandonment.catch(() => {});
		return abandonment;
	}

	private closeHandle(): Promise<void> {
		this.closing ??= Promise.resolve().then(() => this.handle.close()).catch((error) => {
			const diagnostic = `Writer close failed: ${errorToString(error)}`;
			this.writeError = this.writeError ? `${this.writeError}; ${diagnostic}` : diagnostic;
			this.wake();
			throw new Error(this.writeError);
		});
		return this.closing;
	}

	finalize(record: Omit<FinalRecord, "type" | "timestamp">): Promise<LogWriteResult> {
		if (this.finalization) return this.finalization;
		this.finalized = true;
		this.wake();
		this.finalization = this.finish(record);
		return this.finalization;
	}

	private async finish(record: Omit<FinalRecord, "type" | "timestamp">): Promise<LogWriteResult> {
		await this.writeChain;
		if (!this.writeError && this.formatVersion === 1) this.admit({ type: "final", ...record }, true);
		if (!this.writeError && this.formatVersion === 2) {
			// abandon() must not close a handle while a timed-out sync is still pending.
			this.writeChain = this.writeChain.then(async () => {
				try { await this.handle.sync(); } catch (error) { this.fail(error); }
			});
		}
		await this.writeChain;
		try { await this.closeHandle(); }
		catch { return { error: this.writeError }; } // Keep finalize's structured error contract.
		if (this.writeError) return { error: this.writeError };
		try {
			await renameWithRetry(this.partialPath, this.finalPath);
			return this.writeError ? { error: this.writeError } : { logPath: this.finalPath };
		} catch (error) {
			return { error: this.fail(error) };
		}
	}
}
