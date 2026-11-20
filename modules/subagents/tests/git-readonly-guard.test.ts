import assert from "node:assert/strict";
import test from "node:test";
import guard from "../extensions/subagent/child-guard.ts";

function install(shellPolicy?: string) {
	const slot = globalThis as { __piSubagentsGuardExpected?: unknown };
	const old = slot.__piSubagentsGuardExpected, oldEnv = process.env.PI_SUBAGENTS_GUARD;
	process.env.PI_SUBAGENTS_GUARD = JSON.stringify({ id: "s", cwd: process.cwd(), startupPath: "x", ...(shellPolicy ? { shellPolicy } : {}) });
	const handlers = new Map<string, Function>();
	try { guard({ on: (event: string, handler: Function) => handlers.set(event, handler) } as any); }
	finally { slot.__piSubagentsGuardExpected = old; if (oldEnv === undefined) delete process.env.PI_SUBAGENTS_GUARD; else process.env.PI_SUBAGENTS_GUARD = oldEnv; }
	return handlers;
}

test("git-readonly policy blocks other commands and rewrites allowed ones", () => {
	const hook = install("git-readonly").get("tool_call")!;
	assert.ok(hook);
	const blocked = hook({ toolName: "bash", input: { command: "git status; rm -rf x" } });
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /^SHELL_COMMAND_NOT_ALLOWED/);
	const input = { command: "git diff HEAD~1", timeoutMs: 1000 };
	assert.equal(hook({ toolName: "powershell", input }), undefined);
	assert.match(input.command, /^git --no-pager --no-optional-locks -c core\.fsmonitor=false diff --no-ext-diff --no-textconv HEAD~1$/);
	assert.equal(input.timeoutMs, 1000);
});

test("other tools are untouched, and no hook is installed without the policy", () => {
	const hook = install("git-readonly").get("tool_call")!;
	assert.equal(hook({ toolName: "read", input: { path: "a" } }), undefined);
	assert.equal(install().has("tool_call"), false);
});
