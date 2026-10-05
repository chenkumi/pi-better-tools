import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import registerSubagent from "../extensions/subagent/index.ts";

const cli = process.env.PI_SUBAGENTS_TEST_CLI;
const provider = fileURLToPath(new URL("./fixtures/pi-provider.ts", import.meta.url));
const launcher = fileURLToPath(new URL("./fixtures/background-child.mjs", import.meta.url));
for (const mode of ["single", "parallel", "chain", "resume"] as const) {
	test(`background ${mode}: real isolated Pi/fake provider commits before followUp`, { skip: !cli && "Set PI_SUBAGENTS_TEST_CLI to a verified installed CLI", timeout: 60000 }, async () => {
		console.log(`[progress] Verifying background ${mode} real child lifecycle`);
		const root = await realpath(await mkdtemp(join(tmpdir(), "pi-background-contract-")));
		const tools = new Map<string, ToolDefinition>(); const handlers = new Map<string, Function>();
		let complete!: (value: any) => void; const completion = new Promise<any>(r => { complete = r; });
		const liveChecks: Promise<unknown>[] = []; const notifications: any[] = [];
		const ctx = { cwd: root, hasUI: false, isProjectTrusted: () => false, model: { provider: "subagent-test", id: "fixture", reasoning: false }, thinkingLevel: "off",
			sessionManager: { getSessionId: () => "background-owner" }, modelRegistry: {
				find: (p: string, id: string) => p === "subagent-test" && id === "fixture" ? { provider: p, id, reasoning: false } : undefined,
				getAll: () => [{ provider: "subagent-test", id: "fixture", reasoning: false }],
			} } as unknown as ExtensionContext;
		try {
			await mkdir(join(root, "config"));
			await writeFile(join(root, "config/settings.json"), JSON.stringify({ extensions: [provider], compaction: { enabled: false }, cacheWarming: "off", defaultProjectTrust: "never", defaultTools: [] }));
			registerSubagent({ registerTool(tool) { tools.set(tool.name, tool); }, on(name, handler) { handlers.set(name, handler); },
				sendMessage(message, options) {
					notifications.push({ message, options });
					const data = message.details as any;
					if (data.kind === "log_ready") for (const task of data.tasks) if (task.liveLogPath) liveChecks.push(stat(task.liveLogPath));
					if (data.kind === "task_result") complete(data);
				} } as ExtensionAPI, { debugLog: false, sessionRootDir: join(root, "managed"), invocation: args => ({ command: process.execPath, args: [launcher, root, resolve(cli!), ...args] }) });
			let call = 0;
			const execute = (name: string, args: any, signal?: AbortSignal) => tools.get(name)!.execute(`${name}-${mode}-${++call}`, args, signal, undefined, ctx);
			const task = { agent: "worker", task: "Offline background fixture; no paid model calls." };
			let args: any = mode === "parallel" ? { tasks: [task, task] } : mode === "chain" ? { chain: [task, { ...task, task: "Continue: {previous}" }] } : task;
			if (mode === "resume") {
				const initial = await execute("subagent", task); assert.equal(initial.isError, undefined);
				args = { resume: (initial.details as any).results[0].subagentSessionId, task: "Continue in background" };
			}
			const turn = new AbortController();
			const accepted = await execute("subagent", { ...args, background: true }, turn.signal);
			assert.equal(accepted.isError, undefined, JSON.stringify(accepted.content));
			const receipt = (accepted.details as any).background; assert.equal(receipt.status, "queued");
			assert.ok(receipt.tasks.every((task: any) => task.logPending && !task.liveLogPath && !task.finalLogPath));
			assert.equal(accepted.usage, undefined); turn.abort(); // accepted jobs no longer belong to this tool turn
			const result = await completion; await Promise.all(liveChecks);
			assert.equal(result.status, "completed", JSON.stringify(result)); assert.equal(result.tasks.length, mode === "parallel" || mode === "chain" ? 2 : 1);
			assert.deepEqual(result.tasks.map((task: any) => task.taskId), receipt.tasks.map((task: any) => task.taskId));
			for (const task of result.tasks) {
				assert.equal(task.result.canResume, true); assert.equal(task.result.output, "done"); assert.equal(task.result.usage.totalTokens, 12);
				assert.equal(task.liveLogPath, undefined);
				const directory = join(root, "managed", task.subagentSessionId);
				assert.equal(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")).state, "ready");
				await assert.rejects(stat(join(directory, "writer.lock")), { code: "ENOENT" });
				await stat(task.result.logPath);
			}
			const notice = notifications.find(entry => entry.message.details.kind === "task_result");
			assert.deepEqual(notice.options, { triggerTurn: true, deliverAs: "followUp" });
			const status = await execute("subagent_status", { jobId: receipt.jobId }); assert.equal(status.usage, undefined);
			assert.equal((status.details as any).status, "completed");
			const denied = await tools.get("subagent_status")!.execute("wrong-owner", { jobId: receipt.jobId }, undefined, undefined,
				{ ...ctx, sessionManager: { getSessionId: () => "another-owner" } } as any);
			assert.equal(denied.isError, true);
		} finally { await handlers.get("session_shutdown")?.({}, ctx); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
		console.log(`[progress] Verified and cleaned background ${mode}`);
	});
}
