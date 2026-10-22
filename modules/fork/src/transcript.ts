import { join } from "node:path";
import type { ForkUsage } from "./child.ts";
import { errorText, utf8Prefix } from "./text.ts";
import { SubsessionWriter, readableText, serializeAssistantContent, serializeToolResultContent, type ReadableRecord, type SubsessionStatus } from "../../subagents/extensions/subagent/subsession-log.ts";

/**
 * Query-only transcript of what a Fork says and does AFTER it starts. The inherited conversation is never copied here
 * (it lives in the native session). It reuses the Subagent readable-log writer (v2: `transcript.jsonl.partial` -> `transcript.jsonl`),
 * but it is auxiliary: any failure only marks the transcript `unavailable` and never affects the Fork itself.
 */
export type TranscriptState = "pending" | "live" | "final" | "unavailable";
export interface TranscriptInfo { path: string; livePath?: string; state: TranscriptState; error?: string }

/** Escaping can grow a string ~6x in JSON, and the writer rejects any serialized record above 1 MiB. */
export const MAX_CONTENT_BYTES = 128 * 1024;
/** Records that arrive while the file is still being opened. Beyond this the transcript is marked unavailable. */
export const MAX_QUEUED = 256;
/** Upper bound for the final open/sync/rename; delivery and quit/reload never wait longer than this for an auxiliary log. */
export const FINALIZE_TIMEOUT_MS = 5000;
export interface FinalizeOutcome { exitCode?: number | null; usage?: ForkUsage; childClosed?: boolean }

export const transcriptPaths = (dir: string) => ({ path: join(dir, "transcript.jsonl"), livePath: join(dir, "transcript.jsonl.partial") });

function clip(text: string): string {
	const head = utf8Prefix(text, MAX_CONTENT_BYTES);
	if (head === text) return text;
	return `${head}\n[truncated ${Buffer.byteLength(text, "utf8") - Buffer.byteLength(head, "utf8")} bytes]`;
}
const isRecord = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);

/** Pure conversion of one finished `message_end` message into readable records (assistant text and tool calls keep their order). */
export function readableFromMessage(message: unknown): ReadableRecord[] {
	if (!isRecord(message)) return [];
	const time = typeof message.timestamp === "number" || typeof message.timestamp === "string" ? new Date(message.timestamp) : undefined;
	const at = time && Number.isFinite(time.getTime()) ? { timestamp: time.toISOString() } : {};
	if (message.role === "user") {
		const text = readableText(serializeToolResultContent(message.content));
		return text ? [{ type: "user", content: clip(text), ...at }] : [];
	}
	if (message.role === "toolResult") {
		return [{ type: "tool_result", callId: typeof message.toolCallId === "string" ? message.toolCallId : "", isError: message.isError === true, content: clip(readableText(serializeToolResultContent(message.content))), ...at }];
	}
	if (message.role !== "assistant") return [];
	const records: ReadableRecord[] = [];
	for (const part of serializeAssistantContent(message.content).content) {
		if (part.type === "text") { if (part.text) records.push({ type: "assistant", content: clip(part.text), ...at }); continue; }
		const size = Buffer.byteLength(JSON.stringify(part.arguments ?? {}), "utf8");
		records.push({ type: "tool_call", callId: part.id ?? "", name: part.name, arguments: size > MAX_CONTENT_BYTES ? { omitted: `arguments too large for transcript (${size} bytes)` } : (part.arguments ?? {}), ...at });
	}
	return records;
}

export class ForkTranscript {
	readonly path: string;
	readonly livePath: string;
	state: TranscriptState = "pending";
	error?: string;
	private writer?: SubsessionWriter;
	private ready: Promise<void> = Promise.resolve();
	private queue: ReadableRecord[] = [];
	private finalized = false;

	private readonly dir: string;
	private readonly jobId: string;
	private readonly cwd: string;
	private readonly onChange: () => void;
	private readonly finalizeTimeoutMs: number;

	constructor(dir: string, jobId: string, cwd: string, onChange: () => void = () => {}, finalizeTimeoutMs = FINALIZE_TIMEOUT_MS) {
		this.dir = dir; this.jobId = jobId; this.cwd = cwd; this.onChange = onChange; this.finalizeTimeoutMs = finalizeTimeoutMs;
		({ path: this.path, livePath: this.livePath } = transcriptPaths(dir));
	}

	info(): TranscriptInfo { return { path: this.path, ...(this.state === "live" ? { livePath: this.livePath } : {}), state: this.state, ...(this.error ? { error: this.error } : {}) }; }

	/** Opens the live file in the background; records appended meanwhile are queued (bounded). */
	start(): void {
		this.ready = SubsessionWriter.create({ formatVersion: 2, stagingDir: this.dir, rootDir: this.dir, parentSessionId: this.jobId, parentToolCallId: this.jobId, taskId: this.jobId,
			agent: "fork", agentSource: "fork", task: "", cwd: this.cwd }).then(writer => {
			this.writer = writer;
			if (this.state === "pending") this.state = "live";
			for (const record of this.queue.splice(0)) this.write(record);
			this.onChange();
		}, error => { this.fail(error); });
	}

	/** Resolves once the live file is open or the transcript has failed (never rejects); tests wait on this instead of ticks. */
	whenStarted(): Promise<void> { return this.ready; }

	appendMessage(message: unknown): void {
		let records: ReadableRecord[];
		try { records = readableFromMessage(message); } catch (error) { this.fail(error); return; }
		for (const record of records) this.append(record);
	}

	private append(record: ReadableRecord): void {
		if (this.finalized || this.state === "unavailable") return;
		if (!this.writer) {
			if (this.queue.length >= MAX_QUEUED) this.fail("too many records arrived before the transcript file was ready");
			else this.queue.push(record);
			return;
		}
		this.write(record);
	}

	private write(record: ReadableRecord): void {
		if (!this.writer || this.state === "unavailable") return;
		const admission = this.writer.tryAppend(record);
		if (admission.status === "accepted") void admission.completion.then(result => { if (result.error) this.fail(result.error); });
		else this.fail(admission.status === "failed" ? admission.error : "transcript writer is saturated; a record was dropped");
	}

	private fail(error: unknown): void {
		if (this.state === "unavailable") return;
		const reason = errorText(error, 200);
		this.state = "unavailable";
		this.error = this.writer ? `${reason} (a partial log may remain at ${this.livePath})` : reason;
		this.queue = [];
		this.onChange();
	}

	/**
	 * Never rejects and never waits longer than `finalizeTimeoutMs`: a stalled filesystem only marks the transcript `unavailable`.
	 * `final` only after the live file was synced and renamed, and only when the child really closed (`childClosed`);
	 * otherwise the child may still append, so the live file is abandoned (never renamed) and reported as incomplete.
	 */
	async finalize(status: SubsessionStatus, outcome: FinalizeOutcome = {}): Promise<void> {
		let timer: NodeJS.Timeout | undefined;
		const deadline = new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), this.finalizeTimeoutMs); timer.unref?.(); });
		try {
			if (await Promise.race([this.finish(status, outcome), deadline]) === "timeout") {
				this.finalized = true;
				this.fail(`transcript finalization did not finish within ${this.finalizeTimeoutMs} ms`);
			}
		} catch (error) { this.fail(error); }
		finally { clearTimeout(timer); }
		this.onChange();
	}

	private async finish(status: SubsessionStatus, outcome: FinalizeOutcome): Promise<"done"> {
		await this.ready;
		this.finalized = true;
		if (!this.writer) return "done";
		if (outcome.childClosed === false) {
			const reason = "the child process was not confirmed closed, so the transcript may be incomplete";
			await this.writer.abandon(reason).catch(() => {});
			this.fail(reason);
			return "done";
		}
		const u = outcome.usage;
		const usage = { input: u?.input ?? 0, output: u?.output ?? 0, cacheRead: u?.cacheRead ?? 0, cacheWrite: u?.cacheWrite ?? 0, totalTokens: u?.total ?? 0, cost: u?.cost ?? 0, contextTokens: 0, turns: 0 };
		const result = await this.writer.finalize({ status, exitCode: outcome.exitCode ?? -1, usage });
		if (result.error) this.fail(result.error);
		else if (this.state !== "unavailable") this.state = "final";
		return "done";
	}
}
