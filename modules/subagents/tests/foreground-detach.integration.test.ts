import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, watch } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import registerSubagent from "../extensions/subagent/index.ts";

// A foreground subagent dispatch is moved to a background job by the shared detach shortcut while its children keep
// running (never restarted). Real isolated Pi child + fake provider; the child is held mid-run by an event-driven gate.
const cli = process.env.PI_SUBAGENTS_TEST_CLI;
const provider = fileURLToPath(new URL("./fixtures/pi-provider.ts", import.meta.url));
const launcher = fileURLToPath(new URL("./fixtures/background-child.mjs", import.meta.url));

async function rig(root: string) {
	const tools = new Map<string, ToolDefinition>(), handlers = new Map<string, Function[]>(), notices: any[] = [], statuses: Array<string | undefined> = [], toasts: string[] = [];
	let shortcut: ((ctx: any) => unknown) | undefined;
	const waiters: Array<() => void> = [];
	const ctx = { cwd: root, mode: "tui", hasUI: true,
		ui: { setStatus(_key: string, text: string | undefined) { statuses.push(text); }, setWidget() {}, notify(message: string) { toasts.push(message); } },
		isProjectTrusted: () => false, model: { provider: "subagent-test", id: "fixture", reasoning: false }, thinkingLevel: "off",
		sessionManager: { getSessionId: () => "detach-owner" },
		modelRegistry: { find: (p: string, id: string) => p === "subagent-test" && id === "fixture" ? { provider: p, id, reasoning: false } : undefined, getAll: () => [{ provider: "subagent-test", id: "fixture", reasoning: false }] } } as unknown as ExtensionContext;
	registerSubagent({
		registerCommand() {}, registerMessageRenderer() {}, registerTool(tool) { tools.set(tool.name, tool); }, on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerShortcut(_key: string, options: { handler: (ctx: any) => unknown }) { shortcut = options.handler; },
		sendMessage(message) { notices.push((message as any).details); for (const wake of waiters.splice(0)) wake(); },
	} as unknown as ExtensionAPI, { debugLog: false, sessionRootDir: join(root, "managed"), invocation: args => ({ command: process.execPath, args: [launcher, root, resolve(cli!), ...args] }) });
	for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
	let call = 0;
	return {
		ctx, notices, statuses, toasts,
		execute: (name: string, args: any, signal?: AbortSignal) => tools.get(name)!.execute(`${name}-${++call}`, args, signal, undefined, ctx),
		press: () => shortcut!(ctx),
		async notice(predicate: (notice: any) => boolean) {
			for (;;) { const found = notices.find(predicate); if (found) return found; await new Promise<void>(wake => waiters.push(wake)); }
		},
		shutdown: async () => { for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx); },
	};
}

/** Resolves once `hold-started` holds one mark per child that reached the gate. */
function childrenHeld(root: string, count: number) {
	const marker = join(root, "hold-started");
	const reached = () => existsSync(marker) && readFileSync(marker, "utf8").length >= count;
	return new Promise<void>(resolveHeld => {
		const watcher = watch(root, () => { if (reached()) { watcher.close(); resolveHeld(); } });
		if (reached()) { watcher.close(); resolveHeld(); }
	});
}

async function withRoot(body: (root: string) => Promise<void>) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-foreground-detach-")));
	try {
		await mkdir(join(root, "config"));
		await writeFile(join(root, "config/settings.json"), JSON.stringify({ extensions: [provider], compaction: { enabled: false }, cacheWarming: "off", defaultProjectTrust: "never", defaultTools: [] }));
		await writeFile(join(root, "hold-enabled"), "");
		await body(root);
	} finally { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}

const task = { agent: "worker", title: "Detach", task: "Offline foreground detach fixture; no paid model calls." };
const skip = !cli && "Set PI_SUBAGENTS_TEST_CLI to a verified installed CLI";

test("detach shortcut moves a running single foreground dispatch to a background job without restarting the child", { skip, timeout: 90000 }, async () => {
	await withRoot(async root => {
		const host = await rig(root);
		try {
			const turn = new AbortController();
			const pending = host.execute("subagent", task, turn.signal);
			await childrenHeld(root, 1);
			assert.ok(host.statuses.some(text => /Alt\+J/.test(text ?? "")), "the detach hint is shown while the dispatch runs");
			await host.press();
			assert.match(host.toasts.at(-1)!, /Moving 1/);
			const detached = await pending;
			assert.equal(detached.isError, undefined, JSON.stringify(detached.content));
			assert.match((detached.content[0] as any).text, /Moved to a background job at the user's request/);
			const receipt = (detached.details as any).background;
			assert.equal(receipt.tasks.length, 1);
			assert.equal(host.statuses.at(-1), undefined, "the hint is cleared after the handoff");
			turn.abort(); // the finished tool turn must not stop the adopted child
			await writeFile(join(root, "hold-release"), "");
			const done = await host.notice(notice => notice.jobId === receipt.jobId && notice.kind === "task_result");
			assert.equal(done.status, "completed", JSON.stringify(done));
			assert.equal(done.tasks[0].taskId, receipt.tasks[0].taskId, "the adopted task keeps its identity");
			assert.equal(done.tasks[0].result.output, "done");
			assert.equal(readFileSync(join(root, "hold-started"), "utf8").length, 1, "the child was started exactly once");
			const status = await host.execute("subagent_status", { jobId: receipt.jobId });
			assert.equal((status.details as any).status, "completed");
		} finally { await host.shutdown(); }
	});
});

test("detached parallel dispatch reports each task and subagent_cancel stops the adopted children", { skip, timeout: 90000 }, async () => {
	await withRoot(async root => {
		const host = await rig(root);
		try {
			const pending = host.execute("subagent", { tasks: [task, task] });
			await childrenHeld(root, 2);
			await host.press();
			const detached = await pending;
			const receipt = (detached.details as any).background;
			assert.equal(receipt.tasks.length, 2);
			await host.execute("subagent_cancel", { jobId: receipt.jobId });
			const final = await host.notice(notice => notice.jobId === receipt.jobId && notice.kind === "job_result");
			assert.ok(["aborted", "failed"].includes(final.status), JSON.stringify(final));
			assert.deepEqual(final.tasks.map((t: any) => t.taskId), receipt.tasks.map((t: any) => t.taskId));
			assert.ok(final.tasks.every((t: any) => t.status !== "completed" && t.status !== "running"), "cancelled children are not reported as completed");
		} finally { await host.shutdown(); }
	});
});

test("detached chain keeps running its remaining steps and reports one final result", { skip, timeout: 90000 }, async () => {
	await withRoot(async root => {
		const host = await rig(root);
		try {
			const pending = host.execute("subagent", { chain: [task, { ...task, task: "Continue: {previous}" }] });
			await childrenHeld(root, 1);
			await host.press();
			const receipt = ((await pending).details as any).background;
			assert.equal(receipt.tasks.length, 2);
			await writeFile(join(root, "hold-release"), "");
			const final = await host.notice(notice => notice.jobId === receipt.jobId && notice.kind === "task_result");
			assert.equal(final.status, "completed", JSON.stringify(final));
			assert.deepEqual(final.tasks.map((t: any) => t.taskId), receipt.tasks.map((t: any) => t.taskId));
			assert.ok(final.tasks.every((t: any) => t.status === "completed" && t.result.output === "done"));
		} finally { await host.shutdown(); }
	});
});
