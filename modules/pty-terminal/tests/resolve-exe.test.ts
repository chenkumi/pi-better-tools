import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { resolveWindowsCommand } from "../src/resolve-exe.ts";

function withBin<T>(files: string[], run: (a: string, b: string) => T): T {
	const root = mkdtempSync(join(tmpdir(), "pty-resolve-"));
	try {
		const a = join(root, "a"); const b = join(root, "b");
		mkdirSync(a); mkdirSync(b);
		for (const file of files) writeFileSync(join(file.startsWith("b/") ? b : a, file.replace(/^b\//, "")), "");
		return run(a, b);
	} finally { rmSync(root, { recursive: true, force: true }); }
}

test("a bare name resolves to the first PATH entry holding .exe, honouring PATH order", () => {
	withBin(["ssh.exe", "b/ssh.exe"], (a, b) => {
		assert.equal(resolveWindowsCommand("ssh", { Path: [a, b].join(delimiter) }, "win32"), join(a, "ssh.exe"));
		assert.equal(resolveWindowsCommand("ssh", { PATH: [b, a].join(delimiter) }, "win32"), join(b, "ssh.exe"));
	});
});

test(".com is accepted, .cmd/.bat are not", () => {
	withBin(["tool.com", "script.cmd", "script.bat"], a => {
		assert.equal(resolveWindowsCommand("tool", { Path: a }, "win32"), join(a, "tool.com"));
		assert.equal(resolveWindowsCommand("script", { Path: a }, "win32"), "script");
	});
});

test("paths, names with an extension, misses and other platforms are returned unchanged", () => {
	withBin(["ssh.exe"], a => {
		const env = { Path: a };
		for (const command of ["ssh.exe", "C:\\x\\ssh", "./ssh", "sub/ssh", "missing"]) assert.equal(resolveWindowsCommand(command, env, "win32"), command);
		assert.equal(resolveWindowsCommand("ssh", env, "linux"), "ssh");
		assert.equal(resolveWindowsCommand("ssh", {}, "win32"), "ssh");
	});
});
