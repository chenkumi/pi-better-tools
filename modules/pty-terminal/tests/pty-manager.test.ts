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
	const killed = await manager.kill(sessionId); assert.equal(killed.released, true); assert.deepEqual(manager.list(), []);
});
test("buffered output does not prematurely settle waitForExit; abort and shutdown release waiters", async t => {
	const manager = new PtySessionManager(); t.after(() => manager.shutdown());
	const { sessionId } = manager.spawn(process.execPath, ["-e", "process.stdout.write('READY');setInterval(()=>{},1000)"], {}, process.cwd());
	await until(manager, sessionId, /READY/);
	const timedOut = await manager.waitForExit(sessionId, 50); assert.equal(timedOut.exitCode, -1); assert.equal(timedOut.timedOut, true);
	const controller = new AbortController();
	const pending = manager.read(sessionId, 10000, controller.signal);
	controller.abort(new Error("cancelled")); await assert.rejects(pending, /cancelled/);
	const read = manager.read(sessionId, 10000); const exit = manager.waitForExit(sessionId, 10000);
	const readStopped = assert.rejects(read, /shutting down/);
	await manager.shutdown(); await readStopped;
	const shutdownExit = await exit;
	assert.equal(shutdownExit.timedOut, undefined); // real backend exit, not a fabricated -1
	assert.equal(typeof shutdownExit.exitCode, "number"); assert.deepEqual(manager.list(), []);
	await manager.shutdown();
});
test("SSH exit 255 carries a connection-error note; other exits do not", async t => {
	const manager = new PtySessionManager(); t.after(() => manager.shutdown());
	const ssh = manager.spawn(process.execPath, ["-e", "process.exit(255)"], { transport: "ssh", target: "x" }, process.cwd());
	const info = await manager.waitForExit(ssh.sessionId, 5000); assert.equal(info.exitCode, 255); assert.match(info.note ?? "", /connection error/);
	const local = manager.spawn(process.execPath, ["-e", "process.exit(255)"], {}, process.cwd());
	assert.equal((await manager.waitForExit(local.sessionId, 5000)).note, undefined);
});
test("output ring buffer drops oldest data and reports it once", async t => {
	const manager = new PtySessionManager({ maxBufferChars: 100 }); t.after(() => manager.shutdown());
	const { sessionId } = manager.spawn(process.execPath, ["-e", "process.stdout.write('A'.repeat(500)+'END')"], {}, process.cwd());
	await manager.waitForExit(sessionId, 10000);
	const summary = manager.list()[0];
	assert.ok(summary.bufferedBytes <= 100); assert.ok(summary.droppedChars > 0);
	const output = await manager.read(sessionId, 0);
	assert.match(output, /earlier characters were dropped/); assert.match(output, /END/);
	assert.doesNotMatch(await manager.read(sessionId, 0), /dropped/);
});
test("session count and terminal size are capped; exited sessions are reclaimed", async t => {
	let clock = 0;
	const manager = new PtySessionManager({ maxSessions: 1, exitedRetentionMs: 1000, now: () => clock }); t.after(() => manager.shutdown());
	const exitNow = ["-e", "process.exit(0)"];
	assert.throws(() => manager.spawn(process.execPath, exitNow, { cols: 100000 }, process.cwd()), /cols/);
	assert.throws(() => manager.spawn(process.execPath, exitNow, { rows: 0 }, process.cwd()), /rows/);
	const first = manager.spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {}, process.cwd());
	assert.throws(() => manager.spawn(process.execPath, exitNow, {}, process.cwd()), /session limit/);
	assert.throws(() => manager.resize(first.sessionId, 1, 100000), /rows/);
	assert.equal((await manager.kill(first.sessionId, "SIGKILL")).released, true);
	const second = manager.spawn(process.execPath, exitNow, {}, process.cwd());
	await manager.waitForExit(second.sessionId, 10000);
	assert.equal(manager.list().length, 1);
	clock = 5000; assert.deepEqual(manager.list(), []);
	// An exited session yields its slot only after all output (including native terminal setup) was drained.
	const third = manager.spawn(process.execPath, ["-e", "process.stdout.write('KEEP');process.exit(0)"], {}, process.cwd());
	await manager.waitForExit(third.sessionId, 10000);
	assert.throws(() => manager.spawn(process.execPath, exitNow, {}, process.cwd()), /unread exited output is retained/);
	assert.match(await manager.read(third.sessionId, 0), /KEEP/);
	assert.equal(manager.list()[0].bufferedBytes, 0);
	const fourth = manager.spawn(process.execPath, exitNow, {}, process.cwd());
	assert.notEqual(fourth.sessionId, third.sessionId);
});
test("kill validates signals and keeps the session when it cannot be confirmed dead", async t => {
	const manager = new PtySessionManager({ killWaitMs: 5 }); t.after(() => manager.shutdown());
	const { sessionId } = manager.spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {}, process.cwd());
	await assert.rejects(manager.kill(sessionId, "SIGUSR1"), /Unsupported signal/);
	assert.equal(manager.list().length, 1);
	const internal = (manager as any).sessions.get(sessionId);
	internal.pty.kill = () => { throw new Error("boom"); };
	await assert.rejects(manager.kill(sessionId), /retained/);
	assert.equal(manager.list().length, 1);
	// A transport that stays running after a successful signal is reported honestly as not released.
	internal.pty.kill = () => {};
	const result = await manager.kill(sessionId);
	assert.equal(result.released, false); assert.equal(result.exited, false); assert.equal(manager.list().length, 1);
	delete internal.pty.kill;
});
