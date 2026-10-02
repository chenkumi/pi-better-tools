import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test, { beforeEach } from "node:test";
import { fixtureAgentPath, installManagedBoundary } from "./fixtures/managed-boundary.ts";
beforeEach(installManagedBoundary);
import { runSingleAgent, type RunnerRuntime } from "../extensions/subagent/index.ts";
import { SubsessionWriter, callAlias, MAX_PENDING_LOG_BYTES, MAX_PENDING_LOG_RECORDS } from "../extensions/subagent/subsession-log.ts";

const fixture = fileURLToPath(new URL("./fixtures/child.mjs", import.meta.url));
for (const mode of ["immediate", "delayed", "missing"]) {
	test(`100 MiB tool payloads with controlled writer and ${mode} canonical results`, { timeout: 120000 }, async (t) => {
		const root = await fs.promises.mkdtemp(join(tmpdir(), "pi-stress-"));
		const controller = new AbortController();
		const originalOpen = fs.promises.open;
		const originalCreate = SubsessionWriter.create.bind(SubsessionWriter);
		let release!: () => void;
		let entered!: () => void;
		const blocked = new Promise<void>((resolve) => { release = resolve; });
		const paused = new Promise<void>((resolve) => { entered = resolve; });
		let didBlock = false;
		let writer!: SubsessionWriter;
		let backpressureCount = 0;
		let stats: Parameters<NonNullable<RunnerRuntime["onResourceStats"]>>[0] | undefined;
		let pending: ReturnType<typeof runSingleAgent> | undefined;
		let updates = 0;
		let leakedToolText = false;
		const rssBefore = process.memoryUsage().rss;
		t.mock.method(fs.promises, "open", async (...args: Parameters<typeof originalOpen>) => {
			const handle = await originalOpen(...args);
			if (String(args[0]).endsWith(".jsonl.partial")) {
				const write = handle.writeFile.bind(handle);
				const writeMock = t.mock.method(handle, "writeFile", async (...writeArgs: Parameters<typeof handle.writeFile>) => {
					writeMock.mock.resetCalls(); // do not make the measuring harness retain every JSONL payload
					const record = JSON.parse(String(writeArgs[0]));
					const shouldBlock = mode === "immediate" ? record.type === "assistant" && record.content.startsWith("prefill:") : record.type === "tool_result";
					if (!didBlock && shouldBlock) {
						didBlock = true;
						if (mode !== "immediate") entered();
						await blocked;
					}
					if (record.type === "tool_result") await new Promise<void>((resolve) => setImmediate(resolve));
					return write(...writeArgs);
				});
			}
			return handle;
		});
		t.mock.method(SubsessionWriter, "create", async (options: any) => {
			writer = await originalCreate(options);
			const append = writer.tryAppend.bind(writer);
			const admissionMock = t.mock.method(writer, "tryAppend", (record) => {
				admissionMock.mock.resetCalls();
				const admission = append(record);
				if (admission.status === "backpressure") { backpressureCount++; entered(); }
				return admission;
			});
			if (mode === "immediate") {
				// Force actual runner capacity retry, not just a delayed acknowledgement.
				for (let index = 0; index < 3; index++) assert.equal(writer.tryAppend({ type: "assistant", content: "prefill:" + "p".repeat(300 * 1024) }).status, "accepted");
			}
			return writer;
		});
		try {
			pending = runSingleAgent(root, { modelWasExplicit: false, thinkingLevelWasExplicit: false },
				[{ name: "worker", description: "test", source: "bundled", filePath: fixtureAgentPath, systemPrompt: "test" }],
				"worker", "stress", undefined, undefined, controller.signal,
				(update) => {
					updates++;
					const progress = JSON.stringify((update.details as any)?.progress);
					leakedToolText ||= Boolean(progress?.includes("F".repeat(100)) || progress?.includes("C".repeat(100)));
				},
				(results, progress) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results, ...(progress ? { progress } : {}) }),
				"parent", "call", { sessionRootDir: join(root, "managed"), ioTimeoutMs: 30000, onResourceStats: (value) => { stats = value; },
					invocation(args) {
						assert.equal(args[args.indexOf("--exclude-tools") + 1], "subagent");
						return { command: process.execPath, args: [fixture, `stress-${mode}`, ...args] };
					},
				});
			await Promise.race([paused, pending.then((result) => { throw new Error(`runner ended before controlled pause: ${JSON.stringify(result)}`); })]);
			assert.ok(writer.getPendingStats().bytes <= MAX_PENDING_LOG_BYTES);
			release();
			const result = await pending;
			assert.equal(result.status, "completed", result.errorMessage);
			assert.equal(result.logError, undefined);
			assert.equal(result.output, "stress complete");
			assert.equal("progress" in result, false);
			assert.ok(updates > 0);
			assert.equal(leakedToolText, false);
			if (mode === "immediate") assert.ok(backpressureCount > 0);
			assert.ok(stats && stats.retainedMessageBytes < 64 * 1024);
			assert.ok(stats.maxStdoutRecordBytes <= 512 * 1024);
			assert.ok(stats.maxStdoutChunkBytes <= 512 * 1024);
			assert.ok(stats.maxStderrChunkBytes <= 512 * 1024);
			const queue = writer.getPendingStats();
			assert.equal(queue.bytes, 0);
			assert.equal(queue.records, 0);
			assert.ok(queue.peakBytes <= MAX_PENDING_LOG_BYTES && queue.peakRecords <= MAX_PENDING_LOG_RECORDS);
			let count = 0;
			let bytes = 0;
			let last = "";
			const seen = new Set<string>();
			const stream = fs.createReadStream(result.logPath!);
			const lines = createInterface({ input: stream, crlfDelay: Infinity });
			try {
				for await (const line of lines) {
					const record = JSON.parse(line);
					last = record.type;
					if (record.type !== "tool_result") continue;
					assert.equal(record.callId, callAlias(result.taskId, `stress-${count}`));
					assert.equal(seen.has(record.callId), false);
					seen.add(record.callId);
					assert.equal(record.content, (mode === "missing" ? "F" : "C").repeat(256 * 1024));
					bytes += Buffer.byteLength(record.content);
					count++;
				}
			} finally { lines.close(); stream.destroy(); }
			assert.equal(last, mode === "missing" ? "tool_result" : "assistant");
			assert.equal(count, 400);
			assert.equal(bytes, 100 * 1024 * 1024);
			assert.ok((await fs.promises.readdir(join(result.logPath!, ".."))).every((name) => !name.startsWith("tool-results-") && !name.endsWith(".partial")));
			t.diagnostic(JSON.stringify({ mode, loggedToolBytes: bytes, records: count, backpressureCount, ...stats, queue, rssBefore, rssAfter: process.memoryUsage().rss }));
		} finally {
			release();
			controller.abort();
			await pending;
			t.mock.restoreAll();
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
}
