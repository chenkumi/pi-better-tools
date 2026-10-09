import assert from "node:assert/strict";
import { ulid } from "ulid";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { invokeCli, isolatedEnv } from "./fixtures/pi-cli-harness.ts";
const cli = process.env.PI_SUBAGENTS_TEST_CLI;
const project = fileURLToPath(new URL("../", import.meta.url)), fixture = join(project, "tests/fixtures/pi-resume-provider.ts");
const evidenceRoot = resolve(process.env.PI_SUBAGENTS_TEST_EVIDENCE ?? join(project, "issues/IMPL-20260930-resumable-subagents/e2e"), `run-${Date.now()}-${process.pid}`);
const records = (s: string) => s.split("\n").filter(Boolean).map(line => JSON.parse(line));
const tools = (wire: string) => records(wire).filter(e => e.type === "message_end" && e.message?.role === "toolResult" && ["subagent", "subagent_message"].includes(e.message.toolName)).map(e => e.message);
const settings = (changed = false) => ({ packages: [project], extensions: [fixture], defaultProvider: "resume-offline", defaultModel: changed ? "alternate" : "selected", defaultThinkingLevel: changed ? "low" : "high", defaultTools: ["resume_nonce"], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off", defaultProjectTrust: "never" });
async function launch(root: string, session: string, phase: string, mode = "single", missing = false) {
	const task = join(root, `${phase}-task.txt`); await writeFile(task, phase === "first" ? "P6_PARENT_FIRST: dispatch initial work" : "P6_PARENT_DECISION: Use B");
	const args = ["--mode", phase === "first" ? "json" : "rpc", ...(phase === "first" ? ["-p"] : []), "--offline", "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "-e", project, "-e", fixture, "--model", "resume-offline/alternate", "--tools", "subagent,subagent_message", ...(phase === "first" ? ["--session-id", session] : ["--session", session]), ...(phase === "first" ? [`@${task}`] : [])];
	return invokeCli(resolve(cli!), args, root, { ...isolatedEnv(root), P6_PHASE: phase, P6_MODE: mode, P6_MISSING_MODEL: missing ? "1" : "0", P6_CHILD_ONLY_MISSING: mode === "child-missing-model" && phase !== "first" ? "1" : "0", P6_CHILD_CWD: mode === "child-trust" ? join(root, "child-cwd") : undefined }, join(root, "wire", phase), 64 * 1024 * 1024, phase === "first" ? undefined : await readFile(task, "utf8"));
}
for (const mode of ["single", "parallel", "chain", "missing-model", "child-missing-model", "child-trust"]) {
	test(`P6 real production resumable dispatch: ${mode}`, { skip: !cli && "Set PI_SUBAGENTS_TEST_CLI (skipped is not pass)", timeout: 240000 }, async () => {
		console.log(`[progress] Verifying production resumable contract: ${mode}`);
		const root = await realpath(await mkdtemp(join(tmpdir(), "pi-resume-e2e-"))), out = join(evidenceRoot, mode);
		await mkdir(out, { recursive: true });
		try {
			await mkdir(join(root, "config")); await writeFile(join(root, "config/settings.json"), JSON.stringify(settings())); await writeFile(join(root, "config/auth.json"), "{}");
			if (mode === "child-trust") {
				await mkdir(join(root, "child-cwd/.pi"), { recursive: true });
				await writeFile(join(root, "child-cwd/.pi/settings.json"), "{}");
				await writeFile(join(root, "config/trust.json"), JSON.stringify({ [await realpath(join(root, "child-cwd"))]: true }));
			}
			const first = await launch(root, ulid().toUpperCase(), "first", mode);
			assert.equal(first.code, 0, first.stderr); const firstTool = tools(first.stdout).at(-1); assert.ok(firstTool);
			const initial = firstTool.details.results; assert.equal(initial.length, ["parallel", "chain"].includes(mode) ? 2 : 1);
			assert.equal(new Set(initial.map((r: any) => r.subagentSessionId)).size, initial.length);
			for (const r of initial) { assert.equal(r.status, "completed", r.errorMessage); assert.equal(r.canResume, true, r.logError); assert.match(firstTool.content[0].text, new RegExp(r.subagentSessionId)); }
			if (["parallel", "chain"].includes(mode)) return;
			const r1 = initial[0], directory = join(root, "config/subagent-sessions", r1.subagentSessionId);
			const m1 = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
			const native1 = await readFile(join(directory, m1.nativeFile)), view1 = await readFile(r1.logPath);
			const parentStartup = JSON.parse(await readFile(join(root, "capture", (await readdir(join(root, "capture"))).find(n => n.startsWith("parent-"))!, "startup.json"), "utf8"));
			await writeFile(join(root, "config/settings.json"), JSON.stringify(settings(true)));
			if (mode === "child-trust") {
				assert.equal(m1.config.childTrusted, true);
				await writeFile(join(root, "config/trust.json"), JSON.stringify({ [await realpath(join(root, "child-cwd"))]: false }));
			}
			const second = await launch(root, parentStartup.file, "resume", mode, mode === "missing-model"); assert.equal(second.code, 0, second.stderr);
			assert.notEqual(first.pid, second.pid); const t2 = tools(second.stdout).at(-1); assert.ok(t2);
			const completion = records(second.stdout).find(e => e.type === "message_end" && e.message?.customType === "subagent_background" && e.message?.details?.kind === "task_result");
			const r2 = completion?.message.details.tasks[0].result;
			if (mode !== "missing-model") { assert.equal(t2.details.action, "resume"); assert.equal(t2.details.status, "accepted"); assert.equal(t2.details.subagentSessionId, r1.subagentSessionId); assert.ok(r2, "accepted resume must produce task_result followUp"); }
			if (mode === "missing-model") {
				assert.equal(t2.isError, true); assert.equal(t2.details.errorCode, "MODEL_UNAVAILABLE"); assert.ok(!r2?.canResume);
				assert.deepEqual(await readFile(join(directory, "manifest.json")), Buffer.from(JSON.stringify(m1, null, 2) + "\n"));
				assert.equal((await readdir(join(root, "capture"))).filter(n => n.startsWith("child-")).length, 1);
				return;
			}
			if (["child-missing-model", "child-trust"].includes(mode)) {
				assert.equal(completion.message.details.status, "failed"); assert.equal(r2.canResume, false);
				assert.equal(r2.errorCode, mode === "child-trust" ? "TRUST_REQUIRED" : "MODEL_UNAVAILABLE");
				assert.equal(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")).state, "blocked");
				assert.deepEqual(await readFile(r1.logPath), view1);
				const captureDir = join(mode === "child-trust" ? join(root, "child-cwd") : root, "capture");
				const children = (await readdir(captureDir)).filter(n => n.startsWith("child-"));
				assert.ok(children.length >= 1 && children.length <= 2); // guard may precede fixture session_start
				const runDirs = await readdir(join(directory, "runs")); assert.equal(runDirs.length, 2);
				const handshakes = await Promise.all(runDirs.map(async n => JSON.parse(await readFile(join(directory, "runs", n, "startup.json"), "utf8"))));
				assert.equal(handshakes.filter(h => h.errorCode === r2.errorCode).length, 1);
				const childFiles = await Promise.all(children.map(n => readdir(join(captureDir, n))));
				assert.equal(childFiles.filter(files => files.some(n => n.startsWith("request-"))).length, 1);
				await assert.rejects(stat(join(directory, "writer.lock")), { code: "ENOENT" });
				return;
			}
			assert.equal(r2.status, "completed", r2.errorMessage); assert.equal(r2.canResume, true); assert.equal(r2.subagentSessionId, r1.subagentSessionId); assert.equal(r2.logPath, r1.logPath); assert.equal(r2.output, "DECISION_B_COMPLETED");
			assert.equal(r1.usage.totalTokens, 36); assert.equal(r2.usage.totalTokens, 12); assert.equal(t2.usage, undefined, "background usage must not be counted in host totals"); assert.equal(r2.usage.contextTokens, 12);
			const m2 = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")); assert.equal(m2.config.model, "resume-offline/selected"); assert.equal(m2.config.thinkingLevel, "high"); assert.equal(m2.state, "ready");
			const native2 = await readFile(join(directory, m2.nativeFile)), view2 = await readFile(r2.logPath); assert.deepEqual(native2.subarray(0, native1.length), native1); assert.deepEqual(view2.subarray(0, view1.length), view1);
			const view = records(view2.toString()); assert.ok(view.every(r => ["user", "assistant", "tool_call", "tool_result"].includes(r.type))); assert.equal(view.filter(r => r.type === "user").length, 2); assert.equal(view.filter(r => r.type === "tool_call").length, 1); assert.equal(view.filter(r => r.type === "tool_result").length, 1);
			const call = view.find(r => r.type === "tool_call"), result = view.find(r => r.type === "tool_result"); assert.equal(result.callId, call.callId); assert.equal(call.arguments.usage, "business data"); assert.equal(call.arguments.model, "business model"); assert.equal(result.isError, false);
			assert.ok(!view2.toString().includes("private fixture reasoning") && !view2.toString().includes("opaque-signature") && !view2.toString().includes("aW1hZ2U=")); assert.ok(native2.toString().includes("opaque-signature") && native2.toString().includes("aW1hZ2U="));
			const effects = records(await readFile(join(root, "side-effects.jsonl"), "utf8")); assert.equal(effects.length, 1);
			const captures = await readdir(join(root, "capture")), children = captures.filter(n => n.startsWith("child-")); assert.equal(children.length, 2);
			const startups = await Promise.all(children.map(async n => JSON.parse(await readFile(join(root, "capture", n, "startup.json"), "utf8")))); assert.notEqual(startups[0].pid, startups[1].pid);
			for (const start of startups) { assert.ok(!start.argv.includes("--approve")); assert.equal(start.id, r1.subagentSessionId); assert.equal(start.model.id, "selected"); assert.equal(start.thinking, "high"); for (const key of ["active", "registered"]) assert.ok(!start[key].includes("subagent")); }
			const verified = await Promise.all(children.map(async n => readFile(join(root, "capture", n, "history-before-new-tool.json"), "utf8").then(JSON.parse).catch(() => null))); assert.equal(verified.filter(Boolean).length, 1); assert.equal(verified.find(Boolean).executions, 0); assert.equal(verified.find(Boolean).nonce, effects[0].nonce);
			assert.equal(records(second.stdout).filter(e => e.type === "message_end" && e.message?.role === "toolResult" && ["subagent", "subagent_message"].includes(e.message.toolName)).length, 1);
			await assert.rejects(stat(join(directory, "writer.lock")), { code: "ENOENT" });
			// A real third parent process must continue the same native child checkpoint,
			// even though the parent only knows the old creation receipt.
			const third = await launch(root, parentStartup.file, "third", mode);
			assert.equal(third.code, 0, third.stderr); assert.notEqual(third.pid, second.pid);
			const t3 = tools(third.stdout).at(-1);
			assert.equal(t3.details.action, "resume"); assert.equal(t3.details.status, "accepted");
			const done3 = records(third.stdout).find(e => e.type === "message_end" && e.message?.customType === "subagent_background" && e.message?.details?.kind === "task_result");
			const r3 = done3?.message.details.tasks[0].result;
			assert.equal(r3?.status, "completed", r3?.errorMessage); assert.equal(r3.canResume, true);
			assert.equal(r3.subagentSessionId, r1.subagentSessionId); assert.equal(r3.logPath, r1.logPath);
			assert.notEqual(t3.details.taskId, t2.details.taskId); assert.notEqual(t3.details.jobId, t2.details.jobId);
			const m3 = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
			const native3 = await readFile(join(directory, m3.nativeFile)), view3 = await readFile(r3.logPath);
			assert.deepEqual(native3.subarray(0, native2.length), native2); assert.deepEqual(view3.subarray(0, view2.length), view2);
			assert.equal(records(view3.toString()).filter(row => row.type === "user").length, 3);
			assert.equal(records(await readFile(join(root, "side-effects.jsonl"), "utf8")).length, 1);
			assert.equal((await readdir(join(root, "capture"))).filter(n => n.startsWith("child-")).length, 3);
			await assert.rejects(stat(join(directory, "writer.lock")), { code: "ENOENT" });
			await writeFile(join(out, "measurements.json"), JSON.stringify({ firstParentPid: first.pid, secondParentPid: second.pid, childPids: startups.map(s => s.pid), nativeBytes: [native1.length, native2.length], transcriptBytes: [view1.length, view2.length], tokens: [r1.usage.totalTokens, r2.usage.totalTokens], sideEffects: effects.length, id: r1.subagentSessionId }, null, 2));
		} finally { await cp(root, join(out, "sandbox"), { recursive: true }); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); console.log(`[progress] Evidence retained and isolated root cleaned: ${mode}`); }
	});
}
