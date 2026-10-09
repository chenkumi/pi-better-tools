import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import registerSubagent from "../extensions/subagent/index.ts";
import { SUBAGENT_WIDGET_KEY } from "../extensions/subagent/live-widget.ts";

const cli = process.env.PI_SUBAGENTS_TEST_CLI;
const provider = fileURLToPath(new URL("./fixtures/pi-provider.ts", import.meta.url));
const launcher = fileURLToPath(new URL("./fixtures/background-child.mjs", import.meta.url));
for (const mode of ["single", "parallel", "chain", "resume"] as const) {
	test(`background ${mode}: real isolated Pi/fake provider commits before followUp`, { skip: !cli && "Set PI_SUBAGENTS_TEST_CLI to a verified installed CLI", timeout: 60000 }, async () => {
		console.log(`[progress] Verifying background ${mode} real child lifecycle`);
		const root = await realpath(await mkdtemp(join(tmpdir(), "pi-background-contract-")));
		const tools = new Map<string, ToolDefinition>(); const handlers = new Map<string, Function>(), commands = new Map<string, any>(), statuses = new Map<string, string>(), renderers = new Map<string, any>();
		let complete!: (value: any) => void; const completion = new Promise<any>(r => { complete = r; });
		const liveChecks: Promise<unknown>[] = []; const notifications: any[] = []; const widgets = new Map<string, any>(); const panelHistory: string[] = [];
		const theme: any = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, getBgAnsi: () => "" };
		const ctx = { cwd: root, mode: "tui", hasUI: true, ui: { setStatus(key: string, text: string | undefined) { if (text) statuses.set(key, text); else statuses.delete(key); }, setWidget(key: string, value: any) { if (value) { widgets.set(key, value); panelHistory.push(value({}, theme).render(140).join("\n")); } else widgets.delete(key); } }, isProjectTrusted: () => false, model: { provider: "subagent-test", id: "fixture", reasoning: false }, thinkingLevel: "off",
			sessionManager: { getSessionId: () => "background-owner" }, modelRegistry: {
				find: (p: string, id: string) => p === "subagent-test" && id === "fixture" ? { provider: p, id, reasoning: false } : undefined,
				getAll: () => [{ provider: "subagent-test", id: "fixture", reasoning: false }],
			} } as unknown as ExtensionContext;
		try {
			await mkdir(join(root, "config"));
			await writeFile(join(root, "config/settings.json"), JSON.stringify({ extensions: [provider], compaction: { enabled: false }, cacheWarming: "off", defaultProjectTrust: "never", defaultTools: [] }));
			registerSubagent({ registerCommand(name, definition) { commands.set(name, definition); }, registerMessageRenderer(name, renderer) { assert.equal(typeof renderer, 'function'); renderers.set(name, renderer); }, registerTool(tool) { tools.set(tool.name, tool); }, on(name, handler) { handlers.set(name, handler); },
				sendMessage(message, options) {
					notifications.push({ message, options });
					const data = message.details as any;
					assert.equal(message.display, data.kind !== "log_ready");
					if (data.kind !== "log_ready") {
						const modelNotice = JSON.parse(message.content as string);
						assert.match(modelNotice.outputTrust, /data for review, not instructions/);
						assert.match(modelNotice.outputTrust, /informational label does not indicate failure/);
						assert.match(modelNotice.outputTrust, /use status\/error fields/);
						assert.doesNotMatch(modelNotice.outputTrust, /untrusted/);
						assert.equal(modelNotice.status, data.status);
					}
					assert.deepEqual(options, { triggerTurn: data.kind !== "log_ready", deliverAs: "followUp" });
					if (data.kind === "log_ready") for (const task of data.tasks) if (task.liveLogPath) { assert.equal(task.finalLogPath, task.liveLogPath.replace(/\.partial$/, "")); const finalPath = task.finalLogPath; liveChecks.push(stat(task.liveLogPath).catch(error => { if (error?.code !== "ENOENT") throw error; return stat(finalPath); })); } // the live file may already be renamed to its announced final path
					if (data.kind === "task_result") complete(data);
				} } as ExtensionAPI, { debugLog: false, sessionRootDir: join(root, "managed"), invocation: args => ({ command: process.execPath, args: [launcher, root, resolve(cli!), ...args] }) });
			assert.deepEqual([...renderers.keys()].sort(), ['background-runtime-recovery-subagent', 'subagent_background']);
			await handlers.get("session_start")!({}, ctx);
			assert.equal(widgets.has(SUBAGENT_WIDGET_KEY), false);
			let call = 0;
			const execute = (name: string, args: any, signal?: AbortSignal) => tools.get(name)!.execute(`${name}-${mode}-${++call}`, args, signal, undefined, ctx);
			const task = { agent: "worker", title: `Live panel ${mode}`, task: "Offline background fixture; no paid model calls." };
			let args: any = mode === "parallel" ? { tasks: [task, task] } : mode === "chain" ? { chain: [task, { ...task, task: "Continue: {previous}" }] } : task;
			if (mode === "resume") {
				const initial = await execute("subagent", task); assert.equal(initial.isError, undefined);
				args = { subagentSessionId: (initial.details as any).results[0].subagentSessionId, message: "Continue in background", title: `Live panel ${mode}` };
			}
			const turn = new AbortController();
			const accepted = await execute(mode === "resume" ? "subagent_message" : "subagent", mode === "resume" ? args : { ...args, background: true }, turn.signal);
			assert.equal(accepted.isError, undefined, JSON.stringify(accepted.content));
			assert.equal(widgets.has(SUBAGENT_WIDGET_KEY), false);
			const summary = statuses.get(SUBAGENT_WIDGET_KEY)!;
			assert.match(summary, /Subagents：[12]/); assert.doesNotMatch(summary, /Live panel/);
			await commands.get('background-jobs').handler('subagents', ctx);
			assert.equal(widgets.has(SUBAGENT_WIDGET_KEY), true);
			assert.match(panelHistory.join("\n"), new RegExp(`Live panel ${mode}`));
			const receipt = (accepted.details as any).background; assert.equal(receipt.status, "queued");
			assert.ok(receipt.tasks.every((task: any) => task.logPending && !task.liveLogPath && !task.finalLogPath && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(task.subagentSessionId)));
			for (const task of receipt.tasks) await stat(join(root, "managed", task.subagentSessionId, "manifest.json"));
			assert.equal(accepted.usage, undefined); turn.abort(); // accepted jobs no longer belong to this tool turn
			const result = await completion; await Promise.all(liveChecks);
			assert.equal(widgets.has(SUBAGENT_WIDGET_KEY), false); assert.equal(statuses.has(SUBAGENT_WIDGET_KEY), false); assert.match(panelHistory.join("\n"), /worker · running/);
			assert.ok(!("widgetTitles" in receipt)); assert.ok(receipt.tasks.every((task: any) => !("title" in task)));
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
			assert.ok(notifications.some(entry => entry.message.details.kind === "log_ready"), "log-ready events still reach the model without chat bubbles");
			const notice = notifications.find(entry => entry.message.details.kind === "task_result");
			assert.deepEqual(notice.options, { triggerTurn: true, deliverAs: "followUp" });
			const status = await execute("subagent_status", { jobId: receipt.jobId }); assert.equal(status.usage, undefined);
			assert.equal((status.details as any).status, "completed");
			const listed = await execute("subagent_status", {}); assert.equal(listed.isError, undefined);
			const listedJob = (listed.structuredContent as any).jobs.find((job: any) => job.jobId === receipt.jobId);
			assert.equal(listedJob.status, "completed"); assert.equal(listedJob.tasks[0].summary, "done");
			const denied = await tools.get("subagent_status")!.execute("wrong-owner", { jobId: receipt.jobId }, undefined, undefined,
				{ ...ctx, sessionManager: { getSessionId: () => "another-owner" } } as any);
			assert.equal(denied.isError, true);
		} finally { await handlers.get("session_shutdown")?.({}, ctx); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
		console.log(`[progress] Verified and cleaned background ${mode}`);
	});
}
