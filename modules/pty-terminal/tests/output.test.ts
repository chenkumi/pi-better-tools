import assert from "node:assert/strict";
import test from "node:test";
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES, stripEscapes, truncatePtyOutput } from "../src/output.ts";

test("leaves small PTY output intact", () => {
	assert.deepEqual(truncatePtyOutput("hello\r\n"), { content: "hello\r\n", truncated: false, remainder: "" });
});

test("returns the cut-off tail as remainder so it can be read again", () => {
	const input = "x".repeat(MAX_OUTPUT_BYTES + 10);
	const result = truncatePtyOutput(input);
	assert.equal(result.remainder.length, 10);
	assert.equal(result.content.startsWith("x".repeat(MAX_OUTPUT_BYTES)), true);
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

test("text format strips CSI/OSC/other escapes and keeps visible text", () => {
	const input = "\x1b[1;31mred\x1b[0m \x1b]0;title\x07ok\x1b]8;;http://x\x1b\\link\x1b(B\x1b=";
	assert.deepEqual(truncatePtyOutput(input, { format: "text" }), { content: "red oklink", truncated: false, remainder: "" });
	assert.equal(truncatePtyOutput(input).content, input);
	assert.equal(stripEscapes("a\x1b[3"), "a");
});

test("raw truncation never cuts inside an escape sequence and reports remaining characters", () => {
	const seq = "\x1b[38;2;255;255;255m";
	const input = "x".repeat(MAX_OUTPUT_BYTES - 3) + seq + "tail";
	const result = truncatePtyOutput(input);
	assert.equal(result.truncated, true);
	assert.equal(result.remainder, seq + "tail");
	assert.match(result.content, new RegExp(`${seq.length + 4} more characters remain buffered`));
	assert.ok(!result.content.includes("\x1b"));
});

test("text truncation counts only visible bytes and keeps sequences intact", () => {
	const input = "\x1b[31m" + "y".repeat(MAX_OUTPUT_BYTES + 1) + "\x1b[0mZ";
	const result = truncatePtyOutput(input, { format: "text" });
	assert.equal(result.truncated, true);
	assert.ok(result.content.startsWith("y".repeat(MAX_OUTPUT_BYTES) + "\n\n[PTY"));
	assert.equal(result.remainder, "y\x1b[0mZ");
});

test("text format holds back an incomplete trailing sequence until final", () => {
	assert.deepEqual(truncatePtyOutput("abc\x1b[3", { format: "text", final: false }), { content: "abc", truncated: false, remainder: "\x1b[3" });
	assert.deepEqual(truncatePtyOutput("abc\x1b[3", { format: "text", final: true }), { content: "abc", truncated: false, remainder: "" });
});

test("multi-byte and surrogate pairs are measured as UTF-8 bytes", () => {
	const input = "\u{1F600}".repeat(Math.floor(MAX_OUTPUT_BYTES / 4) + 1);
	const result = truncatePtyOutput(input);
	assert.equal(result.remainder, "\u{1F600}");
	assert.equal(Buffer.byteLength(result.content.split("\n\n[")[0]), Math.floor(MAX_OUTPUT_BYTES / 4) * 4);
});
