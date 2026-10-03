import assert from "node:assert/strict";
import test from "node:test";
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES, truncatePtyOutput } from "../src/output.ts";

test("leaves small PTY output intact", () => {
	assert.deepEqual(truncatePtyOutput("hello\r\n"), { content: "hello\r\n", truncated: false });
});

test("truncates oversized PTY output with a notice", () => {
	const result = truncatePtyOutput("x".repeat(MAX_OUTPUT_BYTES + 1));
	assert.equal(result.truncated, true);
	assert.match(result.content, /PTY output truncated/);
});

test("truncates PTY output exceeding the line limit", () => {
	const result = truncatePtyOutput("x\n".repeat(MAX_OUTPUT_LINES + 1));
	assert.equal(result.truncated, true);
});
