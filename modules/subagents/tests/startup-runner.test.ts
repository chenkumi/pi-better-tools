import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough, Writable } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runSingleAgent } from "../extensions/subagent/index.ts";
import { fixtureAgentPath, installManagedBoundary, managedRunMetadata } from "./fixtures/managed-boundary.ts";

for (const failure of ["get_state", "get_entries", "prompt", "early-close", "guard-only-no-file"] as const) {
	for (const debugLog of [true, false]) test(`RPC startup failure diagnostics preserve original result and debug format: ${failure}, debug=${debugLog}`, async t => {
		installManagedBoundary(t);
		const root = await mkdtemp(join(tmpdir(), "pi-startup-runner-"));
		const commands: any[] = [], debugRecords: any[] = [];
		let bridgeToken = "", proc: any;
		// Faults are command/event-driven, never idle waits or real providers.
		t.mock.method(childProcess, "spawn", (_command: string, args: readonly string[], options: any) => {
			const guard = JSON.parse(options.env.PI_SUBAGENTS_GUARD); bridgeToken = guard.bridgeToken;
			const stdout = new PassThrough(), stderr = new PassThrough();
			const finish = () => { stdout.end(); stderr.end(); proc.exitCode = 7; proc.emit("close", 7, null); };
			proc = Object.assign(new EventEmitter(), { stdout, stderr, exitCode: null, signalCode: null,
				kill() { setImmediate(finish); return true; },
				stdin: new Writable({ write(chunk, _encoding, callback) {
					const command = JSON.parse(chunk.toString()); commands.push(command); callback();
					setImmediate(() => {
						proc.emit("message", { channel: "pi-subagent-startup", token: bridgeToken, phase: "guard_verified", piVersion: "1.0.0", nodeVersion: process.version });
						if (failure === "early-close") { finish(); return; }
						const data = command.type === "get_state" ? { sessionId: guard.id, sessionFile: join(args[args.indexOf("--session-dir") + 1], "native.jsonl"), model: { provider: "offline", id: "fixture" } }
							: command.type === "get_entries" ? { entries: [], leafId: null } : command.type === "prompt" ? { disposition: "started" } : {};
						stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: command.type !== failure, ...(command.type === failure ? { error: "injected startup command rejection" } : { data }) }) + "\n");
					});
				} }),
			});
			setImmediate(() => proc.emit("spawn"));
			return proc;
		});
		if (failure === "guard-only-no-file") {
			const { ManagedSession } = await import("../extensions/subagent/session-store.ts");
			t.mock.method(ManagedSession.prototype, "acceptStartup", async () => { throw Object.assign(new Error("startup file missing"), { code: "ENOENT" }); });
		}
		syncBuiltinESMExports();
		try {
			const result = await runSingleAgent(root, { model: "offline/fixture", modelWasExplicit: false, thinkingLevelWasExplicit: false },
				[{ name: "worker", description: "fixture", source: "bundled", filePath: fixtureAgentPath, systemPrompt: "system" }],
				"worker", "SECRET_TASK", undefined, undefined, undefined, undefined,
				results => ({ mode: "single", agentScope: "user", projectAgentsDir: null, results }), "parent", `call-${failure}`,
				{ transport: "rpc", sessionRootDir: join(root, "managed"), debugLog,
					debugLogWriter: async value => { debugRecords.push(value); return "test-debug.json"; },
					invocation: args => ({ command: "mock", args }) });
			assert.equal(result.status, "failed"); assert.equal(result.exitCode, 7); assert.equal(result.canResume, false);
			assert.equal(result.errorCode, "COMMIT_FAILED");
			assert.match(result.errorMessage!, /RPC startup failed/);
			const expectedPhase = failure === "get_entries" ? "awaiting_get_entries" : failure === "prompt" ? "submitting_initial_prompt" : failure === "guard-only-no-file" ? "verifying_startup_guard" : "awaiting_get_state";
			assert.match(result.errorMessage!, new RegExp(`phase=${expectedPhase}`));
			assert.match(result.errorMessage!, /Guard reported successful checks/);
			assert.match(result.errorMessage!, /Cleanup observations: child close observed: yes/);
			assert.match(result.errorMessage!, /Exact cause is unknown/);
			assert.equal(debugRecords.length, debugLog ? 1 : 0);
			if (debugLog) assert.equal(debugRecords[0].errorMessage, result.errorMessage);
			const metadata = await managedRunMetadata(root, result);
			assert.match(metadata.diagnostic, /Startup observations/);
			assert.match(metadata.errorMessage, /Startup observation data/);
			assert.equal(Object.hasOwn(result, "startupDiagnostics"), false, "no new public result/schema fields");
			assert.doesNotMatch(result.errorMessage!, /SECRET_TASK/);
			assert.equal(result.errorMessage!.includes(bridgeToken), false, "IPC token never enters failure text/debug diagnostics");
			if (failure !== "prompt") assert.ok(commands.every(command => command.type !== "prompt"));
			if (failure === "guard-only-no-file") assert.equal(commands.length, 1, "IPC success must never bypass the actual startup file");
			const manifest = JSON.parse(await readFile(join(root, "managed", result.subagentSessionId!, "manifest.json"), "utf8"));
			assert.equal(manifest.state, "blocked");
		} finally {
			t.mock.restoreAll(); syncBuiltinESMExports(); proc?.stdin.destroy();
			await rm(root, { recursive: true, force: true });
		}
	});
}
