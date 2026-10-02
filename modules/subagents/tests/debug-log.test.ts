import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getSubagentDebugLogDir, readGlobalDebugLogSetting, SUBAGENTS_PROJECT_NAME, writeSubagentDebugFailure } from "../extensions/subagent/debug-log.ts";

test("global debugLog setting defaults off and only accepts boolean true", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-debug-config-"));
	try {
		assert.equal(await readGlobalDebugLogSetting(root), false);
		await writeFile(join(root, "settings.json"), JSON.stringify({ "pi-subagents": { debugLog: true } }));
		assert.equal(await readGlobalDebugLogSetting(root), true);
		await writeFile(join(root, "settings.json"), JSON.stringify({ "pi-subagents": { debugLog: "true" } }));
		assert.equal(await readGlobalDebugLogSetting(root), false);
		await writeFile(join(root, "settings.json"), "{");
		assert.equal(await readGlobalDebugLogSetting(root), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("debugLog namespace matches package name and does not enable legacy or unrelated keys", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-debug-name-"));
	try {
		// Modules no longer carry their own manifest; the settings namespace is a persisted key and stays "pi-subagents".
		const name = "pi-subagents";
		assert.equal(SUBAGENTS_PROJECT_NAME, name);
		assert.equal(getSubagentDebugLogDir(root), join(root, ".pi", "logs", name));
		await writeFile(join(root, "settings.json"), JSON.stringify({ [name]: { debugLog: true } }));
		assert.equal(await readGlobalDebugLogSetting(root), true);
		for (const settings of [
			{ piSubagents: { debugLog: true } },
			{ subagent: { debugLog: true } },
			{ debugLog: true },
			{ "pi-subagents": { debugLog: false }, piSubagents: { debugLog: true } },
			{ "pi-subagents": null },
			{ "pi-subagents": [] },
			{ "pi-subagents": true },
			{ "pi-subagents": { debugLog: 1 } },
			{ "pi-subagents": { debugLog: "true" } },
			[], null,
		]) {
			await writeFile(join(root, "settings.json"), JSON.stringify(settings));
			assert.equal(await readGlobalDebugLogSetting(root), false, JSON.stringify(settings));
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("debug failure log records input, final response, JSONL path and its own file path", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-debug-log-"));
	try {
		const filePath = await writeSubagentDebugFailure({
			taskId: "task-1",
			input: { agent: "worker", systemPrompt: "review carefully", task: "inspect bug", taskPrompt: "Task: inspect bug" },
			status: "failed",
			exitCode: 1,
			stopReason: "error",
			errorMessage: "child failed",
			finalResponse: "partial answer",
			subsessionLogPath: "C:/logs/task.jsonl",
		}, { logsDir: root, now: new Date("2026-09-23T12:34:56.000Z") });
		const record = JSON.parse(await fs.readFile(filePath, "utf8"));
		assert.equal(record.debugLogPath, filePath);
		assert.equal(record.input.task, "inspect bug");
		assert.equal(record.input.taskPrompt, "Task: inspect bug");
		assert.equal(record.input.systemPrompt, "review carefully");
		assert.equal(record.finalResponse, "partial answer");
		assert.equal(record.subsessionLogPath, "C:/logs/task.jsonl");
		assert.match(record.createdAt, /^2026-09-23T12:34:56\.000Z$/);
		if (process.platform !== "win32") {
			assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
			assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
		}
		const duplicate = await writeSubagentDebugFailure({
			taskId: "task-1", input: record.input, status: "failed", exitCode: 1, finalResponse: "second failure",
		}, { logsDir: root, now: new Date(record.createdAt) });
		assert.notEqual(duplicate, filePath);
		assert.equal(JSON.parse(await fs.readFile(filePath, "utf8")).finalResponse, "partial answer");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
