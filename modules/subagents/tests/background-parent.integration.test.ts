import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once, EventEmitter } from "node:events";
import { watch } from "node:fs";
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { renderBackgroundResult } from "../extensions/subagent/background-renderer.ts";
import { RpcPipe } from "../extensions/subagent/rpc.ts";
import { killProcessTree } from "../extensions/subagent/concurrency.ts";
const cli = process.env.PI_SUBAGENTS_TEST_CLI;
const launcher = fileURLToPath(new URL("./fixtures/background-child.mjs", import.meta.url));
const provider = fileURLToPath(new URL("./fixtures/rpc-provider.ts", import.meta.url));
const extension = fileURLToPath(new URL("./fixtures/background-parent.ts", import.meta.url));
const text = (message: any) => typeof message?.content === "string" ? message.content : message?.content?.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") ?? "";

for (const mode of ["idle", "tool"] as const) test(`real parent RPC ${mode}: committed background result steers before the next answer`, { skip: !cli && "Set PI_SUBAGENTS_TEST_CLI", timeout: 60000 }, async t => {
	console.log(`[progress] Verifying real-parent steering delivery: ${mode}`);
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-background-parent-"))); let proc: ReturnType<typeof spawn> | undefined; let pipe: RpcPipe | undefined;
	try {
		await mkdir(join(root, "config")); await writeFile(join(root, "config/settings.json"), JSON.stringify({ extensions: [extension, provider], defaultTools: ["subagent", "barrier", ...(mode === "tool" ? ["parent_gate"] : [])], compaction: { enabled: false }, cacheWarming: "off", defaultProjectTrust: "never" }));
		const nativePath = join(root, "parent.jsonl");
		proc = spawn(process.execPath, [launcher, root, resolve(cli!), "--mode", "rpc", "--session", nativePath, "--model", "subagent-test/fixture", "--thinking", "off"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
		pipe = new RpcPipe(proc); const events: any[] = [], changed = new EventEmitter(); let buffer = "", diagnostics = ""; const decoder = new StringDecoder("utf8");
		const killed = () => { if (proc?.pid) killProcessTree(proc, "SIGKILL", { spawn }); };
		t.signal.addEventListener("abort", killed, { once: true });
		proc.stderr!.on("data", chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-8192); });
		proc.stdout!.on("data", chunk => { buffer += decoder.write(chunk); let index: number;
			while ((index = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line.trim()) continue;
				try { const event = JSON.parse(line); if (!pipe!.accept(event)) { events.push(event); changed.emit("event"); } } catch (error) { changed.emit("failure", error); }
			} });
		const exit = once(proc, "close"); proc.on("close", () => { pipe!.dispose(); changed.emit("closed"); });
		async function event(predicate: (event: any) => boolean) {
			for (;;) { const found = events.find(predicate); if (found) return found;
				if (proc!.exitCode !== null || proc!.signalCode !== null) throw new Error(`Parent exited before expected event: ${diagnostics}`);
				await new Promise<void>((resolve, reject) => {
					const cleanup = () => { changed.off("event", received); changed.off("closed", closed); changed.off("failure", failed); t.signal.removeEventListener("abort", aborted); };
					const received = () => { cleanup(); resolve(); }; const closed = () => { cleanup(); reject(new Error(`Parent closed: ${diagnostics}`)); }; const failed = (error: Error) => { cleanup(); reject(error); }; const aborted = () => failed(new Error("Test aborted"));
					changed.once("event", received); changed.once("closed", closed); changed.once("failure", failed); t.signal.addEventListener("abort", aborted, { once: true });
				});
			}
		}
		async function file(name: string) {
			const path = join(root, name);
			await new Promise<void>((resolve, reject) => {
				let finished = false;
				const finish = (error?: Error) => { if (finished) return; finished = true; observer.close(); t.signal.removeEventListener("abort", abort); error ? reject(error) : resolve(); };
				const observer = watch(root, () => { void access(path).then(() => finish(), () => {}); });
				const abort = () => finish(new Error("Test aborted")); observer.on("error", finish); t.signal.addEventListener("abort", abort, { once: true });
				void access(path).then(() => finish(), () => {});
			});
			return path;
		}
		await pipe.request("get_state"); assert.equal((await pipe.request("prompt", { message: "Delegate the offline task in background." })).disposition, "started");
		if (mode === "idle") { await event(e => e.type === "message_end" && e.message.role === "assistant" && text(e.message) === "parent idle"); await event(e => e.type === "agent_settled"); }
		else await file("parent-gate-ready");
		await file("barrier-ready.json");
		console.log(`[progress] Parent ${mode} before child completion; releasing child tool`);
		await writeFile(join(root, "release"), "finish");
		const submitted = JSON.parse(await readFile(await file("parent-result-submitted.json"), "utf8"));
		assert.deepEqual(submitted.options, { triggerTurn: true, deliverAs: "steer" });
		assert.equal(submitted.status, "completed");
		assert.equal(JSON.parse(await readFile(join(root, "managed", submitted.sessionId, "manifest.json"), "utf8")).state, "ready");
		await assert.rejects(stat(join(root, "managed", submitted.sessionId, "writer.lock")), { code: "ENOENT" });
		if (mode === "tool") {
			assert.equal((await pipe.request("get_state")).isStreaming, true);
			const pending = await pipe.request("get_entries");
			assert.equal(pending.entries.some((entry: any) => entry.type === "custom_message" && text(entry).includes('"kind":"task_result"')), false, "submitted result is queued, not inserted inside an unfinished tool batch");
			await writeFile(join(root, "parent-release"), "finish parent tool");
		}
		await event(e => e.type === "message_end" && e.message.role === "assistant" && text(e.message) === "parent automatic follow-up");
		const state = await pipe.request("get_entries");
		const notification = state.entries.find((entry: any) => entry.type === "custom_message" && entry.customType === "subagent_background" && text(entry).includes('"kind":"task_result"'));
		assert.ok(notification, "actual parent persisted completion custom message");
		const result = JSON.parse(text(notification)); assert.equal(result.status, "completed", JSON.stringify(result)); const session = result.tasks[0].subagentSessionId;
		assert.equal(JSON.parse(await readFile(join(root, "managed", session, "manifest.json"), "utf8")).state, "ready"); await assert.rejects(stat(join(root, "managed", session, "writer.lock")), { code: "ENOENT" });
		assert.equal(result.tasks[0].result.usage.totalTokens, 24);
		assert.equal(result.tasks[0].result.output, "main complete", "model notification keeps final summary after >8KiB progress");
		assert.match(notification.details.tasks[0].result.output, /^Early progress/);
		assert.equal(notification.details.tasks[0].result.outputTruncated, true);
		assert.ok(Buffer.byteLength(notification.details.tasks[0].result.output) <= 8192);
		const collapsed = renderBackgroundResult({ content: [{ type: "text", text: text(notification) }], details: notification.details } as any, { expanded: false, isPartial: false }, { fg: (_color: string, text: string) => text } as any, {} as any).render(200).join("\n");
		assert.match(collapsed, /main complete/); assert.doesNotMatch(collapsed, /Early progress/);
		assert.equal(events.filter(e => e.type === "message_end" && e.message.role === "assistant" && text(e.message) === "parent automatic follow-up").length, 1);
		if (mode === "tool") {
			assert.equal(events.some(e => e.type === "message_end" && e.message.role === "assistant" && text(e.message) === "parent idle"), false, "steering avoids the result-blind final answer");
			const noticeIndex = state.entries.indexOf(notification);
			const toolIndex = state.entries.findIndex((entry: any) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "parent_gate");
			const answerIndex = state.entries.findIndex((entry: any) => entry.type === "message" && entry.message.role === "assistant" && text(entry.message) === "parent automatic follow-up");
			assert.ok(toolIndex >= 0 && toolIndex < noticeIndex && noticeIndex < answerIndex, "tool result → completion → next assistant answer");
		}
		await pipe.end(); const [code] = await exit; assert.equal(code, 0, diagnostics); t.signal.removeEventListener("abort", killed);
	} finally { pipe?.dispose(); if (proc?.pid && proc.exitCode === null && proc.signalCode === null) killProcessTree(proc, "SIGKILL", { spawn }); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
	console.log(`[progress] Verified actual parent ${mode} steering and child commit ordering`);
});
