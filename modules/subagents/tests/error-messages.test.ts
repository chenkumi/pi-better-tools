import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import registerSubagent from "../extensions/subagent/index.ts";
import { BackgroundJobs } from "../extensions/subagent/background.ts";
import { messageNextAction, messageRejectionCode, normalizeDispatch, unknownAgentMessage, taskEnvelopeError, SUBAGENT_MAX_STDOUT_RECORD_BYTES } from "../extensions/subagent/index.ts";
import { describeIgnoredOverrides } from "../extensions/subagent/model-selection.ts";
import { validateInteraction } from "../extensions/subagent/query-snapshot.ts";
import { ManagedSession, canonicalCwd } from "../extensions/subagent/session-store.ts";

const message = (fn: () => unknown): string => { try { fn(); } catch (error) { return (error as Error).message; } return assert.fail("expected throw"); };
const ok = { agent: "w", task: "t" };

test("normalizeDispatch names the failing array, index and key", () => {
	assert.match(message(() => normalizeDispatch({ tasks: [] })), /tasks must contain at least 1 item.*received 0/);
	assert.match(message(() => normalizeDispatch({ chain: "x" as any })), /chain must be an array.*string/);
	assert.match(message(() => normalizeDispatch({ tasks: [ok, { agent: " ", task: "t" }] })), /tasks\[1\]\.agent is blank/);
	assert.match(message(() => normalizeDispatch({ chain: [{ agent: "w", task: "" }] })), /chain\[0\]\.task is blank/);
	assert.match(message(() => normalizeDispatch({ tasks: [ok, "x" as any] })), /tasks\[1\] must be an object/);
	const extra = message(() => normalizeDispatch({ tasks: [{ ...ok, model: "m" }] }));
	assert.match(extra, /tasks\[0\]: unsupported key "model".*allowed: agent, task, title, cwd/); assert.match(extra, /top-level/);
	assert.match(message(() => normalizeDispatch({ chain: [{ ...ok, resume: "X" }] })), /chain\[0\]: unsupported key "resume".*subagent_message/);
});
test("normalizeDispatch explains mode, single, background and title failures", () => {
	assert.match(message(() => normalizeDispatch({})), /exactly one of.*agent \+ task.*tasks.*chain.*received none/);
	assert.match(message(() => normalizeDispatch({ agent: "w", task: "t", tasks: [ok] })), /received agent, tasks/);
	assert.match(message(() => normalizeDispatch({ agent: "w", task: " " })), /task is blank/);
	assert.match(message(() => normalizeDispatch({ agent: "", task: "t" })), /agent is blank/);
	assert.match(message(() => normalizeDispatch({ agent: "w" })), /task is missing/);
	assert.match(message(() => normalizeDispatch({ task: "t" })), /task was given without agent.*subagent_message/);
	assert.match(message(() => normalizeDispatch({ ...ok, background: "yes" as any })), /background must be true or false.*"yes"/);
	assert.match(message(() => normalizeDispatch({ ...ok, title: "x".repeat(63) })), /title must be 1-50.*received 63 characters/);
	assert.match(message(() => normalizeDispatch({ tasks: [{ ...ok, title: "   " }] })), /tasks\[0\]\.title.*blank/);
});
test("unknown agent message lists names, scope and the project-agent hint", () => {
	const text = unknownAgentMessage("x", [{ name: "scout" }, { name: "worker" }] as any, "user", "tasks[1].agent");
	assert.match(text, /Unknown agent: "x"/); assert.match(text, /tasks\[1\]\.agent/); assert.match(text, /"scout", "worker"/);
	assert.match(text, /agentScope "user"/); assert.match(text, /agentScope "project" or "both"/);
	assert.doesNotMatch(unknownAgentMessage("x", [], "both"), /agentScope "project" or "both"/);
	assert.match(unknownAgentMessage("x", [], "both"), /none/);
});
test("agent-facing text names tool args only, never settings, config directories or environment variables", () => {
	const forbidden = /\.pi\/agents|\/agents\b|settings|pi-subagents|pi-fork|pi-monitor|\bPI_[A-Z]|agentDir|--tools|--exclude-tools|allowlist|exclusion/i;
	assert.doesNotMatch(unknownAgentMessage("x", [], "user"), forbidden);
	assert.match(unknownAgentMessage("x", [], "user"), /Project-only agents are not visible in this scope; pass agentScope "project" or "both"/);
	const tools: any[] = [];
	registerSubagent({ registerTool: (tool: any) => tools.push(tool), registerCommand() {}, registerMessageRenderer() {}, on() {} } as any, { debugLog: false });
	assert.ok(tools.some(tool => tool.name === "subagent"));
	for (const tool of tools) {
		const text = `${tool.description} ${(tool.promptGuidelines ?? []).join(" ")} ${JSON.stringify(tool.parameters)}`;
		assert.doesNotMatch(text, forbidden, tool.name);
	}
	const subagent = tools.find(tool => tool.name === "subagent");
	assert.match(subagent.description, /agentScope: "both" \(or "project"\) to use project-local agents/);
	for (const code of ["SESSION_BUSY", "SESSION_BLOCKED", "CONFIG_CHANGED", "MODEL_UNAVAILABLE", "SNAPSHOT_CAPACITY", "SESSION_NOT_FOUND", "INVALID_MESSAGE", "BACKGROUND_RUNTIME_CLOSED", "OTHER"]) assert.doesNotMatch(messageNextAction(code), forbidden, code);
});
test("oversized task reports encoded size, limit and fix", () => {
	assert.equal(taskEnvelopeError("small"), undefined);
	const text = taskEnvelopeError("x".repeat(SUBAGENT_MAX_STDOUT_RECORD_BYTES))!;
	assert.match(text, /task is \d+ bytes.*limit is \d+ bytes/); assert.match(text, /file/);
});
test("canonicalCwd explains the missing or non-directory cwd", async () => {
	const root = await mkdtemp(join(tmpdir(), "err-cwd-"));
	try {
		const missing = await canonicalCwd(join(root, "nope")).catch(e => e.message);
		assert.match(missing, /^CWD_UNAVAILABLE: cwd ".*nope" does not exist/); assert.match(missing, /existing directory/);
		await writeFile(join(root, "f"), "x");
		assert.match(await canonicalCwd(join(root, "f")).catch(e => e.message), /is not a directory/);
		assert.match(await canonicalCwd(join(root, "nope"), "session working directory").catch(e => e.message), /session working directory ".*nope"/);
	} finally { await rm(root, { recursive: true, force: true }); }
});
test("session resolve errors name subagentSessionId and how to find valid IDs", async () => {
	const root = await mkdtemp(join(tmpdir(), "err-sess-"));
	try {
		const owner = { parentSessionId: "p", parentCwd: root };
		const bad = await ManagedSession.resolve(root, "abc", owner).catch(e => e);
		assert.match(bad.message, /subagentSessionId "abc" is not a complete session ID/); assert.match(bad.message, /subagent_status/);
		assert.doesNotMatch(bad.message, /resume/);
		const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
		const missing = await ManagedSession.resolve(root, id, owner).catch(e => e);
		assert.equal(missing.code, "SESSION_NOT_FOUND");
		assert.match(missing.message, new RegExp(`subagentSessionId "${id}"`)); assert.match(missing.message, /subagent_status/);
	} finally { await rm(root, { recursive: true, force: true }); }
});
test("job-not-found names jobId, hints at taskId/session IDs and points to subagent_status", async () => {
	const jobs = new BackgroundJobs(() => {});
	let release = () => {};
	try {
		const none = message(() => jobs.get("NOPE", "o", "/c"));
		assert.match(none, /^BACKGROUND_JOB_NOT_FOUND: jobId "NOPE"/); assert.match(none, /subagent_status/);
		const gate = new Promise<void>(r => { release = r; });
		let liveReady!: () => void; const liveSeen = new Promise<void>(r => { liveReady = r; });
		const receipt = jobs.submit("o", "/c", jobs.epoch, ["w"], async (_s, _ids, live) => { live(0, "01ARZ3NDEKTSV4RRFFQ69G5FAV", "/log"); liveReady(); await gate; });
		await liveSeen;
		const taskHint = message(() => jobs.get(receipt.tasks[0].taskId, "o", "/c"));
		assert.match(taskHint, /is a taskId, not a jobId/); assert.match(taskHint, new RegExp(receipt.jobId));
		const sessionHint = message(() => jobs.cancel("01ARZ3NDEKTSV4RRFFQ69G5FAV", "o", "/c"));
		assert.match(sessionHint, /is a subagentSessionId, not a jobId/);
		assert.match(message(() => jobs.get(receipt.jobId, "other", "/c")), /^BACKGROUND_JOB_NOT_FOUND: jobId/);
	} finally { release(); await jobs.shutdown(); }
});
test("subagent_message routing errors use subagent_message vocabulary", async () => {
	const jobs = new BackgroundJobs(() => {});
	let release = () => {};
	try {
		const gate = new Promise<void>(r => { release = r; });
		const receipt = jobs.submit("o", "/c", jobs.epoch, ["w"], async () => { await gate; });
		const text = message(() => jobs.message(receipt.jobId, receipt.tasks[0].taskId, "control", "hi", "o", "/c"));
		assert.match(text, /^TASK_NOT_RUNNING:/); assert.match(text, /subagentSessionId/); assert.doesNotMatch(text, /exact running taskId/);
	} finally { release(); await jobs.shutdown(); }
});
test("validateInteraction states the parameter, the bytes rule and the received size", () => {
	assert.match(message(() => validateInteraction("  ")), /^INVALID_MESSAGE: message is blank/);
	assert.match(message(() => validateInteraction(5)), /message must be a string.*number/);
	const text = message(() => validateInteraction("中".repeat(30000)));
	assert.match(text, /message is 90000 bytes/); assert.match(text, /65536 UTF-8 bytes/); assert.match(text, /not characters/);
});

test("message rejection receipts carry a code-specific nextAction and a clean errorCode", () => {
	assert.match(messageNextAction("SESSION_BLOCKED"), /cannot be continued.*start a new subagent/i);
	assert.match(messageNextAction("CONFIG_CHANGED"), /start a new subagent/i);
	assert.match(messageNextAction("MODEL_UNAVAILABLE"), /model/);
	assert.match(messageNextAction("SNAPSHOT_CAPACITY"), /mode "control"/);
	assert.match(messageNextAction("SESSION_NOT_FOUND"), /subagent_status/);
	assert.match(messageNextAction("INVALID_MESSAGE"), /fix the named parameter/i);
	assert.match(messageNextAction("SESSION_BUSY"), /task_result/);
	assert.equal(messageRejectionCode(new Error("INVALID_MESSAGE: x")), "INVALID_MESSAGE");
	assert.equal(messageRejectionCode(new Error("Resume preflight aborted while doing a thing: detail")), "MESSAGE_REJECTED");
});

const model = (provider: string, id: string, reasoning: boolean): Model<Api> => ({ provider, id, name: id, api: "openai-responses", reasoning, input: ["text"], contextWindow: 1, maxTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Model<Api>);
test("ignored model/thinkingLevel overrides produce notes; honored ones produce none", () => {
	const plain = model("p", "plain", false), thinker = model("p", "thinker", true), models = [plain, thinker];
	const ctx: any = { model: thinker, thinkingLevel: "high", modelRegistry: { find: (p: string, i: string) => models.find(m => m.provider === p && m.id === i), getAll: () => models } };
	assert.deepEqual(describeIgnoredOverrides(ctx, {}), []);
	assert.deepEqual(describeIgnoredOverrides(ctx, { model: "p/plain" }), []);
	assert.match(describeIgnoredOverrides(ctx, { model: "ghost" }).join("\n"), /model "ghost" was ignored.*registered/);
	assert.match(describeIgnoredOverrides(ctx, { thinkingLevel: "ultra" }).join("\n"), /thinkingLevel "ultra" was ignored.*off, minimal, low, medium, high, xhigh, max/);
	assert.match(describeIgnoredOverrides(ctx, { model: "p/plain", thinkingLevel: "high" }).join("\n"), /thinkingLevel "high" was ignored.*does not support/);
});
