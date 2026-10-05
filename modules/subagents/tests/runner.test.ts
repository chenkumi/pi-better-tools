import assert from "node:assert/strict";
import * as fs from "node:fs";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { beforeEach } from "node:test";
import { emitManagedHeader, fixtureAgentPath, installManagedBoundary, managedRunMetadata } from "./fixtures/managed-boundary.ts";
beforeEach(installManagedBoundary);
import registerSubagent, { expandChainTask, runSingleAgent, SUBAGENT_INACTIVITY_TIMEOUT_MS, type RunnerRuntime } from "../extensions/subagent/index.ts";
import { SubsessionWriter, callAlias } from "../extensions/subagent/subsession-log.ts";
import { getSubagentDebugLogDir, writeSubagentDebugFailure } from "../extensions/subagent/debug-log.ts";

const realCreateLog = SubsessionWriter.create.bind(SubsessionWriter);
const fixture = fileURLToPath(new URL("./fixtures/child.mjs", import.meta.url));

async function run(scenario: string, task = "test", controller?: AbortController, onUpdate?: (partial: any) => void, inactivityTimeoutMs?: number, debugLog = false, extraRuntime: Partial<RunnerRuntime> = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-runner-test-"));
	let taskPath: string | undefined;
	let promptPath: string | undefined;
	try {
		const result = await runSingleAgent(
			root,
			{ modelWasExplicit: false, thinkingLevelWasExplicit: false },
			[{ name: "worker", description: "test", source: "bundled", filePath: fixtureAgentPath, systemPrompt: "test system prompt" }],
			"worker", task, undefined, undefined, controller?.signal,
			onUpdate ?? (controller ? () => controller.abort() : undefined),
			(results, progress) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results, ...(progress ? { progress } : {}) }),
			"test-session", "test-call",
			{
				sessionRootDir: join(root, "managed"),
				debugLog,
				debugLogDir: join(root, "debug-logs"),
				inactivityTimeoutMs,
				...extraRuntime,
				invocation(args) {
					assert.equal(args[args.indexOf("--exclude-tools") + 1], "subagent,subagent_status,subagent_cancel,subagent_message");
					assert.ok(args.join(" ").length < 4000);
					taskPath = args.at(-1)!.slice(1);
					promptPath = args[args.indexOf("--append-system-prompt") + 1];
					if (scenario === "spawn-failure") return { command: join(root, "nonexistent-executable"), args };
					if (scenario === "invocation-failure") throw new Error("injected invocation failure");
					return { command: process.execPath, args: [fixture, scenario, ...args] };
				},
			},
		);
		if (taskPath) {
			await assert.rejects(stat(taskPath), { code: "ENOENT" });
			await assert.rejects(stat(promptPath!), { code: "ENOENT" });
			await assert.rejects(stat(dirname(taskPath)), { code: "ENOENT" });
		}
		const log = result.logPath ? (await readFile(result.logPath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
		assert.ok(log.every(record => ["user", "assistant", "tool_call", "tool_result"].includes(record.type)));
		const metadata = await managedRunMetadata(root, result);
		if (result.logPath) assert.equal(metadata.status, result.status);
		const debugFiles = debugLog && !extraRuntime.debugLogWriter ? await readdir(join(root, "debug-logs")) : [];
		const debugRecords = await Promise.all(debugFiles.map(async (file) => JSON.parse(await readFile(join(root, "debug-logs", file), "utf8"))));
		return { result, log, metadata, spawned: Boolean(taskPath), debugRecords };
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("chain substitutions retain all dollar replacement sequences literally", () => {
	const previous = "$& $$ $` $' {previous} 中文🙂";
	assert.equal(expandChainTask("before {previous} middle {previous} after", previous),
		"before $& $$ $` $' {previous} 中文🙂 middle $& $$ $` $' {previous} 中文🙂 after");
});

for (const scenario of ["empty", "header", "toolUse"]) {
	test(`zero exit with ${scenario} but no terminal assistant fails closed`, async () => {
		const { result } = await run(scenario);
		assert.equal(result.exitCode, 0);
		assert.equal(result.status, "failed");
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage!, /without a terminal assistant/);
	});
}

test("debugLog writes failed task input, final response and sub-session path", async () => {
	const { result, debugRecords } = await run("invocation-failure", "investigate this failure", undefined, undefined, undefined, true);
	assert.equal(result.status, "failed");
	assert.equal(debugRecords.length, 1);
	assert.equal(debugRecords[0].input.agent, "worker");
	assert.equal(debugRecords[0].input.task, "investigate this failure");
	assert.equal(debugRecords[0].input.systemPrompt, "test system prompt");
	assert.equal(debugRecords[0].finalResponse, "");
	assert.equal(debugRecords[0].subsessionLogPath, result.logPath);
	assert.match(debugRecords[0].debugLogPath, /debug-logs/);
});

test("tool execution reads canonical settings on each call and logs failures only", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-debug-settings-dispatch-"));
	const agentDir = join(root, "agent");
	const logsDir = getSubagentDebugLogDir(root);
	let succeed = false;
	try {
		await fs.promises.mkdir(agentDir);
		let tool: ToolDefinition | undefined;
		registerSubagent({ registerTool(definition) { tool = definition; }, on() {} } as ExtensionAPI, {
			settingsAgentDir: agentDir, sessionRootDir: join(root, "managed"), debugLogDir: logsDir,
			invocation(args) {
				if (!succeed) throw new Error("injected settings dispatch failure");
				return { command: process.execPath, args: [fixture, "normal", ...args] };
			},
		});
		const ctx = { cwd: root, hasUI: false, isProjectTrusted: () => true,
			sessionManager: { getSessionId: () => "settings-test-session" } } as unknown as ExtensionContext;
		const execute = (id: string) => tool!.execute(id, { agent: "worker", task: "investigate configured failure" }, undefined, undefined, ctx);
		const missing = await execute("settings-missing");
		assert.equal(missing.isError, true);
		await assert.rejects(stat(logsDir), { code: "ENOENT" });

		await fs.promises.writeFile(join(agentDir, "settings.json"), JSON.stringify({ "pi-subagents": { debugLog: true } }));
		const enabled = await execute("settings-enabled");
		assert.equal(enabled.isError, true);
		const files = await readdir(logsDir);
		assert.equal(files.length, 1);
		const record = JSON.parse(await readFile(join(logsDir, files[0]), "utf8"));
		assert.equal(record.taskId, enabled.details.results[0].taskId);
		assert.equal(record.input.task, "investigate configured failure");
		assert.equal(record.status, "failed");
		assert.match(record.errorMessage, /injected settings dispatch failure/);
		assert.equal(record.subsessionLogPath, enabled.details.results[0].logPath);
		assert.equal(record.debugLogPath, join(logsDir, files[0]));

		succeed = true;
		const success = await execute("settings-success");
		assert.equal(success.details.results[0].status, "completed");
		assert.equal(success.isError, undefined);
		assert.deepEqual(await readdir(logsDir), files);
		const controller = new AbortController();
		controller.abort();
		const canceled = await tool!.execute("settings-canceled", { agent: "worker", task: "cancel" }, controller.signal, undefined, ctx);
		assert.equal(canceled.details.results[0].status, "aborted");
		assert.deepEqual(await readdir(logsDir), files);
		succeed = false;
		for (const [index, settings] of [
			JSON.stringify({ "pi-subagents": { debugLog: false } }),
			JSON.stringify({ "pi-subagents": { debugLog: "true" } }),
			JSON.stringify({ piSubagents: { debugLog: true } }),
			"{",
		].entries()) {
			await fs.promises.writeFile(join(agentDir, "settings.json"), settings);
			const disabled = await execute(`settings-disabled-${index}`);
			assert.equal(disabled.details.results[0].status, "failed");
			assert.deepEqual(await readdir(logsDir), files);
		}
	} finally { await rm(root, { recursive: true, force: true }); }
});

for (const mode of ["parallel", "chain"] as const) {
	test(`configured debugLog persists each failed ${mode} task`, async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-debug-settings-modes-"));
		try {
			const agentDir = join(root, "agent"), logsDir = getSubagentDebugLogDir(root);
			await fs.promises.mkdir(agentDir);
			await fs.promises.writeFile(join(agentDir, "settings.json"), JSON.stringify({ "pi-subagents": { debugLog: true } }));
			let tool: ToolDefinition | undefined;
			registerSubagent({ registerTool(definition) { tool = definition; }, on() {} } as ExtensionAPI, {
				settingsAgentDir: agentDir, sessionRootDir: join(root, "managed"), debugLogDir: logsDir,
				invocation() { throw new Error("injected mode dispatch failure"); },
			});
			const items = [{ agent: "worker", task: "first" }, { agent: "worker", task: "second" }];
			const result = await tool!.execute(`settings-${mode}`, mode === "parallel" ? { tasks: items } : { chain: items }, undefined, undefined,
				{ cwd: root, hasUI: false, isProjectTrusted: () => true,
					sessionManager: { getSessionId: () => "settings-mode-session" } } as unknown as ExtensionContext);
			assert.equal(result.isError, true);
			assert.equal(result.details.results.length, mode === "parallel" ? 2 : 1);
			const records = await Promise.all((await readdir(logsDir)).map(async (file) => JSON.parse(await readFile(join(logsDir, file), "utf8"))));
			assert.deepEqual(records.map((record) => record.taskId).sort(), result.details.results.map((entry: any) => entry.taskId).sort());
			assert.ok(records.every((record) => record.status === "failed" && /injected mode dispatch failure/.test(record.errorMessage)));
		} finally { await rm(root, { recursive: true, force: true }); }
	});
}

test("debug log directory failure preserves the original dispatch failure", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-debug-unwritable-"));
	try {
		const blocked = join(root, "not-a-directory");
		await fs.promises.writeFile(blocked, "block log creation");
		const { result } = await run("invocation-failure", "test", undefined, undefined, undefined, true, { debugLogDir: blocked,
			debugLogWriter: writeSubagentDebugFailure });
		assert.equal(result.status, "failed");
		assert.match(result.errorMessage!, /injected invocation failure/);
		assert.equal(await readFile(blocked, "utf8"), "block log creation");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("stalled debugLog write is bounded and does not change the failed result", async () => {
	let started = false;
	const { result } = await run("invocation-failure", "test", undefined, undefined, undefined, true, {
		ioTimeoutMs: 1000,
		debugLogWriter: () => { started = true; return new Promise<never>(() => {}); },
	});
	assert.ok(started);
	assert.equal(result.status, "failed");
	assert.match(result.errorMessage!, /injected invocation failure/);
	assert.equal(result.logError, undefined);
});

test("abort stops waiting for a stalled debugLog write", async () => {
	const controller = new AbortController();
	const { result } = await run("invocation-failure", "test", controller, () => {}, undefined, true, {
		ioTimeoutMs: 60_000,
		debugLogWriter: () => { setImmediate(() => controller.abort()); return new Promise<never>(() => {}); },
	});
	assert.equal(result.status, "failed");
	assert.match(result.errorMessage!, /injected invocation failure/);
});

for (const scenario of ["malformed", "missing-content", "invalid-content", "oversized", "spawn-failure", "invocation-failure"]) {
	test(`${scenario} fails and cleans temporary prompt files`, async () => {
		const { result } = await run(scenario);
		assert.equal(result.status, "failed");
		assert.ok(result.errorMessage);
		if (scenario === "oversized") assert.match(result.errorMessage!, /safety limit/);
		if (scenario === "malformed") assert.match(result.errorMessage!, /stdout processing failed/);
	});
}

test("captured assistant content remains memory bounded and oversized output is truncated, not failed", async () => {
	const { result } = await run("large-retained-output");
	assert.equal(result.status, "completed");
	assert.equal(result.exitCode, 0);
	assert.match(result.output, /\[Output truncated/);
	assert.ok(Buffer.byteLength(result.output, "utf8") <= 2 * 1024 * 1024);
});

test("normal terminal assistant at EOF completes", async () => {
	const { result } = await run("normal");
	assert.equal(result.status, "completed");
	assert.equal(result.output, "done");
});

for (const reason of ["error", "aborted"]) {
	test(`terminal ${reason} reason is preserved on exit zero`, async () => {
		const { result } = await run(reason);
		assert.equal(result.exitCode, 0);
		assert.equal(result.stopReason, reason);
		assert.equal(result.status, reason === "error" ? "failed" : "aborted");
	});
}

test("production inactivity timeout is 300 seconds", () => {
	assert.equal(SUBAGENT_INACTIVITY_TIMEOUT_MS, 300_000);
});

test("silent child fails after the output-inactivity deadline", async () => {
	const { result } = await run("silent", "test", undefined, undefined, 250);
	assert.equal(result.status, "failed");
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage!, /no stdout or stderr for 250 ms/);
});

for (const scenario of ["stdout-heartbeat", "stderr-heartbeat"]) {
	test(`${scenario} refreshes the inactivity deadline`, async () => {
		const { result, log, metadata } = await run(scenario, "test", undefined, undefined, 250);
		assert.equal(result.status, "completed");
		assert.equal(result.output, "done");
		if (scenario === "stderr-heartbeat") {
			assert.ok(metadata.stderr.includes("heartbeat"));
		}
	});
}

test("inactivity timeout is measured from the last output byte", async () => {
	const started = Date.now();
	const { result } = await run("heartbeat-stop", "test", undefined, undefined, 250);
	assert.equal(result.status, "failed");
	assert.match(result.errorMessage!, /no stdout or stderr for 250 ms/);
	assert.ok(Date.now() - started >= 400);
});

test("a child that lingers after agent_settled is terminated after a short grace and the completed result is kept", { timeout: 20000 }, async () => {
	const { result } = await run("terminal-hang", "test", undefined, undefined, 60_000, false, { settledExitGraceMs: 150, forceKillDelayMs: 2000 });
	assert.equal(result.output, "done");
	assert.equal(result.status, "completed");
	assert.equal(result.exitCode, 0);
	assert.equal(result.errorMessage, undefined);
});

test("parent abort wins when it precedes inactivity timeout", async () => {
	const controller = new AbortController();
	const abortTimer = setTimeout(() => controller.abort(), 50);
	try {
		const { result } = await run("silent", "test", controller, () => {}, 500);
		assert.equal(result.status, "aborted");
		assert.equal(result.stopReason, "aborted");
		assert.doesNotMatch(result.errorMessage ?? "", /no stdout or stderr/);
	} finally {
		clearTimeout(abortTimer);
	}
});

test("timeout wins over a later abort while termination is pending", { timeout: 10000 }, async (t) => {
	const controller = new AbortController();
	const signals: string[] = [];
	t.mock.method(childProcess, "spawn", () => {
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const proc = Object.assign(new EventEmitter(), {
			stdout, stderr, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
			kill(signal: NodeJS.Signals) {
				signals.push(signal);
				// Coordinate with the actual timeout phase, not wall time measured
				// before async log initialization / child startup has completed.
				if (signal === "SIGTERM") controller.abort();
				if (signal === "SIGKILL") {
					proc.signalCode = signal;
					stdout.end(); stderr.end();
					setImmediate(() => proc.emit("close", null, signal));
				}
				return true;
			},
		});
		return proc;
	});
	syncBuiltinESMExports();
	try {
		const { result } = await run("cancel", "test", controller, () => {}, 250, false, { forceKillDelayMs: 20 });
		assert.equal(controller.signal.aborted, true);
		assert.equal(result.status, "failed");
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage!, /no stdout or stderr for 250 ms/);
		assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	}
});

test("timed-out SIGTERM-resistant child escalates to SIGKILL", { timeout: 5000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-timeout-kill-test-"));
	const signals: string[] = [];
	t.mock.method(childProcess, "spawn", () => {
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const proc = Object.assign(new EventEmitter(), {
			stdout,
			stderr,
			exitCode: null as number | null,
			signalCode: null as NodeJS.Signals | null,
			kill(signal: NodeJS.Signals) {
				signals.push(signal);
				if (signal === "SIGKILL") {
					proc.signalCode = "SIGKILL";
					stdout.end();
					stderr.end();
					setImmediate(() => proc.emit("close", null, "SIGKILL"));
				}
				return true;
			},
		});
		return proc;
	});
	syncBuiltinESMExports();
	try {
		const result = await runSingleAgent(
			root,
			{ modelWasExplicit: false, thinkingLevelWasExplicit: false },
			[{ name: "worker", description: "test", source: "bundled", filePath: fixtureAgentPath, systemPrompt: "test" }],
			"worker", "test", undefined, undefined, undefined, undefined,
			(results, progress) => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results, ...(progress ? { progress } : {}) }),
			"test-session", "test-call",
			{ sessionRootDir: join(root, "managed"), invocation: () => ({ command: "mock", args: [] }), inactivityTimeoutMs: 20, forceKillDelayMs: 20 },
		);
		assert.equal(result.status, "failed");
		assert.match(result.errorMessage!, /no stdout or stderr for 20 ms/);
		assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		await rm(root, { recursive: true, force: true });
	}
});

test("parallel timeout is isolated and chain timeout stops later steps", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-timeout-modes-test-"));
	let spawnCount = 0;
	t.mock.method(childProcess, "spawn", (_command, args: readonly string[]) => {
		spawnCount++;
		const taskPath = args.find((arg) => arg.startsWith("@"))!.slice(1);
		const shouldTimeout = fs.readFileSync(taskPath, "utf8").includes("timeout");
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const proc = Object.assign(new EventEmitter(), {
			stdout,
			stderr,
			exitCode: null as number | null,
			signalCode: null as NodeJS.Signals | null,
			kill(signal: NodeJS.Signals) {
				proc.signalCode = signal;
				stdout.end();
				stderr.end();
				setImmediate(() => proc.emit("close", null, signal));
				return true;
			},
		});
		if (!shouldTimeout) {
			setImmediate(() => {
				emitManagedHeader(stdout, args, root);
				stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } })}\n`);
				stdout.end();
				stderr.end();
				proc.exitCode = 0;
				proc.emit("close", 0, null);
			});
		}
		return proc;
	});
	t.mock.method(SubsessionWriter, "create", (options: any) => realCreateLog({ ...options, rootDir: root }));
	syncBuiltinESMExports();
	try {
		let tool: ToolDefinition | undefined;
		registerSubagent({ registerTool(definition) { tool = definition; }, on() {} } as ExtensionAPI, { debugLog: false, sessionRootDir: join(root, "managed"), inactivityTimeoutMs: 30, forceKillDelayMs: 20 });
		const ctx = {
			cwd: root,
			hasUI: false,
			isProjectTrusted: () => true,
			sessionManager: { getSessionId: () => "test-session" },
		} as unknown as ExtensionContext;

		const parallel = await tool!.execute("parallel-timeout", { tasks: [
			{ agent: "worker", task: "normal task" },
			{ agent: "worker", task: "timeout task" },
		] }, undefined, undefined, ctx);
		assert.deepEqual(parallel.details.results.map((result: any) => result.status), ["completed", "failed"]);
		assert.equal(parallel.details.progress, undefined);
		assert.equal(spawnCount, 2);

		const chain = await tool!.execute("chain-timeout", { chain: [
			{ agent: "worker", task: "timeout first step" },
			{ agent: "worker", task: "must not run" },
		] }, undefined, undefined, ctx);
		assert.equal(chain.details.results.length, 1);
		assert.equal(chain.details.results[0].status, "failed");
		assert.equal(chain.details.progress, undefined);
		assert.equal(spawnCount, 3);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		await rm(root, { recursive: true, force: true });
	}
});

test("UTF-8 split across pipe writes survives in assistant output and stderr log", async () => {
	const { result, log, metadata } = await run("unicode");
	assert.equal(result.status, "completed");
	assert.equal(result.output, "中文🙂𠮷");
	assert.equal(metadata.stderr, "診斷🙂");
});

test("streaming child events are surfaced through live progress updates", async () => {
	const updates: any[] = [];
	const { result, log, metadata } = await run("stream", "test", undefined, (partial) => updates.push(partial));
	assert.equal(result.status, "completed");
	assert.equal(result.output, "working\n\ndone");
	const progress = updates.flatMap((update) => update.details?.progress ?? []);
	const entries = progress.flatMap((entry) => entry.entries ?? []);
	assert.ok(entries.some((entry: any) => entry.kind === "thinking" && entry.text.includes("considering")));
	assert.ok(entries.some((entry: any) => entry.kind === "text" && entry.text.includes("working")));
	assert.ok(entries.some((entry: any) => entry.kind === "tool" && entry.name === "search" && entry.status === "request"));
	assert.ok(entries.some((entry: any) => entry.kind === "tool" && entry.name === "read" && entry.status === "completed"));
	assert.ok(entries.some((entry: any) => entry.kind === "tool" && entry.name === "search" && entry.status === "completed"));
	assert.equal(JSON.stringify(entries).includes("searching"), false);
	assert.equal(JSON.stringify(entries).includes("still searching"), false);
	assert.equal(JSON.stringify(entries).includes("found"), false);
	const toolResults = log.filter((record) => record.type === "tool_result");
	assert.equal(toolResults.length, 2);
	assert.deepEqual(toolResults.map((record) => record.callId).sort(), [callAlias(result.taskId, "call-1"), callAlias(result.taskId, "call-2")].sort());
	assert.ok(toolResults.every((record) => record.content === "found"));
	const loggedTranscript = JSON.stringify(log);
	assert.equal(loggedTranscript.includes("provisional read"), false);
	assert.equal(loggedTranscript.includes("considering"), false);
});

test("tool execution fallback is logged once when no canonical tool result arrives", async () => {
	const { result, log, metadata } = await run("tool-fallback");
	assert.equal(result.status, "completed");
	const toolResults = log.filter((record) => record.type === "tool_result");
	assert.equal(toolResults.length, 1);
	assert.equal(toolResults[0].callId, callAlias(result.taskId, "fallback-call"));
	assert.equal(toolResults[0].content, "fallback result");
});

test("single, parallel, and chain aggregate live progress without leaking it into final details", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-progress-modes-test-"));
	let spawnIndex = 0;
	const spawnMock = t.mock.method(childProcess, "spawn", (_command, args: readonly string[]) => {
		const index = ++spawnIndex;
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const proc = Object.assign(new EventEmitter(), {
			stdout,
			stderr,
			exitCode: null as number | null,
			signalCode: null as NodeJS.Signals | null,
			kill() { return true; },
		});
		const emit = (event: unknown) => stdout.write(`${JSON.stringify(event)}\n`);
		setImmediate(() => {
			emitManagedHeader(stdout, args, root);
			emit({ type: "message_start", message: { role: "assistant", content: [] } });
			emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `working-${index}` } });
			emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: `call-${index}`, toolName: `tool-${index}` } });
			emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: { id: `call-${index}`, name: `tool-${index}`, arguments: { index } } } });
			emit({ type: "message_end", message: { role: "assistant", content: [
				{ type: "text", text: `working-${index}` },
				{ type: "toolCall", id: `call-${index}`, name: `tool-${index}`, arguments: { index } },
			], stopReason: "toolUse" } });
			emit({ type: "tool_execution_start", toolCallId: `call-${index}`, toolName: `tool-${index}`, args: { index } });
			emit({ type: "tool_execution_update", toolCallId: `call-${index}`, toolName: `tool-${index}`, partialResult: `running-${index}` });
			setTimeout(() => {
				emit({ type: "tool_execution_end", toolCallId: `call-${index}`, toolName: `tool-${index}`, isError: false, result: `done-${index}` });
				emit({ type: "message_start", message: { role: "assistant", content: [] } });
				emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `final-${index}` } });
				emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `final-${index}` }], stopReason: "stop" } });
				stdout.end();
				stderr.end();
				proc.exitCode = 0;
				proc.emit("close", 0, null);
			}, 20);
		});
		return proc;
	});
	t.mock.method(SubsessionWriter, "create", (options: any) => realCreateLog({ ...options, rootDir: root }));
	syncBuiltinESMExports();
	try {
		let tool: ToolDefinition | undefined;
		registerSubagent({ registerTool(definition) { tool = definition; }, on() {} } as ExtensionAPI, { debugLog: false, sessionRootDir: join(root, "managed") });
		const ctx = {
			cwd: root,
			hasUI: false,
			isProjectTrusted: () => true,
			sessionManager: { getSessionId: () => "test-session" },
		} as unknown as ExtensionContext;

		const singleUpdates: any[] = [];
		const single = await tool!.execute("single-call", { agent: "worker", task: "single" }, undefined, (update) => singleUpdates.push(update), ctx);
		assert.ok(singleUpdates.some((update) => update.details.progress?.[0]?.entries?.some((entry: any) => entry.kind === "tool" && entry.status === "request")));
		assert.equal(single.details.progress, undefined);

		const parallelUpdates: any[] = [];
		const parallel = await tool!.execute("parallel-call", { tasks: [
			{ agent: "worker", task: "parallel-a" },
			{ agent: "worker", task: "parallel-b" },
		] }, undefined, (update) => parallelUpdates.push(update), ctx);
		const overlapping = parallelUpdates.find((update) => update.details.progress?.length === 2);
		assert.ok(overlapping);
		assert.equal(new Set(overlapping.details.progress.map((progress: any) => progress.taskId)).size, 2);
		assert.equal(parallel.details.progress, undefined);
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		};
		const synthetic = {
			...overlapping,
			details: {
				...overlapping.details,
				progress: overlapping.details.progress.map((progress: any, index: number) => ({
					...progress,
					entries: index === 0 ? [
						{ key: "tool:request", kind: "tool", status: "request", name: "very-long-tool", arguments: '{"query":"abcdefghijklmnopqrstuvwxyz"}' },
						{ key: "tool:done", kind: "tool", status: "completed", name: "read", arguments: '{"path":"README.md"}' },
						{ key: "tool:bad", kind: "tool", status: "failed", name: "powershell", arguments: '{"command":"exit 1"}' },
					] : [],
				})),
			},
		};
		const progressLines = (expanded: boolean) => (tool as any)
			.renderResult(synthetic, { expanded, isPartial: true }, theme, {})
			.render(42)
			.map((line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd())
			.filter((line: string) => /^\[(request|completed|failed)\]/.test(line));
		for (const expanded of [false, true]) {
			const lines = progressLines(expanded);
			assert.equal(lines.length, 3);
			assert.match(lines[0], /^\[request\] very-long-tool\(.*…\)$/);
			assert.equal(lines[1], '[completed] read({"path":"README.md"})');
			assert.equal(lines[2], '[failed] powershell({"command":"exit 1"})');
			assert.ok(lines.every((line: string) => visibleWidth(line) <= 42));
			assert.equal(lines.join("\n").includes("running-"), false);
			assert.equal(lines.join("\n").includes("done-"), false);
		}

		const longDiagnostic = "🙂".repeat(3000);
		const failureRender = (tool as any).renderResult({
			content: [{ type: "text", text: "" }],
			details: {
				mode: "single",
				agentScope: "user",
				projectAgentsDir: null,
				results: [{
					taskId: "failed-task",
					agent: "worker",
					agentSource: "bundled",
					task: "fail",
					status: "failed",
					exitCode: 1,
					output: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, contextTokens: 0, turns: 0 },
					errorMessage: longDiagnostic,
				}],
			},
		}, { expanded: true, isPartial: false }, theme, {}).render(20000);
		const errorIndex = failureRender.findIndex((line: string) => line.startsWith("Error: "));
		assert.ok(errorIndex >= 0);
		const renderedDiagnostic = failureRender
			.slice(errorIndex, errorIndex + 2)
			.map((line: string) => line.trimEnd())
			.join("\n")
			.slice("Error: ".length);
		assert.ok(Buffer.byteLength(renderedDiagnostic, "utf8") <= 8 * 1024);
		assert.match(renderedDiagnostic, /Diagnostic truncated for display/);

		const chainUpdates: any[] = [];
		const chain = await tool!.execute("chain-call", { chain: [
			{ agent: "worker", task: "chain-a" },
			{ agent: "worker", task: "chain-b {previous}" },
		] }, undefined, (update) => chainUpdates.push(update), ctx);
		assert.ok(chainUpdates.some((update) => update.details.results.length === 2 && update.details.progress?.[0]?.step === 2));
		assert.equal(chain.details.progress, undefined);
		assert.equal(spawnMock.mock.callCount(), 5);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		await rm(root, { recursive: true, force: true });
	}
});

test("UTF-8 decoding preserves code points with deterministic one-byte stream chunks", async (t) => {
	const spawnMock = t.mock.method(childProcess, "spawn", (_command, args: readonly string[], options: any) => {
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const proc = Object.assign(new EventEmitter(), { stdout, stderr, exitCode: null, signalCode: null });
		// Run after the runner installs its decoders/listeners; each write is delivered
		// synchronously to a flowing stream, so OS pipe coalescing cannot hide splits.
		setImmediate(() => {
			emitManagedHeader(stdout, args, options.cwd);
			const event = JSON.stringify({ type: "message_end", message: {
				role: "assistant", content: [{ type: "text", text: "中文🙂𠮷" }], stopReason: "stop",
			} });
			for (const byte of Buffer.from(event)) stdout.write(Buffer.from([byte]));
			for (const byte of Buffer.from("診斷🙂")) stderr.write(Buffer.from([byte]));
			stdout.end();
			stderr.end();
			proc.emit("close", 0, null);
		});
		return proc;
	});
	syncBuiltinESMExports();
	try {
		const { result, log, metadata } = await run("normal");
		assert.equal(spawnMock.mock.callCount(), 1);
		assert.equal(result.status, "completed");
		assert.equal(result.output, "中文🙂𠮷");
		assert.equal(metadata.stderr, "診斷🙂");
	} finally {
		spawnMock.mock.restore();
		syncBuiltinESMExports();
	}
});

for (const mixedModes of [false, true]) {
	test(`oversized project dispatch ${mixedModes ? "preserves mode validation" : "is rejected before confirmation or task resources"}`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "pi-dispatch-test-"));
		try {
			const agentsDir = join(root, CONFIG_DIR_NAME, "agents");
			await fs.promises.mkdir(agentsDir, { recursive: true });
			await fs.promises.writeFile(join(agentsDir, "local.md"), "---\nname: local\ndescription: test\n---\nTest agent");
			let tool: ToolDefinition | undefined;
			registerSubagent({ registerTool(definition) { tool = definition; }, on() {} } as ExtensionAPI, { debugLog: false, sessionRootDir: join(root, "managed") });
			const confirm = t.mock.fn(async () => false);
			const createLog = t.mock.method(SubsessionWriter, "create", async () => { throw new Error("unexpected log creation"); });
			const createTemp = t.mock.method(fs.promises, "mkdtemp", async () => { throw new Error("unexpected runner temp directory"); });
			const spawnMock = t.mock.method(childProcess, "spawn", () => { throw new Error("unexpected child spawn"); });
			syncBuiltinESMExports();
			try {
				const result = await tool!.execute("oversized", {
					agentScope: "project", tasks: Array.from({ length: 33 }, () => ({ agent: "local", task: "test" })),
					...(mixedModes ? { agent: "local", task: "test" } : {}),
				}, undefined, undefined, {
					cwd: root, hasUI: true, isProjectTrusted: () => false, ui: { confirm },
					sessionManager: { getSessionId: () => "test-session" },
				} as unknown as ExtensionContext);
				assert.match(result.content[0].text, mixedModes ? /Provide exactly one dispatch mode/ : /Too many parallel tasks \(33\). Max is 32/);
				if (!mixedModes) assert.equal(result.isError, true);
				assert.deepEqual(result.details.results, []);
				assert.equal(confirm.mock.callCount(), 0);
				assert.equal(createLog.mock.callCount(), 0);
				assert.equal(createTemp.mock.callCount(), 0);
				assert.equal(spawnMock.mock.callCount(), 0);
			} finally {
				t.mock.restoreAll();
				syncBuiltinESMExports();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}

test("40k+ chain task uses generated file, preserving whitespace and literal @ references", async () => {
	const task = expandChainTask("  @missing.txt\n{previous}\n\t  ", "中文🙂 $& $$ ".repeat(5000));
	const { result, log, metadata } = await run("echo", task);
	assert.equal(result.status, "completed");
	assert.equal(result.output, `Task: ${task}`);
	assert.equal(log.find(record => record.type === "assistant").content, `Task: ${task}`);
});

test("cancellation terminates a direct child and cleans prompt files", { timeout: 15000 }, async () => {
	const { result } = await run("cancel", "test", new AbortController());
	assert.equal(result.status, "aborted");
	assert.equal(result.stopReason, "aborted");
});

test("terminal close and abort leave no delayed progress callbacks", async () => {
	const normalUpdates: any[] = [];
	await run("stream", "test", undefined, (partial) => normalUpdates.push(partial));
	const normalSettledCount = normalUpdates.length;
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(normalUpdates.length, normalSettledCount);

	const updates: any[] = [];
	const controller = new AbortController();
	const { result } = await run("cancel", "test", controller, (partial) => {
		updates.push(partial);
		controller.abort();
	});
	assert.equal(result.status, "aborted");
	const settledCount = updates.length;
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(updates.length, settledCount);
});

test("task-file write failure cleans the already-created system prompt directory", async (t) => {
	const originalWrite = fs.promises.writeFile;
	let temporaryDir: string | undefined;
	t.mock.method(fs.promises, "writeFile", async (...args: Parameters<typeof originalWrite>) => {
		if (String(args[0]).endsWith("task.txt")) {
			temporaryDir = dirname(String(args[0]));
			throw new Error("injected task file write failure");
		}
		return originalWrite(...args);
	});
	const { result, spawned } = await run("normal");
	assert.equal(result.status, "failed");
	assert.equal(spawned, false);
	assert.match(result.errorMessage!, /injected task file write failure/);
	assert.ok(temporaryDir);
	await assert.rejects(stat(temporaryDir), { code: "ENOENT" });
});

test("pre-aborted dispatch never spawns", async () => {
	const controller = new AbortController();
	controller.abort();
	const { result, spawned } = await run("normal", "test", controller);
	assert.equal(result.status, "aborted");
	assert.equal(spawned, false);
});

for (const stream of ["stdout", "stderr"]) {
	test(`raw UTF-8 bytes refresh inactivity before ${stream} decoder emits a character`, { timeout: 10000 }, async (t) => {
		// Coordinate byte delivery with the installed decoder, not subprocess startup
		// or OS scheduling. Four partial bytes span 400 ms against a 250 ms deadline.
		t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000000 });
		t.mock.method(performance, "now", () => Date.now());
		let producer: Promise<void> | undefined;
		let stats: Parameters<NonNullable<RunnerRuntime["onResourceStats"]>>[0] | undefined;
		const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
		const spawnMock = t.mock.method(childProcess, "spawn", (_command, args: readonly string[], options: any) => {
			const stdout = new PassThrough(), stderr = new PassThrough();
			let killed = false;
			const proc = Object.assign(new EventEmitter(), { stdout, stderr, exitCode: null, signalCode: null,
				kill(signal: string) { killed = true; stdout.end(); stderr.end(); proc.emit("close", 1, signal); return true; } });
			setImmediate(() => {
				emitManagedHeader(stdout, args, options.cwd);
				producer = (async () => {
					const event = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "🙂" }], stopReason: "stop" } });
					const parts = event.split("🙂");
					const output = stream === "stdout" ? stdout : stderr;
					if (stream === "stdout") { stdout.write(parts[0]); await flush(); }
					for (const byte of Buffer.from("🙂")) {
						output.write(Buffer.from([byte]));
						await flush();
						t.mock.timers.tick(100);
						await flush();
						if (killed) return;
					}
					stdout.end(stream === "stdout" ? parts[1] : event.replace("🙂", "done"));
					stderr.end();
					proc.emit("close", 0, null);
				})().catch((error) => { proc.emit("error", error); });
			});
			return proc;
		});
		syncBuiltinESMExports();
		try {
			const { result, log, metadata } = await run("normal", "test", undefined, undefined, 250, false, { onResourceStats(value) { stats = value; } });
			await producer;
			assert.equal(spawnMock.mock.callCount(), 1);
			assert.equal(result.status, "completed", result.errorMessage);
			assert.equal(result.output, stream === "stdout" ? "🙂" : "done");
			if (stream === "stderr") {
				assert.equal(stats!.maxStderrChunkBytes, 1);
				assert.equal(metadata.stderr, "🙂");
			}
		} finally { t.mock.restoreAll(); t.mock.timers.reset(); syncBuiltinESMExports(); }
	});
}
