import assert from "node:assert/strict";
import test from "node:test";
import { PtySessionManager } from "../src/pty-manager.ts";

// node-pty 1.2.0-beta.15 closed the same ConPTY handle on every kill(); a second call while the first was in flight
// corrupted the heap (0xC0000374). The manager must never hand the native layer overlapping kills for one Windows pty.
async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
	Object.defineProperty(process, "platform", { ...descriptor, value: platform });
	try { return await run(); } finally { Object.defineProperty(process, "platform", descriptor); }
}

function fakeManager(options: { failFirstKill?: boolean } = {}) {
	const signals: Array<string | undefined> = [];
	let exit!: () => void;
	const manager = new PtySessionManager({
		killWaitMs: 5,
		spawnPty: (() => ({ pid: 123, write() {}, resize() {},
			kill(signal?: string) { signals.push(signal); if (options.failFirstKill && signals.length === 1) throw new Error("native kill failed"); },
			onData() { return { dispose() {} }; },
			onExit(cb: (event: { exitCode: number }) => void) { exit = () => cb({ exitCode: 0 }); return { dispose() {} }; },
		})) as never,
	});
	const id = manager.spawn("fake", [], {}, process.cwd()).sessionId;
	return { manager, id, signals, exit: () => exit() };
}

test("win32: concurrent kills of one running session reach the native layer once", () => withPlatform("win32", async () => {
	const { manager, id, signals } = fakeManager();
	const [first, second] = await Promise.all([manager.kill(id), manager.kill(id)]);
	assert.equal(first.released, false); // the fake never exits: unconfirmed, session retained
	assert.equal(second.released, false);
	assert.deepEqual(signals, [undefined]);
}));

test("win32: a sequential retry after an unconfirmed kill is allowed again", () => withPlatform("win32", async () => {
	const { manager, id, signals } = fakeManager();
	assert.equal((await manager.kill(id)).released, false);
	assert.equal((await manager.kill(id)).released, false);
	assert.deepEqual(signals, [undefined, undefined]); // not in flight any more; the pinned node-pty makes repeats safe
}));

test("win32: kill, late exit, then release frees the native handle exactly once in total", () => withPlatform("win32", async () => {
	const { manager, id, signals, exit } = fakeManager();
	assert.equal((await manager.kill(id)).released, false);
	exit();
	assert.equal((await manager.kill(id)).released, true);
	assert.deepEqual(signals, [undefined]);
}));

test("win32: shutdown racing a pty_kill still sends a single native kill", () => withPlatform("win32", async () => {
	const { manager, id, signals } = fakeManager();
	const pending = manager.kill(id);
	await manager.shutdown();
	await pending;
	assert.deepEqual(signals, [undefined]);
}));

test("win32: a native kill that throws while the session still runs can be retried", () => withPlatform("win32", async () => {
	const { manager, id, signals } = fakeManager({ failFirstKill: true });
	await assert.rejects(manager.kill(id), /PTY kill failed/);
	await manager.kill(id);
	assert.equal(signals.length, 2);
}));

test("linux: signal escalation across calls is unchanged", () => withPlatform("linux", async () => {
	const { manager, id, signals } = fakeManager();
	await manager.kill(id, "SIGHUP");
	await manager.kill(id, "SIGKILL");
	assert.deepEqual(signals, ["SIGHUP", "SIGKILL", "SIGKILL"]); // SIGHUP, its automatic escalation, then the explicit retry
}));
