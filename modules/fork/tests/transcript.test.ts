import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ForkTranscript, MAX_CONTENT_BYTES, MAX_QUEUED, readableFromMessage } from "../src/transcript.ts";

const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));

test("messages convert to readable records in order; images and base64 are omitted, never inlined", () => {
	assert.deepEqual(readableFromMessage({ role: "user", content: "task" }).map(r => [r.type, (r as any).content]), [["user", "task"]]);
	const assistant = readableFromMessage({ role: "assistant", content: [{ type: "text", text: "plan" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } }, { type: "text", text: "after" }] });
	assert.deepEqual(assistant.map(r => r.type), ["assistant", "tool_call", "assistant"]);
	assert.equal((assistant[1] as any).callId, "c1");
	const result = readableFromMessage({ role: "toolResult", toolCallId: "c1", isError: true, content: [{ type: "text", text: "boom" }, { type: "image", data: "AAAA", mimeType: "image/png" }] })[0] as any;
	assert.equal(result.isError, true); assert.match(result.content, /boom/); assert.match(result.content, /\[image omitted\]/); assert.ok(!result.content.includes("AAAA"));
	assert.deepEqual(readableFromMessage({ role: "system", content: "x" }), []);
	assert.deepEqual(readableFromMessage(null), []);
});

test("oversized content is clipped on a character boundary so the writer never rejects it", () => {
	const text = "é".repeat(MAX_CONTENT_BYTES);
	const [record] = readableFromMessage({ role: "toolResult", toolCallId: "c", content: text }) as any[];
	assert.ok(Buffer.byteLength(record.content) <= MAX_CONTENT_BYTES + 64); assert.match(record.content, /\[truncated \d+ bytes\]$/);
	assert.ok(!record.content.includes("�"));
	const [call] = readableFromMessage({ role: "assistant", content: [{ type: "toolCall", id: "c", name: "write", arguments: { content: "x".repeat(MAX_CONTENT_BYTES + 1) } }] }) as any[];
	assert.match(call.arguments.omitted, /too large/);
});

test("live .partial during the run, atomic rename to transcript.jsonl on finalize; only records appended after start are present", async () => {
	const root = mkdtempSync(join(tmpdir(), "fork-transcript-"));
	try {
		const changes: string[] = [];
		const transcript = new ForkTranscript(join(root, "J"), "J", root, () => changes.push(transcript.state));
		transcript.start();
		transcript.appendMessage({ role: "user", content: "the task" }); // queued while the file is still opening
		transcript.appendMessage({ role: "assistant", content: [{ type: "text", text: "working" }] });
		await transcript.whenStarted();
		assert.equal(transcript.state, "live");
		assert.ok(existsSync(transcript.livePath)); assert.ok(!existsSync(transcript.path));
		transcript.appendMessage({ role: "toolResult", toolCallId: "c1", content: "ok" });
		await transcript.finalize("completed");
		assert.equal(transcript.state, "final");
		assert.ok(!existsSync(transcript.livePath)); assert.ok(existsSync(transcript.path));
		assert.deepEqual(lines(transcript.path).map(r => r.type), ["user", "assistant", "tool_result"]);
		assert.equal(lines(transcript.path)[0].content, "the task");
		transcript.appendMessage({ role: "assistant", content: [{ type: "text", text: "late" }] });
		assert.equal(lines(transcript.path).length, 3, "nothing is appended after finalize");
		assert.ok(changes.includes("live") && changes.at(-1) === "final");
	} finally { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});

test("an unwritable location marks the transcript unavailable and never throws", async () => {
	const root = mkdtempSync(join(tmpdir(), "fork-transcript-"));
	try {
		writeFileSync(join(root, "blocker"), "a file where the directory should be");
		const transcript = new ForkTranscript(join(root, "blocker", "J"), "J", root);
		transcript.start();
		transcript.appendMessage({ role: "user", content: "x" });
		await transcript.finalize("failed");
		assert.equal(transcript.state, "unavailable"); assert.ok(transcript.error);
		assert.equal(transcript.info().state, "unavailable");
	} finally { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});

test("a flood before the file is ready degrades the transcript instead of growing memory", async () => {
	const root = mkdtempSync(join(tmpdir(), "fork-transcript-"));
	try {
		const transcript = new ForkTranscript(join(root, "J"), "J", root);
		transcript.start();
		for (let i = 0; i <= MAX_QUEUED + 1; i++) transcript.appendMessage({ role: "assistant", content: [{ type: "text", text: `m${i}` }] });
		await transcript.finalize("completed");
		assert.equal(transcript.state, "unavailable"); assert.match(transcript.error!, /before the transcript file was ready/);
	} finally { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});

test("finalize is bounded: a stalled writer marks the transcript unavailable instead of blocking forever", async () => {
	const root = mkdtempSync(join(tmpdir(), "fork-transcript-"));
	try {
		const transcript = new ForkTranscript(join(root, "J"), "J", root, () => {}, 30);
		transcript.start();
		await new Promise(resolve => setTimeout(resolve, 50));
		(transcript as any).writer.finalize = () => new Promise(() => {});
		const started = Date.now();
		await transcript.finalize("completed", { childClosed: true });
		assert.ok(Date.now() - started < 2000);
		assert.equal(transcript.state, "unavailable"); assert.match(transcript.error!, /did not finish within 30 ms/);
		assert.ok(!existsSync(transcript.path));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a child that was not confirmed closed never gets a final transcript: the live file is kept and reported incomplete", async () => {
	const root = mkdtempSync(join(tmpdir(), "fork-transcript-"));
	try {
		const transcript = new ForkTranscript(join(root, "J"), "J", root);
		transcript.start();
		transcript.appendMessage({ role: "assistant", content: [{ type: "text", text: "partial" }] });
		await new Promise(resolve => setTimeout(resolve, 50));
		await transcript.finalize("aborted", { childClosed: false });
		assert.equal(transcript.state, "unavailable"); assert.match(transcript.error!, /not confirmed closed/);
		assert.ok(!existsSync(transcript.path), "never renamed to the final path");
		assert.ok(existsSync(transcript.livePath));
		transcript.appendMessage({ role: "assistant", content: [{ type: "text", text: "late" }] });
		assert.ok(!readFileSync(transcript.livePath, "utf8").includes("late"));
	} finally { rmSync(root, { recursive: true, force: true }); }
});
