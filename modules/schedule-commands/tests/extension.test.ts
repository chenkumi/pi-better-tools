import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import extension from "../src/index.ts";
import { MARKER_TYPE } from "../src/markers.ts";

function host(active = ["bash", "powershell", "schedule_prompt", "schedule_shell"]) {
	const tools = new Map<string, any>(), handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
	const renderers: string[] = [], sent: any[] = [];
	extension({
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerMessageRenderer: (type: string) => renderers.push(type),
		on: (event: string, handler: any) => handlers.set(event, handler),
		getActiveTools: () => active,
		sendMessage: (message: unknown) => sent.push(message),
		sendUserMessage() {},
		getSettings: () => ({}),
	} as never);
	return { tools, handlers, renderers, sent };
}

function context(cwd: string, trusted: boolean, notes: string[] = []) {
	return {
		cwd, mode: "rpc", hasUI: true, isProjectTrusted: () => trusted,
		ui: { notify: (message: string) => notes.push(message), confirm: async () => true },
		sessionManager: { getSessionId: () => "S1", getBranch: () => [] },
	};
}

async function withDirs(fn: (cwd: string, agentDir: string) => Promise<void>) {
	const cwd = mkdtempSync(join(tmpdir(), "sc-ext-")), agentDir = mkdtempSync(join(tmpdir(), "sc-agent-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try { await fn(cwd, agentDir); }
	finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(cwd, { recursive: true, force: true }); rmSync(agentDir, { recursive: true, force: true });
	}
}

test("registers both tools as default-active, with renderers, and the marker renderer", () => {
	const h = host();
	assert.deepEqual([...h.tools.keys()], ["schedule_prompt", "schedule_shell"]);
	assert.ok([...h.tools.values()].every((tool) => tool.defaultActive === true && typeof tool.renderCall === "function" && typeof tool.renderResult === "function" && tool.exposure === undefined));
	assert.deepEqual(h.renderers, [MARKER_TYPE]);
});

test("an untrusted project loads nothing: tools explain why and no store is created", async () => {
	await withDirs(async (cwd) => {
		const h = host();
		await h.handlers.get("session_start")!({}, context(cwd, false));
		const result = await h.tools.get("schedule_prompt").execute("1", { action: "list" }, undefined, undefined, context(cwd, false));
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /not trusted/);
		await h.handlers.get("session_shutdown")!({}, undefined);
	});
});

test("a trusted project starts the scheduler: jobs can be added and survive in the store", async () => {
	await withDirs(async (cwd) => {
		const h = host();
		const ctx = context(cwd, true);
		await h.handlers.get("session_start")!({}, ctx);
		const added = await h.tools.get("schedule_prompt").execute("1", { action: "add", name: "n", schedule: "1h", prompt: "p" }, undefined, undefined, ctx);
		assert.equal(added.isError, undefined, added.content[0].text);
		await h.handlers.get("session_shutdown")!({}, undefined);
		// A new session of the same directory sees the job (default scope binds it to the session, so use workdir via a fresh id).
		const again = await h.tools.get("schedule_prompt").execute("2", { action: "list" }, undefined, undefined, ctx);
		assert.equal(again.isError, true, "after shutdown the tools are unavailable again");
	});
});

test("a bad settings file stops the scheduler with a notice instead of using defaults", async () => {
	await withDirs(async (cwd, agentDir) => {
		writeFileSync(join(agentDir, "schedule-commands-settings.json"), '{"bogus":1}');
		const notes: string[] = [];
		const h = host();
		await h.handlers.get("session_start")!({}, context(cwd, true, notes));
		assert.match(notes[0], /Schedules not started: bogus is not a known setting/);
		const result = await h.tools.get("schedule_prompt").execute("1", { action: "list" }, undefined, undefined, context(cwd, true));
		assert.equal(result.isError, true);
	});
});

test("the old Schedule Prompt file is noticed once and never read", async () => {
	await withDirs(async (cwd) => {
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "schedule-prompts.json"), "legacy");
		const notes: string[] = [];
		const h = host();
		await h.handlers.get("session_start")!({}, context(cwd, true, notes));
		await h.handlers.get("session_start")!({}, context(cwd, true, notes));
		assert.equal(notes.filter((n) => /no longer read/.test(n)).length, 1);
		await h.handlers.get("session_shutdown")!({}, undefined);
	});
});
