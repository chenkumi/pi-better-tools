import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { Check } from "typebox/value";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import registerSubagent, { normalizeDispatch } from "../extensions/subagent/index.ts";
import { messageHarness } from "./fixtures/message-harness.ts";
import { displayTitle, isValidTitle } from "../extensions/subagent/title.ts";
import { compactResult, emptyUsage, formatParentResults } from "../extensions/subagent/result.ts";

const agentDir = await mkdtemp(join(tmpdir(), "pi-title-agent-dir-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(async () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(agentDir, { recursive: true, force: true });
});
const child = fileURLToPath(new URL("./fixtures/managed-native.mjs", import.meta.url));
async function setup(scenario = "normal") {
	const root = await mkdtemp(join(tmpdir(), "pi-subagent-title-"));
	let tool: any, messageTool: any;
	const messages = messageHarness();
	const invocations: string[][] = [];
	registerSubagent({ sendMessage: messages.sendMessage, registerMessageRenderer() {}, registerTool(t: any) { if (t.name === "subagent") tool = t; if (t.name === "subagent_message") messageTool = t; }, on() {} } as any, {
		debugLog: false, sessionRootDir: join(root, "managed"),
		invocation(args) { invocations.push([...args]); return { command: process.execPath, args: [child, scenario, ...args] }; },
	});
	const model = { provider: "offline-fixture", id: "model", reasoning: false };
	const ctx: any = { cwd: root, hasUI: false, isProjectTrusted: () => false, model, thinkingLevel: "off",
		sessionManager: { getSessionId: () => "parent" }, modelRegistry: { find: () => model, getAll: () => [model] } };
	return { root, tool, messageTool, messages, ctx, invocations };
}
const theme: any = { fg: (_key: string, text: string) => text, bold: (text: string) => text };
const renderResult = (tool: any, result: any, expanded = false, width = 80) => tool.renderResult(result, { expanded, isPartial: true }, theme, {}).render(width).join("\n");

test("title schema and runtime accept up to 50 Unicode code points and reject invalid titles in every mode", async t => {
	const h = await setup(); t.after(() => rm(h.root, { recursive: true, force: true }));
	assert.equal(h.tool.parameters.properties.title.maxLength, 50);
	assert.equal(h.tool.parameters.properties.title.description, "用50字內描述這個subagent要做甚麼事");
	for (const title of ["調查登入流程", "字".repeat(50), "🙂".repeat(50), "👩‍💻".repeat(16), "e\u0301".repeat(25), "👍🏽".repeat(25)]) {
		assert.equal(isValidTitle(title), true);
		for (const args of [{ agent: "worker", task: "work", title }, { tasks: [{ agent: "worker", task: "work", title }] }, { chain: [{ agent: "worker", task: "work", title }] }]) {
			assert.equal(Check(h.tool.parameters, args), true);
			const validated = validateToolArguments(h.tool, { type: "toolCall", id: "title", name: "subagent", arguments: args });
			assert.doesNotThrow(() => normalizeDispatch(validated));
		}
	}
	for (const title of ["", "   ", null, 7, "\x1b[2J", "字".repeat(51), "🙂".repeat(51), "👩‍💻".repeat(17), "e\u0301".repeat(26), "👍🏽".repeat(26), "e" + "\u0301".repeat(4096)]) {
		assert.equal(isValidTitle(title), false);
		for (const args of [{ agent: "worker", task: "work", title }, { tasks: [{ agent: "worker", task: "work", title }] }, { chain: [{ agent: "worker", task: "work", title }] }]) {
			const outcome = await h.tool.execute("invalid", args, undefined, undefined, h.ctx);
			assert.equal(outcome.isError, true); assert.equal(outcome.details.errorCode, "INVALID_DISPATCH");
		}
	}
	assert.deepEqual(await readdir(h.root), []); assert.equal(h.invocations.length, 0);
	assert.throws(() => normalizeDispatch({ resume: "id", task: "work", title: "續接", model: "other" }), /INVALID_DISPATCH/);
});

test("host normalization preserves optional-null and primitive-coercion semantics for titles", async t => {
	const h = await setup(); t.after(() => rm(h.root, { recursive: true, force: true }));
	const validate = (arguments_: any) => validateToolArguments(h.tool, { type: "toolCall", id: "title", name: "subagent", arguments: arguments_ });
	assert.equal(validate({ agent: "worker", task: "work", title: null }).title, undefined);
	for (const title of [7, true]) {
		const args = validate({ agent: "worker", task: "work", title });
		assert.equal(args.title, String(title)); assert.doesNotThrow(() => normalizeDispatch(args));
	}
	const batch = validate({ tasks: [{ agent: "worker", task: "work", title: null }, { agent: "worker", task: "work", title: 7 }] });
	assert.equal(batch.tasks[0].title, undefined); assert.equal(batch.tasks[1].title, "7");
	assert.throws(() => validate({ agent: "worker", task: "work", title: {} }), /Validation failed/);
	// Some host schemas count combining clusters as one; dispatch still enforces code points before IO.
	for (const title of ["e\u0301".repeat(26), "👩‍💻".repeat(17)]) {
		let args: any;
		try { args = validate({ agent: "worker", task: "work", title }); } catch { continue; }
		const result = await h.tool.execute("too-long", args, undefined, undefined, h.ctx);
		assert.equal(result.details.errorCode, "INVALID_DISPATCH");
	}
	assert.deepEqual(await readdir(h.root), []); assert.equal(h.invocations.length, 0);
});

for (const mode of ["single", "parallel", "chain"] as const) {
	test(`${mode} retains display titles through updates and final results without changing child tasks/config`, async t => {
		const h = await setup(); t.after(() => rm(h.root, { recursive: true, force: true }));
		const item = { agent: "worker", task: "actual child work", title: "調查程式碼" };
		const args = mode === "single" ? item : { title: "整批工作", [mode === "parallel" ? "tasks" : "chain"]: [item, { agent: "worker", task: "next child work" }] };
		const snapshots: any[] = [];
		const outcome = await h.tool.execute(mode, args, undefined, (p: any) => snapshots.push(structuredClone(p.details)), h.ctx);
		assert.equal(outcome.isError, undefined, JSON.stringify(outcome.content));
		assert.deepEqual(outcome.details.results.map((r: any) => r.title), mode === "single" ? [item.title] : [item.title, "整批工作"]);
		assert.ok(snapshots.length); assert.ok(snapshots.every(s => s.results.every((r: any) => typeof r.title === "string")));
		assert.match(h.tool.renderCall(args, theme, {}).render(80).join("\n"), /調查程式碼/);
		for (const result of outcome.details.results) {
			assert.equal(result.canResume, true);
			const manifest = JSON.parse(await readFile(join(h.root, "managed", result.subagentSessionId, "manifest.json"), "utf8"));
			assert.equal(manifest.config.title, undefined);
			const transcript = await readFile(result.logPath, "utf8");
			assert.ok(!transcript.includes(result.title));
			assert.ok(transcript.includes(result.task));
		}
		assert.ok(h.invocations.every(argv => !argv.some(arg => /調查程式碼|整批工作/.test(arg))));
		for (const expanded of [false, true]) assert.match(renderResult(h.tool, outcome, expanded), /調查程式碼/);
		const noTitle = structuredClone(outcome);
		delete noTitle.details.title; for (const r of noTitle.details.results) delete r.title;
		assert.equal(formatParentResults(mode, outcome.details.results), formatParentResults(mode, noTitle.details.results), "titles must not replace model-visible task/output");
	});
}

test("resume accepts a fresh display title without altering saved identity/config or prior title", async t => {
	const h = await setup(); t.after(() => rm(h.root, { recursive: true, force: true }));
	const first = await h.tool.execute("first", { agent: "worker", task: "question", title: "查明問題" }, undefined, undefined, h.ctx);
	const prior = first.details.results[0];
	const path = join(h.root, "managed", prior.subagentSessionId, "manifest.json");
	const config = JSON.parse(await readFile(path, "utf8")).config;
	const args = { subagentSessionId: prior.subagentSessionId, message: "choose B", title: "套用方案B" };
	const second = await h.messages.message(h.messageTool, "next", args, h.ctx);
	assert.equal(second.isError, undefined, JSON.stringify(second.content));
	assert.match(h.messageTool.renderCall(args, theme, {}).render(120).join("\n"), /套用方案B/); assert.equal(prior.title, "查明問題");
	assert.equal(second.details.results[0].subagentSessionId, prior.subagentSessionId);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")).config, config);
	assert.equal(JSON.parse(second.details.results[0].output).previousUsers, 1);
});

test("failure, aborted dispatch and denied project agent preserve title without starting an unauthorized child", async t => {
	const h = await setup("exit-failure"); t.after(() => rm(h.root, { recursive: true, force: true }));
	const first = await h.tool.execute("failure", { agent: "worker", task: "fail", title: "顯示失敗工作" }, undefined, undefined, h.ctx);
	assert.equal(first.isError, true); assert.equal(first.details.results[0].title, "顯示失敗工作");
	const abort = new AbortController(); abort.abort();
	const stopped = await h.tool.execute("abort", { agent: "worker", task: "work", title: "取消工作" }, abort.signal, undefined, h.ctx);
	assert.equal(stopped.isError, true); assert.equal(stopped.details.results[0].title, "取消工作");
	await mkdir(join(h.root, ".pi", "agents"), { recursive: true });
	await writeFile(join(h.root, ".pi", "agents", "private-agent.md"), "---\nname: private-agent\ndescription: fixture\n---\nfixture");
	h.ctx.hasUI = true; h.ctx.ui = { confirm: async () => false };
	const denied = await h.tool.execute("denied", { agent: "private-agent", task: "work", title: "專案代理工作", agentScope: "project" }, undefined, undefined, h.ctx);
	assert.equal(denied.isError, true); assert.equal(denied.details.results[0].title, "專案代理工作");
	assert.equal(h.invocations.length, 1);
});

test("title renderers sanitize controls, tolerate legacy/partial titles and fit narrow widths without mutation", async t => {
	const h = await setup(); t.after(() => rm(h.root, { recursive: true, force: true }));
	const unsafe = "\x1b]0;SECRET\x07\x1b[2J調查\u202e\x85登入\n流程";
	assert.equal(displayTitle(unsafe), "調查登入 流程");
	assert.equal(displayTitle({}), ""); assert.equal(displayTitle(undefined), "");
	assert.equal(displayTitle("字".repeat(51)), "字".repeat(50));
	const entry = compactResult({ taskId: "id", agent: "worker", agentSource: "bundled", task: "work", title: unsafe, status: "running", exitCode: -1, output: "", usage: emptyUsage() });
	const result = { content: [], details: { mode: "single", results: [entry] } };
	const before = JSON.stringify(result);
	for (const title of [unsafe, undefined, {}, "字".repeat(50)]) for (const expanded of [false, true]) for (const width of [12, 24, 80]) {
		const call = h.tool.renderCall({ agent: "worker", title, tasks: [{ agent: "worker", title }] }, theme, {}).render(width);
		const lines = h.tool.renderResult(result, { expanded, isPartial: true }, theme, {}).render(width);
		assert.doesNotMatch([...call, ...lines].join("\n"), /\x1b|[\x07\x80-\x9f\u202a-\u202e\u2066-\u2069]/);
		assert.ok([...call, ...lines].every(line => visibleWidth(line) <= width));
	}
	assert.equal(JSON.stringify(result), before);
	for (const args of [undefined, null, { tasks: {} }, { chain: "partial" }, { tasks: [null, { title: "待處理" }] }]) assert.doesNotThrow(() => h.tool.renderCall(args, theme, {}).render(24));
	const legacy = structuredClone(result); delete (legacy.details.results[0] as any).title;
	assert.doesNotMatch(renderResult(h.tool, legacy), /undefined|調查/);
});
