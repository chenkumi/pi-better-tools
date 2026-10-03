import assert from "node:assert/strict";
import test from "node:test";
import { quotePosix, resolveTarget } from "../src/targets.ts";
import extension from "../src/index.ts";
const settings = { targets: { linux: { transport: "wsl", distribution: "Ubuntu", cwd: "/home/me/repo" }, macos: { transport: "ssh", host: "mac-dev", cwd: "/Users/me/repo" } } };
test("default/explicit local preserve command, args, cwd and env", () => {
	for (const target of [undefined, "local"]) {
		const options = { target, cwd: "local path", env: { X: "y" } };
		const plan = resolveTarget("node", ["a b"], options, "workspace", undefined);
		assert.equal(plan.transport, "local"); assert.equal(plan.options, options); assert.deepEqual(plan.args, ["a b"]);
	}
});
test("WSL uses native argv and separates remote cwd/env from client", () => {
	const plan = resolveTarget("bash", ["-l", "a'b"], { target: "linux", env: { X: "$HOME" } }, "C:/repo", settings, "win32");
	assert.deepEqual(plan.args, ["--distribution", "Ubuntu", "--cd", "/home/me/repo", "--exec", "env", "--", "X=$HOME", "bash", "-l", "a'b"]);
	assert.equal(plan.options.cwd, "C:/repo"); assert.equal(plan.options.env, undefined);
	assert.throws(() => resolveTarget("bash", [], { target: "linux" }, "/repo", settings, "linux"), /Windows/);
});
test("SSH quotes every remote value including nested shell, preserves host key defaults", () => {
	const cwd = "/Users/me/a'b;$(touch BAD)";
	const plan = resolveTarget("node", ["a'b", "$(touch BAD)", "", "line\nnext"], { target: "macos", cwd, env: { X: "a'b $HOME" } }, "C:/repo", settings);
	const script = `cd ${quotePosix(cwd)} && exec env -- ${["X=a'b $HOME", "node", "a'b", "$(touch BAD)", "", "line\nnext"].map(quotePosix).join(" ")}`;
	assert.deepEqual(plan.args, ["-tt", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "mac-dev", `sh -c ${quotePosix(script)}`]);
	assert.equal(plan.options.env, undefined); assert.equal(plan.transport, "ssh");
});
test("invalid targets/config/paths/env fail closed without fallback", () => {
	for (const target of ["missing", "__proto__", "-bad"]) assert.throws(() => resolveTarget("bash", [], { target }, "local", settings));
	for (const config of [{ transport: "ssh", host: "-oProxyCommand=bad", cwd: "/repo" }, { transport: "ssh", host: "mac", cwd: "relative" }, { transport: "ssh", host: "mac", cwd: "/repo", password: "secret" }, { transport: "other" }]) {
		assert.throws(() => resolveTarget("bash", [], { target: "bad" }, "local", { targets: { bad: config } }));
	}
	assert.throws(() => resolveTarget("bash", [], { target: "macos", env: { "X;bad": "v" } }, "local", settings), /environment/);
	assert.throws(() => resolveTarget("bash", ["\0"], { target: "macos" }, "local", settings), /NUL/);
});
test("remote command that looks like an env assignment or is empty/blank is rejected", () => {
	for (const target of ["macos", "linux"]) {
		assert.throws(() => resolveTarget("FOO=bar", ["x"], { target }, "C:/repo", settings, "win32"), /assignment/);
		assert.throws(() => resolveTarget("", [], { target }, "C:/repo", settings, "win32"), /command/);
		assert.throws(() => resolveTarget("  ", [], { target }, "C:/repo", settings, "win32"), /empty/);
	}
	assert.doesNotThrow(() => resolveTarget("./FOO=bar", [], { target: "macos" }, "C:/repo", settings));
});
test("SSH never disables or overrides host-key verification", () => {
	const plan = resolveTarget("node", [], { target: "macos" }, "C:/repo", settings);
	assert.ok(!plan.args.some(arg => /StrictHostKeyChecking|UserKnownHostsFile/i.test(arg)));
});
test("extension reads effective settings only for remote and rejects pre-aborted spawn", async () => {
	const tools = new Map<string, any>(); let reads = 0;
	extension({ registerTool: (tool: any) => tools.set(tool.name, tool), on: () => {}, getSettings: () => { reads++; return {}; } } as never);
	const spawn = tools.get("pty_spawn");
	await assert.rejects(spawn.execute("id", { target: "missing", command: "bash" }, undefined, undefined, { cwd: process.cwd() }), /Unknown/);
	assert.equal(reads, 1);
	const signal = AbortSignal.abort();
	await assert.rejects(spawn.execute("id", { command: "node" }, signal, undefined, { cwd: process.cwd() }), /aborted/);
	assert.equal(reads, 1);
});
