import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VERSION } from "@earendil-works/pi-coding-agent";
import guard from "../extensions/subagent/child-guard.ts";

for (const scenario of ["success", "send-throws", "write-fails", "model-rejected", "throwing-error-getter", "rejected-stderr-fails", "failed-stderr-fails"] as const) {
	test(`guard startup IPC diagnostics preserve original validation and failure: ${scenario}`, async t => {
		const root = await mkdtemp(join(tmpdir(), "pi-guard-diagnostics-"));
		const oldEnv = process.env.PI_SUBAGENTS_GUARD;
		const slot = globalThis as { __piSubagentsGuardExpected?: unknown };
		const oldExpected = slot.__piSubagentsGuardExpected;
		const sendDescriptor = Object.getOwnPropertyDescriptor(process, "send");
		const connectedDescriptor = Object.getOwnPropertyDescriptor(process, "connected");
		const reports: any[] = []; let handler: Function | undefined;
		const failure = scenario === "throwing-error-getter" ? Object.defineProperty(new Error("private error"), "code", { get() { throw new Error("diagnostic getter"); } }) : Object.assign(new Error("private file error"), { code: "EACCES" });
		try {
			Object.defineProperty(process, "connected", { configurable: true, value: true });
			Object.defineProperty(process, "send", { configurable: true, value(value: unknown, callback: Function) {
				if (scenario === "send-throws") throw new Error("IPC disconnected");
				reports.push(value); callback(); return false; // Backpressure is diagnostic only; no waiting/retry.
			} });
			process.env.PI_SUBAGENTS_GUARD = JSON.stringify({ id: "session", cwd: fs.realpathSync(root), model: "offline/fixture", thinkingLevel: "off", childTrusted: false, startupPath: join(root, "startup.json"), bridgeToken: "PRIVATE_TOKEN" });
			const ctx = { cwd: root, model: { provider: "offline", id: "fixture" }, modelRegistry: { find() { return ["model-rejected", "rejected-stderr-fails"].includes(scenario) ? undefined : {}; } }, sessionManager: { getSessionId: () => "session" }, isProjectTrusted: () => false };
			guard({ on(event: string, callback: Function) { assert.equal(event, "session_start"); handler = callback; }, getThinkingLevel: () => "off" } as any);
			assert.equal(process.env.PI_SUBAGENTS_GUARD, undefined);
			if (["write-fails", "throwing-error-getter", "failed-stderr-fails"].includes(scenario)) { t.mock.method(fs, "writeFileSync", () => { throw failure; }); syncBuiltinESMExports(); }
			if (scenario === "failed-stderr-fails") {
				const writeSync = fs.writeSync;
				t.mock.method(fs, "writeSync", ((...args: any[]) => {
					if (args[0] === 2) throw new Error("stderr unavailable");
					return Reflect.apply(writeSync, fs, args);
				}) as typeof fs.writeSync); syncBuiltinESMExports();
			}
			if (["model-rejected", "rejected-stderr-fails"].includes(scenario)) {
				const exit = new Error("exit sentinel");
				// Preserve byte-count progress for every host write; only suppress the expected guard warning.
				const writeSync = fs.writeSync;
				t.mock.method(fs, "writeSync", ((...args: any[]) => {
					if (args[0] === 2 && scenario === "rejected-stderr-fails") throw new Error("stderr unavailable");
					if (args[0] === 2 && typeof args[1] === "string" && args[1].startsWith("MODEL_UNAVAILABLE: managed child startup")) return Buffer.byteLength(args[1]);
					return Reflect.apply(writeSync, fs, args);
				}) as typeof fs.writeSync); syncBuiltinESMExports();
				t.mock.method(process, "exit", ((code: number) => { assert.equal(code, 1); throw exit; }) as typeof process.exit);
				assert.throws(() => handler!({}, ctx), error => error === exit);
				assert.ok(reports.some(report => report.phase === "guard_rejected" && report.errorCode === "MODEL_UNAVAILABLE"));
			} else if (["write-fails", "throwing-error-getter", "failed-stderr-fails"].includes(scenario)) {
				let exits = 0;
				// Production fail-closed now exits: intercept only in this pure fault
				// fixture, then preserve the original-error assertions as well.
				t.mock.method(process, "exit", ((code: number) => { assert.equal(code, 1); exits++; }) as typeof process.exit);
				assert.throws(() => handler!({}, ctx), error => error === failure);
				assert.equal(exits, 1);
				assert.equal(reports.at(-1).phase, "guard_failed");
				assert.equal(reports.at(-1).errorCode, scenario === "throwing-error-getter" ? "OTHER" : "EACCES");
			} else {
				handler!({}, ctx);
				assert.deepEqual(JSON.parse(await readFile(join(root, "startup.json"), "utf8")), { version: 1, id: "session", cwd: fs.realpathSync(root), model: "offline/fixture", thinkingLevel: "off", childTrusted: false });
				assert.deepEqual(reports.map(report => report.phase), scenario === "success" ? ["guard_loaded", "guard_session_start", "guard_verified"] : []);
			}
			for (const report of reports) {
				assert.equal(report.channel, "pi-subagent-startup");
				assert.equal(report.token, "PRIVATE_TOKEN");
				assert.equal(report.piVersion, VERSION);
				assert.equal(report.nodeVersion, process.version);
				assert.ok(Object.keys(report).every(key => ["channel", "token", "phase", "piVersion", "nodeVersion", "errorCode"].includes(key)));
				assert.doesNotMatch(JSON.stringify(report), /private error|private file error/);
			}
		} finally {
			t.mock.restoreAll(); syncBuiltinESMExports();
			if (sendDescriptor) Object.defineProperty(process, "send", sendDescriptor); else delete process.send;
			if (connectedDescriptor) Object.defineProperty(process, "connected", connectedDescriptor); else delete (process as any).connected;
			if (oldEnv === undefined) delete process.env.PI_SUBAGENTS_GUARD; else process.env.PI_SUBAGENTS_GUARD = oldEnv;
			if (oldExpected === undefined) delete slot.__piSubagentsGuardExpected; else slot.__piSubagentsGuardExpected = oldExpected;
			await rm(root, { recursive: true, force: true });
		}
	});
}
