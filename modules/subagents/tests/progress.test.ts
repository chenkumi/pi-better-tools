import assert from "node:assert/strict";
import test from "node:test";
import {
	MAX_LIVE_CONTENT_BLOCKS,
	MAX_LIVE_ENTRIES,
	MAX_LIVE_TEXT_BYTES,
	MAX_LIVE_THINKING_BYTES,
	MAX_LIVE_TOOL_BYTES,
	MAX_LIVE_TOOLS,
	appendBoundedUtf8,
	applyAssistantMessageUpdate,
	applyToolExecutionEnd,
	applyToolExecutionStart,
	applyToolExecutionUpdate,
	createLiveProgressState,
	normalizeLiveLine,
	resetAssistantProgress,
	snapshotLiveProgress,
	truncateUtf8,
} from "../extensions/subagent/progress.ts";

const result = { taskId: "task-1", agent: "worker", step: 1 };

function update(assistantMessageEvent: Record<string, unknown>): Record<string, unknown> {
	return { type: "message_update", assistantMessageEvent };
}

test("UTF-8 bounds never split code points or exceed the byte limit", () => {
	for (const remaining of [1, 2, 3]) {
		const prefix = "a".repeat(16 - remaining);
		const value = appendBoundedUtf8(prefix, "中文🙂𠮷", 16);
		assert.ok(Buffer.byteLength(value, "utf8") <= 16);
		assert.ok(!value.includes("�"));
	}
	assert.equal(truncateUtf8("🙂", 3), "");
	assert.equal(truncateUtf8("🙂", 4), "🙂");
	assert.equal(normalizeLiveLine(" first\n\tsecond   third "), "first second third");
});

test("streaming updates reuse stable entries, move them to newest, and retain only three", () => {
	const state = createLiveProgressState();
	applyAssistantMessageUpdate(state, update({ type: "text_delta", contentIndex: 0, delta: "first\nline" }));
	applyAssistantMessageUpdate(state, update({ type: "thinking_delta", contentIndex: 1, delta: "considering" }));
	applyAssistantMessageUpdate(state, update({ type: "text_delta", contentIndex: 2, delta: "third" }));
	applyAssistantMessageUpdate(state, update({ type: "text_delta", contentIndex: 0, delta: " updated" }));

	let progress = snapshotLiveProgress(state, result);
	assert.equal(progress.entries?.length, MAX_LIVE_ENTRIES);
	assert.deepEqual(progress.entries?.map((entry) => entry.key), ["thinking:1", "text:2", "text:0"]);
	assert.deepEqual(progress.entries?.at(-1), { key: "text:0", kind: "text", text: "first line updated" });

	applyAssistantMessageUpdate(state, update({ type: "toolcall_start", contentIndex: 3, id: "call-1", toolName: "read" }));
	progress = snapshotLiveProgress(state, result);
	assert.deepEqual(progress.entries?.map((entry) => entry.key), ["text:2", "text:0", "tool:call-1"]);
});

test("live state remains byte and collection bounded behind the three-line display", () => {
	const state = createLiveProgressState();
	applyAssistantMessageUpdate(state, update({ type: "text_delta", contentIndex: 0, delta: "🙂".repeat(MAX_LIVE_TEXT_BYTES) }));
	applyAssistantMessageUpdate(state, update({ type: "thinking_delta", contentIndex: 1, delta: "think".repeat(MAX_LIVE_THINKING_BYTES) }));
	for (let index = 0; index < MAX_LIVE_CONTENT_BLOCKS + 4; index++) {
		applyAssistantMessageUpdate(state, update({ type: "text_delta", contentIndex: index + 2, delta: "block" }));
	}
	for (let index = 0; index < MAX_LIVE_TOOLS + 4; index++) {
		applyAssistantMessageUpdate(state, update({ type: "toolcall_start", contentIndex: index + 100, id: `call-${index}`, toolName: `tool-${index}` }));
		applyAssistantMessageUpdate(state, update({ type: "toolcall_delta", contentIndex: index + 100, delta: "x".repeat(MAX_LIVE_TOOL_BYTES * 2) }));
	}

	const progress = snapshotLiveProgress(state, result);
	assert.ok((progress.entries?.length ?? 0) <= MAX_LIVE_ENTRIES);
	assert.ok(state.textParts.size <= MAX_LIVE_CONTENT_BLOCKS);
	assert.ok(state.toolRequests.size <= MAX_LIVE_TOOLS);
	assert.ok(Array.from(state.textParts.values()).reduce((bytes, value) => bytes + Buffer.byteLength(value, "utf8"), 0) <= MAX_LIVE_TEXT_BYTES);
	assert.ok(Array.from(state.thinkingParts.values()).reduce((bytes, value) => bytes + Buffer.byteLength(value, "utf8"), 0) <= MAX_LIVE_THINKING_BYTES);
	for (const request of state.toolRequests.values()) {
		assert.ok(Buffer.byteLength(request.arguments, "utf8") <= MAX_LIVE_TOOL_BYTES);
		assert.ok(!request.arguments.includes("�"));
	}
});

test("tool entries retain request arguments and expose status without execution output", () => {
	const state = createLiveProgressState();
	applyAssistantMessageUpdate(state, update({ type: "toolcall_start", contentIndex: 0, id: "call-read", toolName: "read" }));
	applyAssistantMessageUpdate(state, update({ type: "toolcall_end", contentIndex: 0, toolCall: {
		id: "call-read", name: "read", arguments: { path: "README.md", note: "first\nsecond" },
	} }));
	applyToolExecutionStart(state, { toolCallId: "call-read", toolName: "read" });
	const requestEntry = snapshotLiveProgress(state, result).entries?.at(-1);
	assert.deepEqual(requestEntry, {
		key: "tool:call-read",
		kind: "tool",
		status: "request",
		name: "read",
		arguments: '{"path":"README.md","note":"first\\nsecond"}',
	});

	applyToolExecutionUpdate(state, {
		toolCallId: "call-read",
		toolName: "read",
		partialResult: { content: [{ type: "text", text: "secret partial output" }] },
	});
	assert.deepEqual(snapshotLiveProgress(state, result).entries?.at(-1), requestEntry);

	applyToolExecutionEnd(state, {
		toolCallId: "call-read",
		toolName: "read",
		isError: false,
		result: { content: [{ type: "text", text: "secret final output" }] },
	});
	const completed = snapshotLiveProgress(state, result).entries?.at(-1);
	assert.deepEqual(completed, { ...requestEntry, status: "completed" });
	assert.equal(JSON.stringify(completed).includes("secret"), false);

	applyToolExecutionStart(state, { toolCallId: "call-fail", toolName: "powershell", args: { command: "exit 1" } });
	applyToolExecutionEnd(state, { toolCallId: "call-fail", toolName: "powershell", isError: true, result: "failure details" });
	assert.deepEqual(snapshotLiveProgress(state, result).entries?.at(-1), {
		key: "tool:call-fail",
		kind: "tool",
		status: "failed",
		name: "powershell",
		arguments: '{"command":"exit 1"}',
	});
});

test("concurrent tool status changes are chronological and independently retained", () => {
	const state = createLiveProgressState();
	applyToolExecutionStart(state, { toolCallId: "call-a", toolName: "read", args: { path: "a" } });
	applyToolExecutionStart(state, { toolCallId: "call-b", toolName: "grep", args: { pattern: "b" } });
	applyToolExecutionEnd(state, { toolCallId: "call-b", toolName: "grep", isError: false, result: "ignored" });
	applyToolExecutionEnd(state, { toolCallId: "call-a", toolName: "read", isError: true, result: "ignored" });
	const entries = snapshotLiveProgress(state, result).entries;
	assert.deepEqual(entries?.map((entry) => [entry.key, entry.kind === "tool" ? entry.status : entry.kind]), [
		["tool:call-b", "completed"],
		["tool:call-a", "failed"],
	]);
});

test("assistant resets clear message entries while preserving requested tool turns and completed history", () => {
	const state = createLiveProgressState();
	applyAssistantMessageUpdate(state, update({ type: "text_delta", contentIndex: 0, delta: "working" }));
	applyAssistantMessageUpdate(state, update({ type: "toolcall_start", contentIndex: 1, id: "call-1", toolName: "search" }));
	resetAssistantProgress(state, true);
	assert.deepEqual(snapshotLiveProgress(state, result).entries?.map((entry) => entry.key), ["tool:call-1"]);
	applyToolExecutionEnd(state, { toolCallId: "call-1", toolName: "search", isError: false, result: "ignored" });
	resetAssistantProgress(state);
	assert.deepEqual(snapshotLiveProgress(state, result).entries?.map((entry) => entry.key), ["tool:call-1"]);
});
