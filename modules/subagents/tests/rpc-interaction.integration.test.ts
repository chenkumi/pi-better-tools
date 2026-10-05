import assert from "node:assert/strict";
import test from "node:test";
import { watch } from "node:fs";
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import registerSubagent from "../extensions/subagent/index.ts";
import { controlText } from "../extensions/subagent/query-snapshot.ts";
const cli = process.env.PI_SUBAGENTS_TEST_CLI;
const provider = fileURLToPath(new URL("./fixtures/rpc-provider.ts", import.meta.url));
const launcher = fileURLToPath(new URL("./fixtures/background-child.mjs", import.meta.url));
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-rpc-interaction-")));
	const tools = new Map<string, ToolDefinition>(), handlers = new Map<string, Function>(); const notices: any[] = [], waiters: (() => void)[] = [];
	const ctx = { cwd: root, hasUI: false, isProjectTrusted: () => false, model: { provider: "subagent-test", id: "fixture", reasoning: false }, thinkingLevel: "off",
		sessionManager: { getSessionId: () => "rpc-owner" }, modelRegistry: { find: (p: string, id: string) => p === "subagent-test" && id === "fixture" ? { provider: p, id, reasoning: false } : undefined,
			getAll: () => [{ provider: "subagent-test", id: "fixture", reasoning: false }] } } as unknown as ExtensionContext;
	await mkdir(join(root, "config"));
	await writeFile(join(root, "config/settings.json"), JSON.stringify({ extensions: [provider], defaultTools: ["barrier", "forbidden"], compaction: { enabled: false }, cacheWarming: "off", defaultProjectTrust: "never" }));
	registerSubagent({ registerTool(tool) { tools.set(tool.name, tool); }, on(name, handler) { handlers.set(name, handler); }, sendMessage(message, options) {
		notices.push({ ...message.details as any, options }); for (const notify of waiters.splice(0)) notify();
	} } as ExtensionAPI, { debugLog: false, sessionRootDir: join(root, "managed"), invocation: args => ({ command: process.execPath, args: [launcher, root, resolve(cli!), ...args] }) });
	let calls = 0;
	const execute = (name: string, args: any, context = ctx) => tools.get(name)!.execute(`${name}-${++calls}`, args, undefined, undefined, context);
	async function notice(predicate: (value: any) => boolean): Promise<any> {
		for (;;) { const found = notices.find(predicate); if (found) return found; await new Promise<void>(r => waiters.push(r)); }
	}
	async function file(name: string) {
		const path = join(root, name);
		await new Promise<void>((resolve, reject) => {
			const observer = watch(root, () => { void access(path).then(() => { observer.close(); resolve(); }, () => {}); });
			observer.on("error", reject); void access(path).then(() => { observer.close(); resolve(); }, () => {});
		}); return path;
	}
	return { root, ctx, tools, handlers, notices, execute, notice, file, async close() { await handlers.get("session_shutdown")?.({}, ctx); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } };
}

test("RPC control and queries: literal canonical steering, stale safe prefix, no mainline mutations or tool dispatch", { skip: !cli && "Set PI_SUBAGENTS_TEST_CLI", timeout: 60000 }, async () => {
	console.log("[progress] Verifying literal RPC control and safe disposable queries"); const f = await fixture();
	try {
		const prime = await f.execute("subagent", { agent: "worker", task: "prime" }); assert.equal(prime.isError, undefined, JSON.stringify(prime.content));
		const session = (prime.details as any).results[0].subagentSessionId;
		const accepted = await f.execute("subagent", { resume: session, task: "interactive", background: true }); assert.equal(accepted.isError, undefined);
		const { jobId, tasks } = (accepted.details as any).background; const taskId = tasks[0].taskId;
		const ready = JSON.parse(await readFile(await f.file("barrier-ready.json"), "utf8"));
		await f.notice(n => n.kind === "log_ready" && n.tasks[0].canMessage);
		const before = await readFile(ready.sessionFile, "utf8");
		for (const args of [{ jobId, taskId: "wrong", mode: "control", message: "wrong" }, { jobId: "wrong", taskId, mode: "query", message: "wrong" }]) assert.equal((await f.execute("subagent_message", args)).isError, true);
		const denied = await f.execute("subagent_message", { jobId, taskId, mode: "query", message: "wrong owner" }, { ...f.ctx, sessionManager: { getSessionId: () => "other" } } as any); assert.equal(denied.isError, true);
		const literal = "/skill:literal\n@file\nDo not replace literal input.";
		const control = await f.execute("subagent_message", { jobId, taskId, mode: "control", message: literal }); assert.equal((control.details as any).status, "accepted");
		const query = await f.execute("subagent_message", { jobId, taskId, mode: "query", message: "progress?" }); assert.equal((query.details as any).status, "accepted"); assert.equal(query.usage, undefined);
		const answer = await f.notice(n => n.kind === "query_result" && n.interaction.queryId === (query.details as any).queryId);
		assert.equal(answer.interaction.status, "completed", JSON.stringify(answer.interaction)); assert.equal(answer.interaction.asOf.stale, true);
		assert.deepEqual(answer.interaction.asOf.pendingToolCallIds, ["main-barrier"]); assert.equal(answer.interaction.asOf.sourceLeafId, ready.leafId);
		const content = JSON.parse(answer.interaction.output); assert.deepEqual(content.tools, []); assert.ok(content.opaque.includes("opaque-prime"));
		assert.equal(content.roles.includes("toolResult"), false); assert.equal(answer.interaction.usage.totalTokens, 12);
		assert.deepEqual(answer.options, { triggerTurn: true, deliverAs: "followUp" });
		assert.equal(await readFile(ready.sessionFile, "utf8"), before, "query and queued control must not change canonical leaf/file");
		const status = await f.execute("subagent_status", { jobId }); assert.ok(["accepted", "queued"].includes((status.details as any).tasks[0].controls[0].status));
		for (const question of ["emit-tool", "fail-query"]) {
			const submitted = await f.execute("subagent_message", { jobId, taskId, mode: "query", message: question });
			const failed = await f.notice(n => n.kind === "query_result" && n.interaction.queryId === (submitted.details as any).queryId);
			assert.equal(failed.interaction.status, "failed"); assert.equal(failed.interaction.usage.totalTokens, 12);
			assert.match(failed.interaction.error, question === "emit-tool" ? /QUERY_TOOLS_FORBIDDEN/ : /offline query failure/);
		}
		const streamed = await f.execute("subagent_message", { jobId, taskId, mode: "query", message: "stream-tool" });
		await f.file("query-tool-aborted");
		const streamedResult = await f.notice(n => n.kind === "query_result" && n.interaction.queryId === (streamed.details as any).queryId);
		assert.equal(streamedResult.interaction.status, "failed"); assert.match(streamedResult.interaction.error, /QUERY_TOOLS_FORBIDDEN/);
		assert.equal(streamedResult.interaction.usageUnknown, true); assert.equal(streamedResult.interaction.usage, undefined);
		await assert.rejects(stat(join(f.root, "forbidden-executed")), { code: "ENOENT" }); assert.equal(await readFile(ready.sessionFile, "utf8"), before);
		console.log("[progress] Safe query completed without mainline mutation; releasing long tool"); await writeFile(join(f.root, "release"), "continue");
		const applied = await f.notice(n => n.kind === "control_result" && n.interaction.messageId === (control.details as any).messageId);
		assert.equal(applied.interaction.status, "applied"); assert.ok(applied.interaction.userOrdinal > 0);
		const complete = await f.notice(n => n.kind === "task_result"); assert.equal(complete.status, "completed", JSON.stringify(complete));
		assert.equal(complete.tasks[0].result.usage.totalTokens, 24, "query usage is not main usage"); assert.equal(complete.tasks[0].result.canResume, true);
		const after = await readFile(ready.sessionFile, "utf8"); const native = after.trim().split("\n").map(line => JSON.parse(line));
		const controls = native.filter(e => e.type === "message" && e.message.role === "user" && JSON.stringify(e.message.content).includes("Delegated user control"));
		assert.equal(controls.length, 1); assert.equal(controls[0].message.content[0].text, controlText((control.details as any).messageId, literal));
		assert.equal(after.includes("Literal parent query"), false); assert.equal(after.includes("offline query answer"), false);
		assert.equal(JSON.parse(await readFile(join(f.root, "managed", session, "manifest.json"), "utf8")).state, "ready");
		await assert.rejects(stat(join(f.root, "managed", session, "writer.lock")), { code: "ENOENT" });
		assert.equal((await f.execute("subagent_message", { jobId, taskId, mode: "control", message: "late" })).isError, true);
		const resumed = await f.execute("subagent", { resume: session, task: "resume verified digest" }); assert.equal(resumed.isError, undefined, JSON.stringify(resumed.content));
		assert.equal((resumed.details as any).results[0].canResume, true);
	} finally { await f.close(); }
	console.log("[progress] Verified literal controls, query isolation and managed resume");
});

test("RPC cancellation reaches an active query API and rejects settled target messaging", { skip: !cli && "Set PI_SUBAGENTS_TEST_CLI", timeout: 60000 }, async () => {
	console.log("[progress] Verifying active RPC query cancellation"); const f = await fixture();
	try {
		const result = await f.execute("subagent", { agent: "worker", task: "interactive", background: true });
		const { jobId, tasks } = (result.details as any).background; await f.file("barrier-ready.json"); await f.notice(n => n.kind === "log_ready" && n.tasks[0].canMessage);
		const query = await f.execute("subagent_message", { jobId, taskId: tasks[0].taskId, mode: "query", message: "hold-query" }); await f.file("query-capture.json");
		const cancel = await f.execute("subagent_cancel", { jobId }); assert.equal((cancel.details as any).cancelRequested, true);
		await f.file("query-aborted");
		const complete = await f.notice(n => n.kind === "task_result"); assert.equal(complete.status, "aborted", JSON.stringify(complete));
		const answer = await f.notice(n => n.kind === "query_result" && n.interaction.queryId === (query.details as any).queryId);
		assert.equal(answer.interaction.status, "aborted"); assert.ok(answer.interaction.usageUnknown || answer.interaction.usage?.totalTokens === 12);
		assert.equal((await f.execute("subagent_message", { jobId, taskId: tasks[0].taskId, mode: "query", message: "late" })).isError, true);
	} finally { await f.close(); }
	console.log("[progress] Verified active query cancellation and settled target rejection");
});

test("owner session replacement cancels active query API and suppresses old-generation callbacks", { skip: !cli && "Set PI_SUBAGENTS_TEST_CLI", timeout: 60000 }, async () => {
	console.log("[progress] Verifying active RPC query owner replacement"); const f = await fixture();
	try {
		const result = await f.execute("subagent", { agent: "worker", task: "interactive", background: true });
		const { jobId, tasks } = (result.details as any).background; await f.file("barrier-ready.json"); await f.notice(n => n.kind === "log_ready" && n.tasks[0].canMessage);
		await f.execute("subagent_message", { jobId, taskId: tasks[0].taskId, mode: "query", message: "hold-query" }); await f.file("query-capture.json");
		const before = f.notices.length;
		await f.handlers.get("session_start")!({}, { ...f.ctx, sessionManager: { getSessionId: () => "replacement-owner" } });
		await stat(join(f.root, "query-aborted")); assert.equal(f.notices.length, before, "old query/task callbacks must not notify replacement owner");
		assert.equal((await f.execute("subagent_status", { jobId })).isError, true);
		assert.equal((await f.execute("subagent_message", { jobId, taskId: tasks[0].taskId, mode: "query", message: "stale" })).isError, true);
	} finally { await f.close(); }
	console.log("[progress] Verified owner replacement cleanup and callback suppression");
});

test("RPC transformed controls are delivery_unknown while handled hooks are not canonical application", { skip: !cli && "Set PI_SUBAGENTS_TEST_CLI", timeout: 60000 }, async () => {
	console.log("[progress] Verifying transformed and handled input hooks"); const f = await fixture();
	try {
		const result = await f.execute("subagent", { agent: "worker", task: "interactive", background: true });
		const { jobId, tasks } = (result.details as any).background; const taskId = tasks[0].taskId;
		const ready = JSON.parse(await readFile(await f.file("barrier-ready.json"), "utf8"));
		await f.notice(n => n.kind === "log_ready" && n.tasks[0].canMessage);
		const transformed = await f.execute("subagent_message", { jobId, taskId, mode: "control", message: "transform-control" });
		await f.file("control-transformed");
		const handled = await f.execute("subagent_message", { jobId, taskId, mode: "control", message: "handled-control" });
		const consumed = await f.notice(n => n.kind === "control_result" && n.interaction.messageId === (handled.details as any).messageId);
		assert.equal(consumed.interaction.status, "not_applied"); assert.match(consumed.interaction.error, /input handler consumed/);
		await writeFile(join(f.root, "release"), "continue");
		const unknown = await f.notice(n => n.kind === "control_result" && n.interaction.messageId === (transformed.details as any).messageId);
		assert.equal(unknown.interaction.status, "delivery_unknown", "lost correlation must not invite an automatic resend");
		const done = await f.notice(n => n.kind === "task_result"); assert.equal(done.status, "completed", JSON.stringify(done));
		assert.equal(done.tasks[0].result.canResume, true, "transformed canonical wire/native digest still commits");
		const native = await readFile(ready.sessionFile, "utf8"); assert.ok(native.includes("transformed canonical delegated instruction"));
		assert.equal(native.includes("handled-control"), false); assert.equal(native.includes("transform-control"), false);
	} finally { await f.close(); }
});
