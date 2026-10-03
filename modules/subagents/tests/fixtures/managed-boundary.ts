// Storage-boundary substitute for pre-existing protocol/stream fault tests only.
// These tests never verified native sessions. Real guard/checkpoint/resume coverage
// lives in always-managed.test.ts, session-store.test.ts and real CLI integration.
import assert from "node:assert/strict";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import type { Writable } from "node:stream";
import { ManagedSession } from "../../extensions/subagent/session-store.ts";

export const fixtureAgentPath = fileURLToPath(new URL("../../agents/worker.md", import.meta.url));
export function emitManagedHeader(stdout: Writable, args: readonly string[], cwd: string) {
	assert.equal(args.includes("--no-session"), false);
	const id = args[args.indexOf("--session-id") + 1];
	assert.match(id, /^[0-9a-z]{26}$/);
	stdout.write(JSON.stringify({ type: "session", version: 3, id, cwd: realpathSync.native(cwd) }) + "\n");
}
export async function managedRunMetadata(root: string, result: { subagentSessionId?: string; taskId: string; logPath?: string; canResume?: boolean }) {
	if (!result.subagentSessionId) return {};
	const file = join(root, "managed", result.subagentSessionId, "runs", result.taskId, "run.json");
	try { return JSON.parse(await readFile(file, "utf8")).result ?? {}; }
	catch (error) {
		// Abort may happen after allocation but before begin publishes a run.
		if ((error as NodeJS.ErrnoException).code === "ENOENT" && !result.logPath && !result.canResume) return {};
		throw error;
	}
}
export function installManagedBoundary(t: TestContext) {
	t.mock.method(ManagedSession.prototype, "acceptStartup", async function () {});
	t.mock.method(ManagedSession.prototype, "commit", async function (this: ManagedSession, segment: string, _digest: unknown, result: unknown, active: () => boolean) {
		assert.ok(active());
		assert.equal(segment, join(this.runDir, "transcript.jsonl"));
		await copyFile(segment, this.logPath);
		const runFile = join(this.runDir, "run.json");
		const run = JSON.parse(await readFile(runFile, "utf8"));
		await writeFile(runFile, JSON.stringify({ ...run, state: "completed", result }));
		this.manifest.state = "ready";
		await writeFile(join(this.directory, "manifest.json"), JSON.stringify(this.manifest));
	});
}
