import assert from "node:assert/strict";
import test from "node:test";
import { PtySessionManager } from "../src/pty-manager.ts";
import { interactive } from "./fixture.ts";

async function until(manager: PtySessionManager, id: string, pattern: RegExp) {
	let output = "";
	for (let i = 0; i < 10 && !pattern.test(output); i++) output += await manager.read(id, 1000);
	assert.match(output, pattern);
	return output;
}
test("spawns a process, reads output once and reports exit code", async t => {
	const manager = new PtySessionManager(); t.after(() => manager.shutdown());
	const { sessionId } = manager.spawn(process.execPath, ["-e", "process.stdout.write('hello'); setTimeout(()=>process.exit(7),100)"], {}, process.cwd());
	await until(manager, sessionId, /hello/);
	assert.equal((await manager.waitForExit(sessionId, 5000)).exitCode, 7);
	assert.equal(await manager.read(sessionId, 0), "");
	assert.equal(manager.list()[0].target, "local");
});
test("writes terminal input, resizes and releases killed session", async t => {
	const manager = new PtySessionManager(); t.after(() => manager.shutdown());
	const { sessionId } = manager.spawn(process.execPath, ["-e", interactive], {}, process.cwd());
	await until(manager, sessionId, /READY/);
	manager.resize(sessionId, 80, 24); manager.write(sessionId, "hello\r");
	await until(manager, sessionId, /received:hello/);
	manager.kill(sessionId); assert.deepEqual(manager.list(), []);
});
test("buffered output does not prematurely settle waitForExit; abort and shutdown release waiters", async t => {
	const manager = new PtySessionManager(); t.after(() => manager.shutdown());
	const { sessionId } = manager.spawn(process.execPath, ["-e", "process.stdout.write('READY');setInterval(()=>{},1000)"], {}, process.cwd());
	await until(manager, sessionId, /READY/);
	assert.equal((await manager.waitForExit(sessionId, 50)).exitCode, -1);
	const controller = new AbortController();
	const pending = manager.read(sessionId, 10000, controller.signal);
	controller.abort(new Error("cancelled")); await assert.rejects(pending, /cancelled/);
	const read = manager.read(sessionId, 10000); const exit = manager.waitForExit(sessionId, 10000);
	manager.shutdown(); await read; await exit; assert.deepEqual(manager.list(), []);
	manager.shutdown();
});
