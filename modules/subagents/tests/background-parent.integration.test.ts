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
import { RpcPipe } from "../extensions/subagent/rpc.ts";
import { killProcessTree } from "../extensions/subagent/concurrency.ts";
const cli = process.env.PI_SUBAGENTS_TEST_CLI;
const launcher = fileURLToPath(new URL("./fixtures/background-child.mjs", import.meta.url));
const provider = fileURLToPath(new URL("./fixtures/rpc-provider.ts", import.meta.url));
const extension = fileURLToPath(new URL("./fixtures/background-parent.ts", import.meta.url));
const text = (message: any) => typeof message?.content === "string" ? message.content : message?.content?.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") ?? "";

test("real parent RPC host resumes automatically after background completion, after managed commit", { skip: !cli && "Set PI_SUBAGENTS_TEST_CLI", timeout: 60000 }, async t => {
	console.log("[progress] Verifying automatic real-parent followUp turn");
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-background-parent-"))); let proc: ReturnType<typeof spawn> | undefined; let pipe: RpcPipe | undefined;
	try {
		await mkdir(join(root, "config")); await writeFile(join(root, "config/settings.json"), JSON.stringify({ extensions: [extension, provider], defaultTools: ["subagent", "barrier"], compaction: { enabled: false }, cacheWarming: "off", defaultProjectTrust: "never" }));
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
		await pipe.request("get_state"); assert.equal((await pipe.request("prompt", { message: "Delegate the offline task in background." })).disposition, "started");
		await event(e => e.type === "message_end" && e.message.role === "assistant" && text(e.message) === "parent idle"); await event(e => e.type === "agent_settled");
		const readyFile = join(root, "barrier-ready.json"); await new Promise<void>((resolve, reject) => {
			const finish = (error?: Error) => { observer.close(); t.signal.removeEventListener("abort", abort); error ? reject(error) : resolve(); };
			const observer = watch(root, () => { void access(readyFile).then(() => finish(), () => {}); });
			const abort = () => finish(new Error("Test aborted")); observer.on("error", finish); t.signal.addEventListener("abort", abort, { once: true });
			void access(readyFile).then(() => finish(), () => {});
		});
		console.log("[progress] Parent reached idle before child completion; releasing child tool");
		await writeFile(join(root, "release"), "finish"); await event(e => e.type === "message_end" && e.message.role === "assistant" && text(e.message) === "parent automatic follow-up");
		const state = await pipe.request("get_entries");
		const notification = state.entries.find((entry: any) => entry.type === "custom_message" && entry.customType === "subagent_background" && text(entry).includes('"kind":"task_result"'));
		assert.ok(notification, "actual parent persisted completion custom message");
		const result = JSON.parse(text(notification)); assert.equal(result.status, "completed", JSON.stringify(result)); const session = result.tasks[0].subagentSessionId;
		assert.equal(JSON.parse(await readFile(join(root, "managed", session, "manifest.json"), "utf8")).state, "ready"); await assert.rejects(stat(join(root, "managed", session, "writer.lock")), { code: "ENOENT" });
		assert.equal(result.tasks[0].result.usage.totalTokens, 24);
		assert.equal(events.filter(e => e.type === "message_end" && e.message.role === "assistant" && text(e.message) === "parent automatic follow-up").length, 1);
		await pipe.end(); const [code] = await exit; assert.equal(code, 0, diagnostics); t.signal.removeEventListener("abort", killed);
	} finally { pipe?.dispose(); if (proc?.pid && proc.exitCode === null && proc.signalCode === null) killProcessTree(proc, "SIGKILL", { spawn }); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
	console.log("[progress] Verified actual parent automatic followUp and child commit ordering");
});
