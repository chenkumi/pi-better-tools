import assert from "node:assert/strict";
import test from "node:test";
import {
	aggregateUsage,
	addUsage,
	emptyUsage,
	compactResult,
	formatParentResults,
	getResultOutput,
	isFailedResult,
} from "../extensions/subagent/result.ts";

const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 30, cost: 0.5, contextTokens: 10, turns: 1 };

test("compact parent results retain only metadata, assistant output, usage, and log path", () => {
	const result = compactResult({
		taskId: "task-1",
		agent: "worker",
		agentSource: "bundled",
		task: "Inspect source",
		status: "completed",
		exitCode: 0,
		output: "before tool\n\nafter tool\n\nfinal text",
		usage,
		logPath: "/agent/sub-sessions/parent/task-1.jsonl",
		messages: [{ role: "toolResult", content: [{ type: "text", text: "must not be retained" }] }],
		stderr: "must not be retained",
	});

	assert.deepEqual(Object.keys(result).sort(), [
		"agent", "agentSource", "exitCode", "logPath", "output", "status", "task", "taskId", "usage",
	]);
	assert.equal(JSON.stringify(result).includes("must not be retained"), false);
	assert.equal(isFailedResult(result), false);
	assert.equal(getResultOutput(result), "before tool\n\nafter tool\n\nfinal text");
});

test("parent formatting returns every task output without parallel truncation and labels chain steps", () => {
	const first = compactResult({
		taskId: "first",
		agent: "scout",
		agentSource: "bundled",
		task: "find",
		status: "completed",
		exitCode: 0,
		output: "first assistant block\n\nsecond assistant block",
		usage,
		logPath: "/logs/first.jsonl",
		step: 1,
	});
	const second = compactResult({
		taskId: "second",
		agent: "worker",
		agentSource: "bundled",
		task: "implement",
		status: "completed",
		exitCode: 0,
		output: "third assistant block",
		usage,
		logPath: "/logs/second.jsonl",
		step: 2,
	});

	const parallel = formatParentResults("parallel", [first, second]);
	assert.match(parallel, /first assistant block\n\nsecond assistant block/);
	assert.match(parallel, /third assistant block/);
	assert.match(parallel, /Subsession log: \/logs\/first.jsonl/);
	assert.match(parallel, /Subsession log: \/logs\/second.jsonl/);

	const chain = formatParentResults("chain", [first, second]);
	assert.match(chain, /### Step 1 \[scout\] completed/);
	assert.match(chain, /### Step 2 \[worker\] completed/);

	const failed = compactResult({ ...second, status: "failed", exitCode: 1, errorMessage: "child failed" });
	assert.equal(getResultOutput(failed), "third assistant block\n\nError: child failed");
	assert.equal(aggregateUsage([first, second]).contextTokens, 20);
	assert.equal(aggregateUsage([first, second]).totalTokens, 60);
});

test("usage accumulation ignores nonfinite counters and does not add reasoning/cacheWrite1h twice", () => {
	const total = emptyUsage();
	addUsage(total, { input: 10, output: 4, reasoning: 3, cacheRead: 2, cacheWrite: 3, cacheWrite1h: 2, totalTokens: 19, cost: { total: 5 } });
	addUsage(total, { input: NaN, output: Infinity, cacheRead: "1", cacheWrite: null, totalTokens: undefined, cost: { total: Infinity } });
	addUsage(total, null);
	addUsage(total, []);
	assert.deepEqual(total, { input: 10, output: 4, cacheRead: 2, cacheWrite: 3, totalTokens: 19, cost: 5, contextTokens: 0, turns: 0 });
});

test("legacy saved usage reconstructs cumulative tokens rather than its final context gauge", () => {
	const { totalTokens: _removed, ...legacy } = usage;
	const result = { usage: legacy } as any;
	const total = aggregateUsage([result, result]);
	assert.equal(total.totalTokens, 20);
	assert.equal(total.contextTokens, 20);
});

test("firstLineSummary keeps the first non-empty line within the UTF-8 byte limit", async () => {
	const { firstLineSummary } = await import("../extensions/subagent/result.ts");
	assert.equal(firstLineSummary("\n  \nConclusion line\nDetails", 512), "Conclusion line");
	assert.equal(firstLineSummary("", 512), "");
	const bounded = firstLineSummary("中".repeat(400), 512);
	assert.ok(Buffer.byteLength(bounded, "utf8") <= 512 && bounded.length > 100);
});
