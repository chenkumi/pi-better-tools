// Agent-facing error text: each message names the parameter, the violated rule, a bounded received value and the fix.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import spinoffExtension from "../../src/index.ts";
import { acceptSpinoff, deps, messageSpinoff, onSessionStart, onTurnEnd, state } from "../../src/spinoff/manager.ts";

const KEY = Symbol.for("pi-better-tools.spinoff.registry.v1");
let root: string, cwd: string, sessions: string;
beforeEach(() => {
	delete (globalThis as any)[KEY];
	root = mkdtempSync(join(tmpdir(), "spinoff-msg-"));
	cwd = realpathSync(root); sessions = join(cwd, "sessions");
	deps.argv = () => []; deps.launchCwd = () => cwd;
});
afterEach(() => { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); delete (globalThis as any)[KEY]; });

function setup() {
	const sm = SessionManager.create(cwd, sessions);
	sm.appendMessage({ role: "user", content: "hello", timestamp: Date.now() } as never);
	sm.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "spinoff", arguments: {} }], api: "x", provider: "x", model: "x", stopReason: "toolUse", timestamp: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as never);
	const tools = new Map<string, any>();
	const ctx: any = { cwd, model: { provider: "p", id: "m" }, isProjectTrusted: () => false, hasUI: false, ui: { setStatus() {} }, sessionManager: sm };
	const pi: any = { getActiveTools: () => ["read", "spinoff"], getAllTools: () => [{ name: "read", sourceInfo: { path: "/ext/read.ts" } }], getThinkingLevel: () => "off", sendMessage() {},
		registerTool: (tool: any) => tools.set(tool.name, tool), registerMessageRenderer() {}, registerCommand() {}, on() {} };
	spinoffExtension(pi);
	return { sm, ctx, pi, tools };
}
const message = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return (error as Error).message; } return ""; };

test("agent_status, agent_cancel and agent_message name jobId, echo it and say how to list valid ids", async () => {
	const { ctx, tools } = setup();
	for (const name of ["agent_status", "agent_cancel"]) {
		const result = await tools.get(name).execute("id", { jobId: "01NOSUCH" }, undefined, undefined, ctx);
		assert.equal(result.isError, true, name);
		const text = result.content[0].text as string;
		assert.match(text, /^BACKGROUND_JOB_NOT_FOUND: jobId "01NOSUCH" was not found among the retained subagent jobs and Spinoffs/, name);
		assert.match(text, /Call agent_status without jobId to list valid jobIds/, name);
	}
	const text = await message(messageSpinoff(ctx, "01NOSUCH", "hi"));
	assert.match(text, /^SPINOFF_NOT_FOUND: jobId "01NOSUCH" is not a Spinoff/);
});

test("spinoff argument errors split causes and carry a fix", () => {
	const { ctx, pi } = setup();
	const err = (params: any) => { try { acceptSpinoff(pi, ctx, params); } catch (error) { return (error as Error).message; } return ""; };
	assert.match(err({}), /^SPINOFF_INVALID_ARGUMENTS: task is required and must be a string; received nothing/);
	assert.match(err({ task: 5 }), /task is required and must be a string; received number/);
	assert.match(err({ task: "  " }), /task is empty or whitespace-only; describe what the Spinoff must do/);
	assert.match(err({ task: "a\uD800b" }), /task contains an unpaired UTF-16 surrogate at index 1; remove or replace that character/);
	assert.match(err({ task: "x".repeat(100 * 1024 + 1) }), /^SPINOFF_TASK_TOO_LARGE: task is 102401 bytes \(UTF-8\), over the 102400-byte limit; shorten it/);
	assert.match(err({ task: "x", title: 5 }), /title must be a string; received number/);
	assert.match(err({ task: "x", title: "y".repeat(121) }), /title is 121 characters \(max 120\); shorten it or omit title/);
	state().admission = false;
	assert.match(err({ task: "x" }), /^SPINOFF_NOT_ACCEPTING: .*Nothing was started; retry after the reload completes/);
});

test("spinoff capacity messages give the count and the next step", () => {
	const { ctx, pi } = setup();
	for (let i = 0; i < 4; i++) acceptSpinoff(pi, ctx, { task: `t${i}` });
	assert.throws(() => acceptSpinoff(pi, ctx, { task: "fifth" }), /SPINOFF_CAPACITY: .*\(4 of 4 unfinished Spinoffs per Pi process\)\. Wait for one to finish, or call agent_status to list them and agent_cancel/);
});

test("agent_message argument and state errors name the parameter, the received value and the fix", async () => {
	const { ctx, pi } = setup();
	const receipt = acceptSpinoff(pi, ctx, { task: "x" });
	assert.match(await message(messageSpinoff(ctx, "", "hi")), /^SPINOFF_INVALID_ARGUMENTS: jobId must be a non-empty string, the complete job ID returned by spinoff .*received "".*agent_status/);
	assert.match(await message(messageSpinoff(ctx, 7, "hi")), /received "7"/);
	assert.match(await message(messageSpinoff(ctx, receipt.jobId, "hi", "later")), /^SPINOFF_INVALID_ARGUMENTS: mode "later" is invalid: use "follow_up" .* or "steer"/);
	assert.match(await message(messageSpinoff(ctx, receipt.jobId, "   ")), /^SPINOFF_INVALID_ARGUMENTS: INVALID_MESSAGE: message is blank/);
	assert.match(await message(messageSpinoff(ctx, receipt.jobId, "x".repeat(70000))), /INVALID_MESSAGE: message is 70000 bytes but at most 65536/);
	const busy = await message(messageSpinoff(ctx, receipt.jobId, "hi"));
	assert.match(busy, /^SPINOFF_BUSY: Spinoff is awaiting_snapshot; a message is only accepted while it is running or blocked \(nothing was queued\)\. It has not started yet: retry after agent_status shows running/);
});

test("agent-facing messages name tool args only, never startup flags, settings or environment variables", () => {
	const forbidden = /--no-session|--tools|--exclude-tools|allowlist|exclusion|settings|pi-spinoff|pi-subagents|pi-monitor|\bPI_[A-Z]|\.pi\/agent/i;
	const { ctx, pi, tools } = setup();
	const memory = SessionManager.inMemory(cwd);
	for (const entry of ctx.sessionManager.getEntries()) memory.appendMessage(entry.message as never);
	const text = (() => { try { acceptSpinoff(pi, { ...ctx, sessionManager: memory }, { task: "x" }); } catch (error) { return (error as Error).message; } return ""; })();
	assert.match(text, /^SPINOFF_REQUIRES_PERSISTED_SESSION: the current conversation has no native session file/);
	assert.match(text, /use the subagent tool/);
	assert.doesNotMatch(text, forbidden);
	for (const tool of tools.values()) assert.doesNotMatch(`${tool.description} ${(tool.promptGuidelines ?? []).join(" ")} ${JSON.stringify(tool.parameters)}`, forbidden, tool.name);
});

test("agent_cancel on a finished Spinoff says it is already finished instead of Cancel requested", async () => {
	const { ctx, pi, tools } = setup();
	onSessionStart(pi, ctx);
	const receipt = acceptSpinoff(pi, ctx, { task: "x" });
	const cancelled = await tools.get("agent_cancel").execute("id", { jobId: receipt.jobId }, undefined, undefined, ctx);
	assert.match(cancelled.content[0].text, /^Cancel requested for /);
	await new Promise(resolve => setImmediate(resolve)); onTurnEnd(ctx, {});
	await new Promise(resolve => setTimeout(resolve, 50));
	const again = await tools.get("agent_cancel").execute("id", { jobId: receipt.jobId }, undefined, undefined, ctx);
	assert.match(again.content[0].text, new RegExp(`^Spinoff ${receipt.jobId} is already cancelled; nothing to cancel\\.`));
	assert.doesNotMatch(again.content[0].text, /Cancel requested/);
});
