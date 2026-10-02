import type { CompactSubagentResult } from "./result.ts";

export const MAX_LIVE_TEXT_BYTES = 16 * 1024;
export const MAX_LIVE_THINKING_BYTES = 16 * 1024;
export const MAX_LIVE_TOOL_BYTES = 16 * 1024;
export const MAX_LIVE_CONTENT_BLOCKS = 32;
export const MAX_LIVE_ENTRIES = 3;
export const MAX_LIVE_TOOLS = 8;

export interface LiveTextEntry {
	key: string;
	kind: "text" | "thinking";
	text: string;
}

export interface LiveToolEntry {
	key: string;
	kind: "tool";
	status: "request" | "completed" | "failed";
	name: string;
	arguments: string;
}

export type LiveProgressEntry = LiveTextEntry | LiveToolEntry;

interface ToolRequest {
	id: string;
	name: string;
	arguments: string;
}

export interface LiveProgress {
	taskId: string;
	agent: string;
	step?: number;
	entries?: LiveProgressEntry[];
}

export interface LiveProgressState {
	textParts: Map<number, string>;
	thinkingParts: Map<number, string>;
	entries: Map<string, LiveProgressEntry>;
	toolCallIdsByContentIndex: Map<number, string>;
	toolRequests: Map<string, ToolRequest>;
}

export function truncateUtf8(value: string, maxBytes: number): string {
	if (maxBytes <= 0 || !value) return "";
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let output = "";
	let used = 0;
	for (const character of value) {
		const bytes = Buffer.byteLength(character, "utf8");
		if (used + bytes > maxBytes) break;
		output += character;
		used += bytes;
	}
	return output;
}

export function appendBoundedUtf8(current: string, next: string, maxBytes: number): string {
	const boundedCurrent = truncateUtf8(current, maxBytes);
	const remaining = Math.max(0, maxBytes - Buffer.byteLength(boundedCurrent, "utf8"));
	return boundedCurrent + truncateUtf8(next, remaining);
}

export function normalizeLiveLine(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

function appendPart(parts: Map<number, string>, index: number, delta: string, maxBytes: number): string {
	if (!Number.isInteger(index) || index < 0 || !delta) return parts.get(index) ?? "";
	if (!parts.has(index) && parts.size >= MAX_LIVE_CONTENT_BLOCKS) {
		const oldest = parts.keys().next().value;
		if (typeof oldest === "number") parts.delete(oldest);
	}
	const previous = parts.get(index) ?? "";
	const otherBytes = Array.from(parts.entries()).reduce((total, [key, value]) => key === index ? total : total + Buffer.byteLength(value, "utf8"), 0);
	const available = Math.max(0, maxBytes - otherBytes);
	const next = appendBoundedUtf8(previous, delta, available);
	if (next) parts.set(index, next);
	return next;
}

function replacePart(parts: Map<number, string>, index: number, content: string, maxBytes: number): string {
	parts.delete(index);
	return appendPart(parts, index, content, maxBytes);
}

function boundedJson(value: unknown): string {
	let serialized: string;
	if (typeof value === "string") serialized = value;
	else {
		try {
			serialized = JSON.stringify(value) ?? "";
		} catch {
			serialized = "";
		}
	}
	return truncateUtf8(normalizeLiveLine(serialized), MAX_LIVE_TOOL_BYTES);
}

function touchEntry(state: LiveProgressState, entry: LiveProgressEntry): void {
	state.entries.delete(entry.key);
	state.entries.set(entry.key, entry);
	while (state.entries.size > MAX_LIVE_ENTRIES) {
		const oldest = state.entries.keys().next().value;
		if (typeof oldest !== "string") break;
		state.entries.delete(oldest);
	}
}

function touchTextEntry(state: LiveProgressState, kind: "text" | "thinking", index: number, value: string): void {
	const text = normalizeLiveLine(value);
	if (!text) return;
	touchEntry(state, { key: `${kind}:${index}`, kind, text });
}

function rememberToolRequest(state: LiveProgressState, request: ToolRequest): void {
	state.toolRequests.delete(request.id);
	state.toolRequests.set(request.id, request);
	while (state.toolRequests.size > MAX_LIVE_TOOLS) {
		const oldest = state.toolRequests.keys().next().value;
		if (typeof oldest !== "string") break;
		state.toolRequests.delete(oldest);
	}
}

function getToolRequest(state: LiveProgressState, id: string, name: string, args?: unknown): ToolRequest {
	const previous = state.toolRequests.get(id);
	const existingEntry = state.entries.get(`tool:${id}`);
	const existingTool = existingEntry?.kind === "tool" ? existingEntry : undefined;
	return {
		id,
		name: name || previous?.name || existingTool?.name || "unknown",
		arguments: args === undefined
			? previous?.arguments ?? existingTool?.arguments ?? ""
			: boundedJson(args),
	};
}

function touchToolEntry(state: LiveProgressState, request: ToolRequest, status: LiveToolEntry["status"]): void {
	rememberToolRequest(state, request);
	touchEntry(state, {
		key: `tool:${request.id}`,
		kind: "tool",
		status,
		name: request.name,
		arguments: normalizeLiveLine(request.arguments),
	});
}

export function createLiveProgressState(): LiveProgressState {
	return {
		textParts: new Map(),
		thinkingParts: new Map(),
		entries: new Map(),
		toolCallIdsByContentIndex: new Map(),
		toolRequests: new Map(),
	};
}

export function resetAssistantProgress(state: LiveProgressState, preserveToolCalls = false): void {
	state.textParts.clear();
	state.thinkingParts.clear();
	for (const [key, entry] of state.entries) {
		if (entry.kind !== "tool" || (!preserveToolCalls && entry.status === "request")) state.entries.delete(key);
	}
	if (!preserveToolCalls) {
		state.toolCallIdsByContentIndex.clear();
		for (const [id] of state.toolRequests) {
			const entry = state.entries.get(`tool:${id}`);
			if (!entry || entry.kind !== "tool" || entry.status === "request") state.toolRequests.delete(id);
		}
	}
}

export function applyAssistantMessageUpdate(state: LiveProgressState, event: Record<string, unknown>): void {
	const assistantEvent = event.assistantMessageEvent;
	if (!assistantEvent || typeof assistantEvent !== "object" || Array.isArray(assistantEvent)) return;
	const update = assistantEvent as Record<string, unknown>;
	const type = update.type;
	const index = update.contentIndex;
	if (typeof index !== "number") return;
	if (type === "text_delta" && typeof update.delta === "string") {
		touchTextEntry(state, "text", index, appendPart(state.textParts, index, update.delta, MAX_LIVE_TEXT_BYTES));
	}
	else if (type === "text_end" && typeof update.content === "string") {
		touchTextEntry(state, "text", index, replacePart(state.textParts, index, update.content, MAX_LIVE_TEXT_BYTES));
	}
	else if (type === "thinking_delta" && typeof update.delta === "string") {
		touchTextEntry(state, "thinking", index, appendPart(state.thinkingParts, index, update.delta, MAX_LIVE_THINKING_BYTES));
	}
	else if (type === "thinking_end" && typeof update.content === "string") {
		touchTextEntry(state, "thinking", index, replacePart(state.thinkingParts, index, update.content, MAX_LIVE_THINKING_BYTES));
	}
	else if (type === "toolcall_start") {
		const id = typeof update.id === "string" ? update.id : "?";
		const request = getToolRequest(state, id, typeof update.toolName === "string" ? update.toolName : "unknown");
		state.toolCallIdsByContentIndex.set(index, id);
		touchToolEntry(state, request, "request");
	}
	else if (type === "toolcall_delta" && typeof update.delta === "string") {
		const id = state.toolCallIdsByContentIndex.get(index);
		if (!id) return;
		const request = getToolRequest(state, id, "");
		request.arguments = appendBoundedUtf8(request.arguments, update.delta, MAX_LIVE_TOOL_BYTES);
		touchToolEntry(state, request, "request");
	}
	else if (type === "toolcall_end" && update.toolCall && typeof update.toolCall === "object" && !Array.isArray(update.toolCall)) {
		const toolCall = update.toolCall as Record<string, unknown>;
		const previousId = state.toolCallIdsByContentIndex.get(index);
		const id = typeof toolCall.id === "string" ? toolCall.id : previousId ?? "?";
		state.toolCallIdsByContentIndex.set(index, id);
		const request = getToolRequest(
			state,
			id,
			typeof toolCall.name === "string" ? toolCall.name : "",
			toolCall.arguments,
		);
		touchToolEntry(state, request, "request");
	}
}

export function applyToolExecutionStart(state: LiveProgressState, event: Record<string, unknown>): void {
	const id = typeof event.toolCallId === "string" ? event.toolCallId : "?";
	const request = getToolRequest(state, id, typeof event.toolName === "string" ? event.toolName : "", event.args);
	touchToolEntry(state, request, "request");
}

export function applyToolExecutionUpdate(_state: LiveProgressState, _event: Record<string, unknown>): void {
	// Tool output stays in the JSONL transcript and is intentionally omitted from live TUI state.
}

export function applyToolExecutionEnd(state: LiveProgressState, event: Record<string, unknown>): void {
	const id = typeof event.toolCallId === "string" ? event.toolCallId : "?";
	const request = getToolRequest(state, id, typeof event.toolName === "string" ? event.toolName : "");
	touchToolEntry(state, request, event.isError === true ? "failed" : "completed");
}

export function snapshotLiveProgress(state: LiveProgressState, result: Pick<CompactSubagentResult, "taskId" | "agent" | "step">): LiveProgress {
	const entries = Array.from(state.entries.values(), (entry) => ({ ...entry }));
	return {
		taskId: result.taskId,
		agent: result.agent,
		...(result.step === undefined ? {} : { step: result.step }),
		...(entries.length > 0 ? { entries } : {}),
	};
}

export function hasLiveProgress(progress: LiveProgress): boolean {
	return Boolean(progress.entries?.length);
}
