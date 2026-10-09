import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	SubsessionWriter,
	type TranscriptInput,
	MAX_PENDING_LOG_BYTES,
	MAX_PENDING_LOG_RECORDS,
	collectAssistantText,
	serializeAssistantContent,
	serializeToolResultContent,
} from "../extensions/subagent/subsession-log.ts";

function admit(writer: SubsessionWriter, record: TranscriptInput): void {
	assert.equal(writer.tryAppend(record).status, "accepted");
}

async function readJsonl(filePath: string): Promise<Array<Record<string, unknown>>> {
	return (await readFile(filePath, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("subsession writers isolate task files, preserve order, and finalize atomically", async () => {
	const rootDir = await mkdtemp(join(tmpdir(), "pi-subsession-log-"));
	try {
		const common = {
			rootDir,
			parentSessionId: "parent/session",
			parentToolCallId: "call_parent",
			agent: "worker",
			agentSource: "bundled",
			task: "Inspect files",
			cwd: "/work",
		};
		const [first, second] = await Promise.all([
			SubsessionWriter.create({ ...common, taskId: "task-one" }),
			SubsessionWriter.create({ ...common, taskId: "task-two" }),
		]);

		admit(first, {
			type: "assistant",
			content: [{ type: "text", text: "First assistant text" }],
		});
		admit(first, { type: "stderr", text: "first stderr" });
		admit(second, {
			type: "assistant",
			content: [{ type: "text", text: "Second assistant text" }],
		});

		const [firstFinal, secondFinal] = await Promise.all([
			first.finalize({
				status: "completed",
				exitCode: 0,
				usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: 0, contextTokens: 3, turns: 1 },
			}),
			second.finalize({
				status: "completed",
				exitCode: 0,
				usage: { input: 4, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 9, cost: 0, contextTokens: 9, turns: 1 },
			}),
		]);

		assert.equal(firstFinal.logPath, first.finalPath);
		assert.equal(secondFinal.logPath, second.finalPath);
		assert.notEqual(first.finalPath, second.finalPath);
		await assert.rejects(stat(first.partialPath));
		await assert.rejects(stat(second.partialPath));

		const firstRecords = await readJsonl(first.finalPath);
		const secondRecords = await readJsonl(second.finalPath);
		assert.deepEqual(firstRecords.map((record) => record.type), ["header", "assistant", "stderr", "final"]);
		assert.deepEqual(secondRecords.map((record) => record.type), ["header", "assistant", "final"]);
		assert.equal(firstRecords[0].taskId, "task-one");
		assert.equal(secondRecords[0].taskId, "task-two");
		assert.equal(firstRecords[1].seq, 1);
		assert.equal(firstRecords[2].seq, 2);
	} finally {
		await rm(rootDir, { recursive: true, force: true });
	}
});

test("serializers preserve text and calls but remove thinking and base64", () => {
	const assistant = serializeAssistantContent([
		{ type: "thinking", thinking: "do not retain" },
		{ type: "text", text: "before tool" },
		{
			type: "toolCall",
			id: "call_1",
			name: "read",
			arguments: { path: "README.md", imageBase64: "aGVsbG8=" },
		},
		{ type: "text", text: "after tool" },
	]);
	assert.deepEqual(assistant.text, ["before tool", "after tool"]);
	assert.deepEqual(assistant.content.map((part) => part.type), ["text", "toolCall", "text"]);
	assert.equal(JSON.stringify(assistant).includes("do not retain"), false);
	assert.equal(JSON.stringify(assistant).includes("aGVsbG8="), false);
	assert.equal(assistant.omitted.length, 1);

	const toolResult = serializeToolResultContent([
		{ type: "text", text: "read output" },
		{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
	]);
	assert.deepEqual(toolResult.content, [{ type: "text", text: "read output" }]);
	assert.equal(JSON.stringify(toolResult).includes("aW1hZ2U="), false);
	assert.deepEqual(toolResult.omitted, [
		{
			role: "toolResult",
			contentType: "image",
			mimeType: "image/png",
			byteLength: 5,
			path: "content[1]",
		},
	]);
});

test("writer records serialized mixed child events in chronological order", async () => {
	const rootDir = await mkdtemp(join(tmpdir(), "pi-subsession-events-"));
	try {
		const writer = await SubsessionWriter.create({
			rootDir,
			parentSessionId: "parent",
			parentToolCallId: "call",
			taskId: "events",
			agent: "worker",
			agentSource: "bundled",
			task: "Run mixed events",
			cwd: "/work",
		});
		const assistant = serializeAssistantContent([
			{ type: "thinking", thinking: "omit me" },
			{ type: "text", text: "before" },
			{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } },
			{ type: "text", text: "after" },
		]);
		admit(writer, { type: "assistant", content: assistant.content });
		for (const omission of assistant.omitted) admit(writer, { type: "contentOmitted", ...omission, reason: "binary/base64 omitted from sub-session JSONL" });
		const toolResult = serializeToolResultContent([
			{ type: "text", text: "tool text" },
			{ type: "binary", data: "AAEC" },
		]);
		admit(writer, { type: "toolResult", toolCallId: "call_1", toolName: "read", content: toolResult.content });
		for (const omission of toolResult.omitted) admit(writer, { type: "contentOmitted", ...omission, reason: "binary/base64 omitted from sub-session JSONL" });
		admit(writer, { type: "stderr", text: "child diagnostic" });
		const finalized = await writer.finalize({
			status: "failed",
			exitCode: 1,
			stopReason: "error",
			usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: 0, contextTokens: 3, turns: 1 },
		});
		assert.ok(finalized.logPath);
		const records = await readJsonl(finalized.logPath!);
		assert.deepEqual(records.map((record) => record.type), ["header", "assistant", "toolResult", "contentOmitted", "stderr", "final"]);
		assert.equal(JSON.stringify(records).includes("omit me"), false);
		assert.equal(JSON.stringify(records).includes("AAEC"), false);
		assert.equal((records[1].content as Array<{ type: string }>).map((part) => part.type).join(","), "text,toolCall,text");
	} finally {
		await rm(rootDir, { recursive: true, force: true });
	}
});

test("assistant text collection includes every assistant text block in order", () => {
	const output = collectAssistantText([
		{ role: "assistant", content: [{ type: "text", text: "first" }, { type: "toolCall", name: "read" }] },
		{ role: "toolResult", content: [{ type: "text", text: "tool output must not appear" }] },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "thinking must not appear" },
				{ type: "text", text: "second" },
				{ type: "text", text: "third" },
			],
		},
	]);
	assert.equal(output, "first\n\nsecond\n\nthird");
});

const finalRecord = {
	status: "completed" as const, exitCode: 0,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, contextTokens: 0, turns: 0 },
};

for (const kind of ["bytes", "records", "write-failure", "abandon"] as const) {
	test(`writer acknowledgement and bounded backpressure: ${kind}`, async (t) => {
		const rootDir = await mkdtemp(join(tmpdir(), "pi-log-queue-"));
		const originalOpen = fs.promises.open;
		let unblock!: () => void;
		let started!: () => void;
		const blocked = new Promise<void>((resolve) => { unblock = resolve; });
		const entered = new Promise<void>((resolve) => { started = resolve; });
		let closeCount = 0;
		let writes = 0;
		t.mock.method(fs.promises, "open", async (...args: Parameters<typeof originalOpen>) => {
			const handle = await originalOpen(...args);
			const originalWrite = handle.writeFile.bind(handle);
			const originalClose = handle.close.bind(handle);
			t.mock.method(handle, "writeFile", async (...writeArgs: Parameters<typeof handle.writeFile>) => {
				if (++writes === 2) {
					started();
					await blocked;
					if (kind === "write-failure") throw new Error("injected disk failure");
				}
				return originalWrite(...writeArgs);
			});
			t.mock.method(handle, "close", async () => { closeCount++; return originalClose(); });
			return handle;
		});
		try {
			const writer = await SubsessionWriter.create({ rootDir, parentSessionId: "parent", parentToolCallId: "call", agent: "worker", agentSource: "bundled", task: "test", cwd: rootDir });
			const text = kind === "records" ? "small" : "🙂".repeat(64 * 1024);
			const record = { type: "stderr" as const, text };
			const first = writer.tryAppend(record);
			assert.equal(first.status, "accepted");
			if (first.status !== "accepted") throw new Error("not accepted");
			let completed = false;
			void first.completion.then(() => { completed = true; });
			await entered;
			assert.equal(completed, false);
			let count = 1;
			let full = writer.tryAppend(record);
			while (full.status === "accepted") { count++; full = writer.tryAppend(record); }
			assert.equal(full.status, "backpressure");
			if (full.status !== "backpressure") throw new Error("not backpressure");
			const again = writer.tryAppend(record);
			assert.ok(again.status === "backpressure" && again.ready === full.ready);
			assert.ok(writer.getPendingStats().bytes <= MAX_PENDING_LOG_BYTES);
			assert.ok(writer.getPendingStats().records <= MAX_PENDING_LOG_RECORDS);
			if (kind === "abandon") {
				writer.abandon("injected cancellation");
				await full.ready;
				assert.equal(closeCount, 0); // An active write must not race close or cleanup.
			}
			unblock();
			await full.ready;
			if (kind === "bytes" || kind === "records") {
				let retry = writer.tryAppend(record);
				while (retry.status === "backpressure") { await retry.ready; retry = writer.tryAppend(record); }
				assert.equal(retry.status, "accepted");
				if (retry.status === "accepted") assert.deepEqual(await retry.completion, {});
				count++;
			}
			const finalizing = writer.finalize(finalRecord);
			assert.equal(writer.finalize(finalRecord), finalizing);
			assert.equal(writer.tryAppend(record).status, "failed");
			const result = await finalizing;
			assert.equal(closeCount, 1);
			assert.equal(writer.getPendingStats().bytes, 0);
			if (kind === "write-failure" || kind === "abandon") {
				assert.ok((await first.completion).error);
				assert.ok(result.error);
				assert.equal(result.logPath, undefined);
				await stat(writer.partialPath);
				await assert.rejects(stat(writer.finalPath), { code: "ENOENT" });
			} else {
				const records = await readJsonl(result.logPath!);
				assert.equal(records.length, count + 2);
				assert.deepEqual(records.slice(1, -1).map((record) => record.seq), Array.from({ length: count }, (_, i) => i + 1));
				assert.ok(records.slice(1, -1).every((record) => record.text === text));
				assert.equal(records.at(-1)!.type, "final");
				assert.ok(writer.getPendingStats().peakBytes <= MAX_PENDING_LOG_BYTES);
			}
		} finally {
			unblock();
			await rm(rootDir, { recursive: true, force: true });
		}
	});
}

test("oversized writer record fails immediately rather than waiting for capacity", async () => {
	const rootDir = await mkdtemp(join(tmpdir(), "pi-log-large-"));
	try {
		const writer = await SubsessionWriter.create({ rootDir, parentSessionId: "parent", parentToolCallId: "call", agent: "worker", agentSource: "bundled", task: "test", cwd: rootDir });
		assert.equal(writer.tryAppend({ type: "stderr", text: "x".repeat(MAX_PENDING_LOG_BYTES) }).status, "failed");
		assert.equal(writer.getPendingStats().bytes, 0);
		assert.match((await writer.finalize(finalRecord)).error!, /capacity/);
	} finally { await rm(rootDir, { recursive: true, force: true }); }
});

for (const action of ["finalize", "abandon"] as const) {
	test(`actual handle close rejection preserves the ownership barrier: ${action}`, async t => {
		const rootDir = await mkdtemp(join(tmpdir(), "pi-log-close-reject-"));
		const open = fs.promises.open;
		let actualClose: (() => Promise<void>) | undefined;
		let closes = 0;
		t.mock.method(fs.promises, "open", async (...args: Parameters<typeof open>) => {
			const handle = await open(...args);
			actualClose = handle.close.bind(handle);
			t.mock.method(handle, "close", async () => { closes++; throw new Error("injected actual close failure"); });
			return handle;
		});
		try {
			const writer = await SubsessionWriter.create({ formatVersion: 2, stagingDir: rootDir, rootDir, parentSessionId: "parent", parentToolCallId: "call", agent: "worker", agentSource: "bundled", task: "test", cwd: rootDir });
			if (action === "abandon") {
				await assert.rejects(writer.abandon("primary write failure"), /primary write failure.*close.*injected actual close failure/i);
			}
			const result = await writer.finalize(finalRecord);
			assert.match(result.error!, /close.*injected actual close failure/i);
			if (action === "abandon") assert.match(result.error!, /primary write failure/);
			assert.equal(result.logPath, undefined);
			await assert.rejects(writer.abandon("secondary cleanup"), /close.*injected actual close failure/i);
			assert.equal(closes, 1, "a failed close is not a confirmed ownership release or an automatic retry");
			await stat(writer.partialPath);
			await assert.rejects(stat(writer.finalPath), { code: "ENOENT" });
		} finally { await actualClose?.(); t.mock.restoreAll(); await rm(rootDir, { recursive: true, force: true }); }
	});
}

test("serialization errors are reported without rejected background work", async () => {
	const rootDir = await mkdtemp(join(tmpdir(), "pi-log-serialization-"));
	try {
		const writer = await SubsessionWriter.create({
			rootDir, parentSessionId: "parent", parentToolCallId: "call", agent: "worker",
			agentSource: "bundled", task: "test", cwd: rootDir,
		});
		const cycle: any = { type: "stderr" };
		cycle.text = cycle;
		assert.equal(writer.tryAppend(cycle).status, "failed");
		const result = await writer.finalize(finalRecord);
		assert.match(result.error!, /circular/i);
		assert.equal(result.logPath, undefined);
		await stat(writer.partialPath);
	} finally {
		await rm(rootDir, { recursive: true, force: true });
	}
});
