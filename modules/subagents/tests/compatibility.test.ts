import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { beforeEach } from "node:test";
import { fixtureAgentPath, installManagedBoundary, managedRunMetadata } from "./fixtures/managed-boundary.ts";
beforeEach(installManagedBoundary);
import { runSingleAgent, type RunnerRuntime } from "../extensions/subagent/index.ts";
import { SubsessionWriter, callAlias } from "../extensions/subagent/subsession-log.ts";

const fixture = fileURLToPath(new URL("./fixtures/child.mjs", import.meta.url));
async function run(scenario: string, runtime: Partial<RunnerRuntime> = {}, controller?: AbortController, update?: (partial: any) => void, expectLog = true) {
	const root = await mkdtemp(join(tmpdir(), "pi-compatibility-"));
	try {
		const result = await runSingleAgent(root, { modelWasExplicit: false, thinkingLevelWasExplicit: false },
			[{ name: "worker", description: "fixture", source: "bundled", filePath: fixtureAgentPath, systemPrompt: "Offline fixture" }],
			"worker", "test", undefined, undefined, controller?.signal, update,
			(results, progress) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results, progress }),
			"parent", "call", { sessionRootDir: join(root, "managed"), inactivityTimeoutMs: 5000, forceKillDelayMs: 100,
				invocation(args) { return { command: process.execPath, args: [fixture, scenario, ...args] }; }, ...runtime });
		assert.equal(Boolean(result.logPath), expectLog);
		const log = expectLog ? (await readFile(result.logPath!, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
		if (expectLog) {
			assert.ok(log.every(entry => ["user", "assistant", "tool_call", "tool_result"].includes(entry.type)));
			const metadata = await managedRunMetadata(root, result);
			assert.equal(metadata.status, result.status); assert.deepEqual(metadata.usage, result.usage);
		}
		return { result, log };
	} finally { await rm(root, { recursive: true, force: true }); }
}

for (const scenario of ["retry-success", "length-recovery"]) {
	test(`BUG-001 ${scenario} consumes the recovered response and clears the earlier error`, async () => {
		const { result, log } = await run(scenario);
		assert.equal(result.status, "completed", result.errorMessage);
		assert.equal(result.stopReason, "stop");
		assert.equal(result.errorMessage, undefined);
		assert.equal(result.output, scenario === "length-recovery" ? "partial\n\nrecovered-success" : "recovered-success");
		assert.equal(result.usage.turns, 2);
		assert.equal(result.usage.cost, 2);
		assert.equal(result.usage.totalTokens, 24);
		assert.equal(result.usage.contextTokens, 12);
		assert.ok(log.every(entry => !("usage" in entry)));
	});
}

test("BUG-001 exhausted retry preserves the final failure rather than the first attempt", async () => {
	const { result } = await run("retry-exhausted");
	assert.equal(result.status, "failed");
	assert.equal(result.stopReason, "error");
	assert.equal(result.errorMessage, "retry exhausted");
	assert.equal(result.usage.turns, 2);
});

test("BUG-001 retry output keeps refreshing inactivity until session settlement", { timeout: 10000 }, async () => {
	const { result } = await run("retry-heartbeat", { inactivityTimeoutMs: 400 });
	assert.equal(result.status, "completed", result.errorMessage);
	assert.equal(result.output, "recovered-success");
});

test("BUG-001 parent abort interrupts retry without promoting the earlier error", async () => {
	const controller = new AbortController();
	const { result } = await run("retry-heartbeat", {}, controller, (partial) => {
		if (partial.details.results[0].stopReason === "error") controller.abort();
	});
	assert.equal(result.status, "aborted");
	assert.equal(result.stopReason, "aborted");
});

test("BUG-001 follow-up work after a stop response remains part of the same task", async () => {
	const { result } = await run("follow-up");
	assert.equal(result.status, "completed");
	assert.equal(result.output, "first answer\n\nfollow-up answer");
	assert.equal(result.usage.turns, 2);
});

for (const scenario of ["incomplete-continuation", "incomplete-message", "settled-without-assistant"]) {
	test(`BUG-001 ${scenario} cannot borrow an earlier terminal response`, async () => {
		const { result } = await run(scenario);
		assert.equal(result.status, "failed");
		assert.match(result.errorMessage!, /without a terminal assistant/);
	});
}

test("BUG-001 malformed stdout before settlement still fails closed", async () => {
	const { result } = await run("malformed-before-settled");
	assert.equal(result.status, "failed");
	assert.match(result.errorMessage!, /stdout processing failed/);
});

test("BUG-001 data after agent_settled is discarded while the child pipe is drained", async () => {
	const { result } = await run("settled-tail");
	assert.equal(result.status, "completed");
	assert.equal(result.output, "done");
	assert.equal(result.errorMessage, undefined);
});

for (const scenario of ["structured-shell", "escaped-structured-shell", "large-image"]) {
	test(`BUG-002 ${scenario} fits the bounded envelope without retaining structured or binary output`, async () => {
		let stats: Parameters<NonNullable<RunnerRuntime["onResourceStats"]>>[0] | undefined;
		const { result, log } = await run(scenario, { onResourceStats(value) { stats = value; } });
		assert.equal(result.status, "completed", result.errorMessage);
		assert.equal(result.output, "done");
		assert.equal(result.logError, undefined);
		assert.ok(stats!.maxStdoutRecordBytes > 512 * 1024);
		assert.ok(stats!.maxStdoutRecordBytes <= 8 * 1024 * 1024);
		assert.ok(stats!.retainedMessageBytes < 1024);
		assert.ok(Buffer.byteLength(JSON.stringify(log)) < 2048);
		assert.equal(log.filter((entry) => entry.type === "tool_result").length, 1);
		if (scenario === "large-image") assert.match(log.find(entry => entry.type === "tool_result").content, /image omitted/);
	});
}

test("BUG-002 oversized records are still rejected under the new finite limit", async () => {
	const { result } = await run("oversized");
	assert.equal(result.status, "failed");
	assert.match(result.errorMessage!, /safety limit/);
});

test("BUG-002 eight simultaneous large records remain independently bounded", { timeout: 30000 }, async () => {
	const stats: Array<Parameters<NonNullable<RunnerRuntime["onResourceStats"]>>[0]> = [];
	const outcomes = await Promise.all(Array.from({ length: 8 }, () => run("structured-shell", { onResourceStats(value) { stats.push(value); } })));
	assert.ok(outcomes.every(({ result }) => result.status === "completed"));
	assert.equal(stats.length, 8);
	assert.ok(stats.every((value) => value.maxStdoutRecordBytes <= 8 * 1024 * 1024 && value.retainedMessageBytes < 1024));
});

test("BUG-003 canonical usage is counted once; nested execution usage is already in the root", async () => {
	const { result, log } = await run("tool-usage");
	assert.equal(result.status, "completed");
	assert.deepEqual(result.usage, { input: 30, output: 6, cacheRead: 0, cacheWrite: 0, totalTokens: 36, cost: 5, contextTokens: 12, turns: 2 });
	assert.ok(log.every(entry => !("usage" in entry)));
	assert.equal(log.filter((entry) => entry.type === "tool_result" && entry.callId === callAlias(result.taskId, "root")).length, 1);
});

test("mandatory managed logging failure refuses child execution instead of falling back to ephemeral", async (t) => {
	t.mock.method(SubsessionWriter, "create", async () => { throw new Error("injected log creation failure"); });
	const { result } = await run("tool-usage", {}, undefined, undefined, false);
	assert.equal(result.status, "failed");
	assert.equal(result.canResume, false);
	assert.ok(result.subagentSessionId);
	assert.match(result.logError!, /injected log creation failure/);
	assert.equal(result.usage.turns, 0);
	assert.equal(result.usage.totalTokens, 0);
});
