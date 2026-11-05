// Codemode contract: each Fork tool declares an outputSchema and every successful result's structuredContent validates against it.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import forkExtension from "../src/index.ts";
import { acceptFork, deps, onSessionStart, state } from "../src/manager.ts";

const KEY = Symbol.for("pi-better-tools.fork.registry.v1");
let root: string, cwd: string, sessions: string;
beforeEach(() => {
	delete (globalThis as any)[KEY];
	root = mkdtempSync(join(tmpdir(), "fork-out-"));
	cwd = realpathSync(root); sessions = join(cwd, "sessions");
	deps.argv = () => []; deps.launchCwd = () => cwd;
});
afterEach(() => { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); delete (globalThis as any)[KEY]; });

function setup() {
	const sm = SessionManager.create(cwd, sessions);
	sm.appendMessage({ role: "user", content: "hello", timestamp: Date.now() } as never);
	sm.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "fork", arguments: {} }], api: "x", provider: "x", model: "x", stopReason: "toolUse", timestamp: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as never);
	const tools = new Map<string, any>();
	const ctx: any = { cwd, model: { provider: "p", id: "m" }, isProjectTrusted: () => false, hasUI: false, ui: { setStatus() {} }, sessionManager: sm };
	const pi: any = { getActiveTools: () => ["read", "fork"], getAllTools: () => [{ name: "read", sourceInfo: { path: "/ext/read.ts" } }], getThinkingLevel: () => "off", sendMessage() {},
		registerTool: (tool: any) => tools.set(tool.name, tool), registerMessageRenderer() {}, registerCommand() {}, on() {} };
	forkExtension(pi);
	return { ctx, pi, tools };
}
const run = (tools: Map<string, any>, name: string, params: unknown, ctx: unknown) => tools.get(name).execute("id", params, undefined, undefined, ctx);
const valid = (tools: Map<string, any>, name: string, result: any) => {
	assert.ok(tools.get(name).outputSchema, `${name} declares outputSchema`);
	assert.ok(result.structuredContent, `${name} sets structuredContent`);
	assert.equal(Check(tools.get(name).outputSchema, result.structuredContent), true, `${name}: ${JSON.stringify(result.structuredContent)}`);
};

test("every Fork tool declares an outputSchema", () => {
	const { tools } = setup();
	assert.equal(tools.size, 4);
	for (const tool of tools.values()) assert.ok(tool.outputSchema, tool.name);
});

test("fork, fork_status (list and one), fork_cancel and fork_message results validate against their outputSchema", async () => {
	const { ctx, pi, tools } = setup();
	onSessionStart(pi, ctx);
	const accepted = await run(tools, "fork", { task: "x", title: "T" }, ctx);
	valid(tools, "fork", accepted);
	const jobId = accepted.structuredContent.jobId as string;
	assert.deepEqual(accepted.structuredContent, accepted.details);

	const list = await run(tools, "fork_status", {}, ctx);
	valid(tools, "fork_status", list);
	assert.equal(list.structuredContent.forks.length, 1);
	assert.deepEqual(JSON.parse(list.content[0].text), list.structuredContent, "structuredContent equals the model-visible JSON");
	const one = await run(tools, "fork_status", { jobId }, ctx);
	valid(tools, "fork_status", one);
	assert.deepEqual(JSON.parse(one.content[0].text), one.structuredContent);

	// fork_message: a live child handle is needed for a receipt.
	const job = state().jobs.get(jobId)!;
	job.record.status = "running";
	(job as any).handle = { steer: async () => "queued" };
	const sent = await run(tools, "fork_message", { jobId, message: "hi" }, ctx);
	valid(tools, "fork_message", sent);
	assert.equal(sent.structuredContent.status, "queued");
	valid(tools, "fork_status", await run(tools, "fork_status", { jobId }, ctx)); // now carries interactions

	delete (job as any).handle;
	const cancelled = await run(tools, "fork_cancel", { jobId }, ctx);
	valid(tools, "fork_cancel", cancelled);
	await new Promise(resolve => setTimeout(resolve, 50));
	const again = await run(tools, "fork_cancel", { jobId }, ctx); // already-terminal branch
	valid(tools, "fork_cancel", again);
});
