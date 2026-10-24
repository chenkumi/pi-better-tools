import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import { PtySessionManager } from "../src/pty-manager.ts";
import { resolveTarget } from "../src/targets.ts";
import { parseEnvPolicy } from "../src/env.ts";
import extension from "../src/index.ts";

// Agent-facing text may name tool args and tool names, never settings keys, environment variable names or settings paths.
const FORBIDDEN = /pi-pty-terminal|pi-shell-tools|pi-gpt-speed|autoBackgroundMs|settings\.json|\bPI_[A-Z]|\bPATH\b|\btargets\.\w|\.pi\/|identityFile|\bdistribution\b/;
const msg = (fn: () => unknown): string => { try { fn(); } catch (error) { const text = (error as Error).message; assert.doesNotMatch(text, FORBIDDEN); return text; } throw new Error("expected throw"); };
const settings = { targets: { linux: { transport: "wsl", distribution: "Ubuntu", cwd: "/home/me" }, mac: { transport: "ssh", host: "mac-dev", cwd: "/Users/me" } } };
const resolve = (command: string, target: string, extra: Record<string, unknown> = {}, cfg: unknown = settings, platform: NodeJS.Platform = "win32") =>
	() => resolveTarget(command, [], { target, ...extra } as never, "C:/repo", cfg, platform);
function fakeManager(spawnPty?: unknown) {
	let exit: (e: { exitCode: number }) => void = () => {};
	const pty = { pid: 1, onData() {}, onExit(fn: typeof exit) { exit = fn; }, write() {}, resize() { throw new Error("native resize failure"); }, kill() { exit({ exitCode: 0 }); } };
	return new PtySessionManager({ spawnPty: (spawnPty ?? (() => pty)) as never });
}

test("target name and config errors name the target, rule and fix", () => {
	let m = msg(resolve("bash", "-bad"));
	assert.match(m, /name "-bad"/); assert.match(m, /letters, digits/); assert.match(m, /omit target/);
	m = msg(resolve("bash", "bad", {}, { targets: { bad: { transport: "other" } } }));
	assert.match(m, /"bad"/); assert.match(m, /SSH or WSL/); assert.match(m, /settings/);
	m = msg(resolve("bash", "bad", {}, { targets: { bad: { transport: "ssh", host: "h", cwd: "/x", password: "hunter2" } } }));
	assert.match(m, /"bad"/); assert.match(m, /unsupported entry/); assert.match(m, /settings/); assert.doesNotMatch(m, /hunter2|password/);
	m = msg(resolve("bash", "mac", { cwd: undefined }, { targets: { mac: { transport: "ssh", host: "h" } } }));
	assert.match(m, /"mac"/); assert.match(m, /cwd/); assert.match(m, /absolute POSIX path/); assert.match(m, /ask the user/i);
	m = msg(resolve("bash", "mac", { cwd: "rel/dir" }));
	assert.match(m, /"rel\/dir"/); assert.match(m, /starting with "\/"/);
});

test("command, distribution and host errors state the rule and fix", () => {
	let m = msg(resolve("", "mac"));
	assert.match(m, /command/); assert.match(m, /non-empty/); assert.match(m, /NUL/);
	m = msg(resolve("  ", "mac")); assert.match(m, /command/); assert.match(m, /whitespace/);
	m = msg(resolve("-rf", "mac")); assert.match(m, /"-rf"/); assert.match(m, /args/);
	m = msg(resolve("bash", "linux", {}, { targets: { linux: { transport: "wsl", distribution: "-x", cwd: "/h" } } }));
	assert.match(m, /"linux"/); assert.match(m, /WSL/); assert.match(m, /'-'/); assert.match(m, /settings/);
	m = msg(resolve("bash", "linux", {}, { targets: { linux: { transport: "wsl", cwd: "/h" } } }));
	assert.match(m, /WSL/); assert.match(m, /non-empty/);
	m = msg(resolve("bash", "mac", {}, { targets: { mac: { transport: "ssh", host: "-oProxyCommand=x", cwd: "/h" } } }));
	assert.match(m, /"mac"/); assert.match(m, /SSH/); assert.match(m, /\[A-Za-z0-9_\]/); assert.match(m, /settings/);
	m = msg(resolve("bash", "linux", {}, settings, "linux")); assert.match(m, /Windows/); assert.match(m, /ssh target or omit target/);
	m = msg(() => resolveTarget("bash", ["a", "b\0"], { target: "mac" } as never, "C:/repo", settings));
	assert.match(m, /args\[1\]/);
	m = msg(resolve("bash", "mac", { env: { K: "v\0" } })); assert.match(m, /"K"/);
});

test("spawn validates cwd and wraps native failures with command, cwd and hint", () => {
	const manager = fakeManager();
	let m = msg(() => manager.spawn("node", [], { cwd: "Z:/definitely/missing-dir" }, tmpdir()));
	assert.match(m, /cwd/); assert.match(m, /does not exist/); assert.match(m, /missing-dir/);
	m = msg(() => manager.spawn("node", [], { cwd: import.meta.filename }, tmpdir()));
	assert.match(m, /not a directory/);
	const failing = fakeManager(() => { throw new Error("File not found: "); });
	m = msg(() => failing.spawn("nope-cmd", [], { target: "local" }, tmpdir()));
	assert.match(m, /Failed to start "nope-cmd"/); assert.match(m, /File not found/); assert.match(m, /executable search path/); assert.match(m, /target "local"/);
});

test("size, session and resize errors show received values and next steps", () => {
	const manager = fakeManager();
	let m = msg(() => manager.spawn("node", [], { cols: 9999 }, tmpdir()));
	assert.match(m, /cols/); assert.match(m, /1 and 500/); assert.match(m, /got 9999/);
	m = msg(() => manager.resize("pty-none", 80, 24));
	assert.match(m, /"pty-none"/); assert.match(m, /pty_list/);
	m = msg(() => manager.resize("pty-none", 0, 24)); assert.match(m, /got 0/);
	const { sessionId } = manager.spawn("node", [], {}, tmpdir());
	m = msg(() => manager.resize(sessionId, 80, 24)); assert.match(m, /native resize failure/); assert.match(m, /resize not applied/);
});

test("env policy errors show the offending item and who fixes it", () => {
	let m = msg(() => parseEnvPolicy({ env: { allow: ["OK", "bad name"] } }));
	assert.match(m, /allowed-variables list/); assert.match(m, /"bad name"/); assert.match(m, /Ask the user/);
	m = msg(() => parseEnvPolicy({ env: { deny: "PATH" } }));
	assert.match(m, /denied-variables list/); assert.match(m, /Ask the user/);
	m = msg(() => parseEnvPolicy({ env: [] })); assert.match(m, /Ask the user/);
	m = msg(() => parseEnvPolicy({ env: { block: [] } })); assert.match(m, /unsupported entry/); assert.match(m, /Ask the user/); assert.doesNotMatch(m, /block/);
});

test("wait_exit timeout explains that the process is still running", async () => {
	const manager = fakeManager();
	const { sessionId } = manager.spawn("node", [], {}, tmpdir());
	const info = await manager.waitForExit(sessionId, 20);
	assert.equal(info.timedOut, true);
	assert.match(info.note ?? "", /still running after 20 ms/); assert.match(info.note ?? "", /pty_wait_exit again/); assert.match(info.note ?? "", /pty_kill/);
});

test("resize on an exited session says so instead of surfacing a native error", () => {
	let exit: (e: { exitCode: number }) => void = () => {};
	const manager = new PtySessionManager({ spawnPty: (() => ({ pid: 1, onData() {}, onExit(fn: typeof exit) { exit = fn; }, write() {}, resize() { throw new Error("native"); }, kill() {} })) as never });
	const { sessionId } = manager.spawn("node", [], {}, tmpdir());
	exit({ exitCode: 3 });
	const m = msg(() => manager.resize(sessionId, 80, 24));
	assert.match(m, /has exited \(exitCode 3\)/); assert.match(m, /resize was not applied/); assert.match(m, /pty_spawn/);
	assert.doesNotMatch(m, /native/);
});

test("tool descriptions and schemas never name settings keys or environment variables", () => {
	const tools: unknown[] = [];
	extension({ registerTool: (tool: unknown) => tools.push(tool), on() {}, getSettings: () => ({}) } as never);
	assert.ok(tools.length >= 7);
	assert.doesNotMatch(JSON.stringify(tools), FORBIDDEN);
});
