import assert from "node:assert/strict";
import test from "node:test";
import { consumeStdoutChunkAsync, consumeStdoutChunk, isTerminalAssistantStopReason } from "../extensions/subagent/protocol.ts";

test("completed assistant stop reasons describe a message, not the entire session", () => {
	assert.equal(isTerminalAssistantStopReason("stop"), true);
	assert.equal(isTerminalAssistantStopReason("length"), true);
	assert.equal(isTerminalAssistantStopReason("error"), true);
	assert.equal(isTerminalAssistantStopReason("aborted"), true);
	assert.equal(isTerminalAssistantStopReason("toolUse"), false);
	assert.equal(isTerminalAssistantStopReason(undefined), false);
});

test("async stdout counter bounds a record split across many chunks and resets per line", async () => {
	const state: { buffer: string; finished: boolean; bufferBytes?: number } = { buffer: "", finished: false };
	const lines: string[] = [];
	const processLine = async (line: string) => { lines.push(line); };
	for (let i = 0; i < 4; i++) assert.equal(await consumeStdoutChunkAsync(state, "é".repeat(100), 1000, processLine), false);
	assert.equal(state.bufferBytes, 800);
	assert.equal(await consumeStdoutChunkAsync(state, "x".repeat(200) + "\nok\n", 1000, processLine), false);
	assert.deepEqual(lines.map((line) => line.length), [600, 2]);
	assert.equal(state.bufferBytes, 0);
	assert.equal(await consumeStdoutChunkAsync(state, "y".repeat(1001), 1000, processLine), true);
});

test("stdout after a terminal record is discarded without applying the safety limit", () => {
	const state = { buffer: "", finished: false };
	const lines: string[] = [];
	const final = '{"type":"agent_settled"}';
	const exceeded = consumeStdoutChunk(state, `${final}\n${"x".repeat(600_000)}`, 512 * 1024, (line) => {
		lines.push(line);
		state.finished = true;
	});

	assert.equal(exceeded, false);
	assert.deepEqual(lines, [final]);
	assert.equal(state.buffer, "");

	const laterChunk = consumeStdoutChunk(state, "y".repeat(600_000), 512 * 1024, () => lines.push("unexpected"));
	assert.equal(laterChunk, false);
	const laterTerminatedChunk = consumeStdoutChunk(state, `${"z".repeat(600_000)}\n`, 512 * 1024, () => lines.push("unexpected"));
	assert.equal(laterTerminatedChunk, false);
	assert.deepEqual(lines, [final]);
});

test("an oversized incomplete record is still rejected before protocol completion", () => {
	const state = { buffer: "", finished: false };
	const exceeded = consumeStdoutChunk(state, "x".repeat(512 * 1024 + 1), 512 * 1024, () => undefined);
	assert.equal(exceeded, true);
});

test("a newline-terminated oversized record is rejected before protocol completion", () => {
	const state = { buffer: "", finished: false };
	const lines: string[] = [];
	const exceeded = consumeStdoutChunk(state, `${"x".repeat(512 * 1024 + 1)}\n`, 512 * 1024, (line) => lines.push(line));
	assert.equal(exceeded, true);
	assert.deepEqual(lines, []);
});

test("normal records before a terminal record remain available", () => {
	const state = { buffer: "", finished: false };
	const lines: string[] = [];
	consumeStdoutChunk(state, '{"type":"tool_execution_end"}\n{"type":"agent_settled"}\ntrailing', 512 * 1024, (line) => {
		lines.push(line);
		if (line === '{"type":"agent_settled"}') state.finished = true;
	});
	assert.deepEqual(lines, ['{"type":"tool_execution_end"}', '{"type":"agent_settled"}']);
	assert.equal(state.buffer, "");
});

test("async parser awaits each record and bounds split UTF-8 input before copying", async () => {
	const state = { buffer: "", finished: false };
	const lines: string[] = [];
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const consuming = consumeStdoutChunkAsync(state, "one\ntwo\nterminal\n" + "x".repeat(600_000), 512 * 1024, async (line) => {
		lines.push(line);
		if (line === "one") await gate;
		if (line === "terminal") state.finished = true;
	});
	await Promise.resolve();
	assert.deepEqual(lines, ["one"]);
	release();
	assert.equal(await consuming, false);
	assert.deepEqual(lines, ["one", "two", "terminal"]);
	assert.equal(state.buffer, "");
	const split = { buffer: "", finished: false };
	assert.equal(await consumeStdoutChunkAsync(split, "🙂", 7, async () => {}), false);
	assert.equal(await consumeStdoutChunkAsync(split, "🙂\n", 7, async () => {}), true);
	assert.equal(split.buffer, "🙂");
});

for (const extra of [-1, 0, 1]) {
	test(`async parser enforces the 8 MiB record boundary (${extra >= 0 ? "+" : ""}${extra} byte)`, async () => {
		const limit = 8 * 1024 * 1024;
		const state = { buffer: "", finished: false };
		const line = '{"data":"' + "x".repeat(limit + extra - 11) + '"}';
		assert.equal(Buffer.byteLength(line), limit + extra);
		let count = 0;
		const result = await consumeStdoutChunkAsync(state, line + "\n", limit, async (record) => {
			assert.equal(JSON.parse(record).data.length, limit + extra - 11);
			count++;
		});
		assert.equal(result, extra > 0);
		assert.equal(count, extra > 0 ? 0 : 1);
	});
}
