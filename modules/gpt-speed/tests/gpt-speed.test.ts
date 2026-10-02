import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import lockfile from "proper-lockfile";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import extension, { effectiveSpeedMode, type SpeedMode } from "../extensions/gpt-speed.ts";

type Model = NonNullable<ExtensionContext["model"]>;
const model = (id: string, provider = "openai") => ({ id, provider }) as Model;
const names = ["luna", "terra", "sol", "astra"];
for (const provider of ["openai", "openai-codex"]) {
	for (const version of ["5.6", "5.10", "6", "6.0", "6.1", "10.0"]) {
		test(`${provider}: gpt-${version} supports all four names and automatic downgrade`, () => {
			for (const name of names) {
				const current = model(`gpt-${version}-${name}`, provider);
				assert.equal(effectiveSpeedMode("normal", current), "normal");
				assert.equal(effectiveSpeedMode("fast", current), "fast");
				assert.equal(effectiveSpeedMode("ultrafast", current), ["luna", "terra"].includes(name) ? "fast" : "ultrafast");
			}
		});
	}
}
for (const id of ["gpt-5.5-sol", "gpt-5-sol", "gpt-4.99-sol", "gpt-5.4", "gpt-6-codex", "gpt-6", "GPT-6-sol", "gpt-6-SOL", "gpt-6-sol-20261001", "gpt-6.0.1-sol", "gpt-05.6-sol", "gpt-5.06-sol", "gpt-6-sol\n", " gpt-6-sol", "openai/gpt-6-sol", "gpt-NaN-sol"]) {
	test(`nonmatching or old model stays inactive: ${JSON.stringify(id)}`, () => {
		for (const mode of ["fast", "ultrafast"] as const) assert.equal(effectiveSpeedMode(mode, model(id)), "normal");
	});
}
test("unsupported providers and absent model never activate", () => {
	for (const provider of ["anthropic", "custom-openai", "azure-openai", "offline"]) {
		assert.equal(effectiveSpeedMode("ultrafast", model("gpt-6-sol", provider)), "normal");
	}
	assert.equal(effectiveSpeedMode("fast", undefined), "normal");
});

async function harness(t: TestContext, hasUI = true) {
	const root = await mkdtemp(join(tmpdir(), "pi-gpt-speed-test-"));
	const agentDir = join(root, "agent"), cwd = join(root, "workspace");
	await mkdir(cwd);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(async () => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	const hooks = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const statuses = new Map<string, string | undefined>(), notices: { text: string; type: string }[] = [];
	const ctx = {
		cwd, hasUI, mode: hasUI ? "tui" : "json", model: model("gpt-5.6-sol"),
		isProjectTrusted: () => true,
		ui: { setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
			theme: { fg: (_color: string, text: string) => text },
			notify: (text: string, type: string) => { notices.push({ text, type }); } },
	} as unknown as ExtensionContext;
	extension({ registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) => { commands.set(name, command); },
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => { hooks.set(name, handler); } } as unknown as ExtensionAPI);
	const emit = (name: string, event: unknown = {}) => hooks.get(name)!(event, ctx);
	const command = (name: string) => commands.get(name)!.handler("", ctx as ExtensionCommandContext);
	const globalPath = join(agentDir, "settings.json"), projectPath = join(cwd, ".pi", "settings.json");
	const save = async (path: string, settings: unknown) => { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, JSON.stringify(settings)); };
	return { root, ctx, commands, hooks, statuses, notices, emit, command, globalPath, projectPath, save };
}

test("registers exactly three commands, default Normal and no factory filesystem writes", async t => {
	const h = await harness(t);
	assert.deepEqual([...h.commands.keys()], ["fast", "ultrafast", "normal"]);
	assert.deepEqual(await readdir(h.root), ["workspace"]);
	await h.emit("session_start");
	assert.equal(h.statuses.get("gpt-speed"), "Speed: Normal");
	assert.deepEqual(await readdir(h.root), ["workspace"]);
});

test("commands set rather than toggle; payload is cloned, fields preserved, Normal passes through", async t => {
	const h = await harness(t); await h.emit("session_start");
	const tools = [{ type: "web_search" }];
	const payload = Object.freeze({ model: "gpt-5.6-sol", tools, service_tier: "default", stream: true });
	for (const [command, tier] of [["fast", "priority"], ["fast", "priority"], ["ultrafast", "ultrafast"]]) {
		await h.command(command);
		assert.deepEqual(h.emit("before_provider_request", { payload }), { ...payload, service_tier: tier });
		assert.equal(h.statuses.get("gpt-speed"), command === "fast" ? "Speed: Fast" : "Speed: Ultrafast");
	}
	assert.equal(payload.service_tier, "default");
	await h.command("normal");
	assert.equal(h.emit("before_provider_request", { payload }), undefined);
	assert.equal(h.statuses.get("gpt-speed"), "Speed: Normal");
});

test("Ultrafast intent survives model downgrade and inactive transitions; model_select uses event model", async t => {
	const h = await harness(t); await h.command("ultrafast");
	for (const [id, tier, label] of [
		["gpt-6-luna", "priority", "Speed: Fast (Ultrafast → Fast)"],
		["gpt-6-terra", "priority", "Speed: Fast (Ultrafast → Fast)"],
		["gpt-5.5-sol", undefined, "Speed: Normal (Ultrafast inactive)"],
		["gpt-6-astra", "ultrafast", "Speed: Ultrafast"],
		["gpt-6-sol", "ultrafast", "Speed: Ultrafast"],
	] as const) {
		const selected = model(id);
		await h.emit("model_select", { model: selected });
		assert.equal(h.statuses.get("gpt-speed"), label);
		h.ctx.model = selected;
		const result = h.emit("before_provider_request", { payload: { tools: [] } }) as Record<string, unknown> | undefined;
		assert.equal(result?.service_tier, tier);
	}
	assert.equal(JSON.parse(await readFile(h.globalPath, "utf8"))["pi-gpt-speed"].mode, "ultrafast");
	await h.emit("session_shutdown"); assert.equal(h.statuses.get("gpt-speed"), undefined);
});

test("unsupported models/providers and non-object payloads are untouched", async t => {
	const h = await harness(t); await h.command("ultrafast");
	for (const payload of [null, [], "request", 1]) assert.equal(h.emit("before_provider_request", { payload }), undefined);
	for (const selected of [model("gpt-6-other"), model("gpt-6-sol", "anthropic")]) {
		h.ctx.model = selected;
		assert.equal(h.emit("before_provider_request", { payload: { service_tier: "flex" } }), undefined);
	}
});

test("persistent global/project precedence, trust gate, reload and preservation of unrelated settings", async t => {
	const h = await harness(t);
	await h.save(h.globalPath, { theme: "dark", "pi-gpt-speed": { mode: "fast", keep: true }, "pi-codex-fast": { mode: "ultrafast" } });
	await h.save(h.projectPath, { "pi-gpt-speed": { mode: "normal" } });
	await h.emit("session_start"); assert.equal(h.statuses.get("gpt-speed"), "Speed: Normal");
	h.ctx.isProjectTrusted = () => false;
	await h.emit("session_start"); assert.equal(h.statuses.get("gpt-speed"), "Speed: Fast");
	await h.command("ultrafast");
	assert.deepEqual(JSON.parse(await readFile(h.globalPath, "utf8")), { theme: "dark", "pi-gpt-speed": { mode: "ultrafast", keep: true }, "pi-codex-fast": { mode: "ultrafast" } });
	assert.equal(JSON.parse(await readFile(h.projectPath, "utf8"))["pi-gpt-speed"].mode, "normal");
	await h.emit("session_start"); assert.equal(h.statuses.get("gpt-speed"), "Speed: Ultrafast");
	h.ctx.isProjectTrusted = () => true;
	await h.save(h.projectPath, { "pi-gpt-speed": { mode: "invalid" } });
	await h.emit("session_start"); assert.equal(h.statuses.get("gpt-speed"), "Speed: Ultrafast");
});

test("corrupt global settings are warned, not overwritten; in-memory command still works", async t => {
	const h = await harness(t); await h.save(h.globalPath, {});
	await writeFile(h.globalPath, "{invalid");
	await h.emit("session_start"); assert.equal(h.statuses.get("gpt-speed"), "Speed: Normal");
	await h.command("fast"); assert.equal(h.statuses.get("gpt-speed"), "Speed: Fast");
	assert.equal(await readFile(h.globalPath, "utf8"), "{invalid");
	assert.equal(h.notices.filter(n => n.type === "warning").length, 2);
	assert.deepEqual(await readdir(join(h.globalPath, "..")), ["settings.json"]);
});

test("project parse failure keeps valid global mode; BOM accepted; arrays cannot be overwritten", async t => {
	const h = await harness(t); await h.save(h.globalPath, {}); await h.save(h.projectPath, {});
	await writeFile(h.globalPath, '\uFEFF{"pi-gpt-speed":{"mode":"fast"}}');
	await writeFile(h.projectPath, "{invalid");
	await h.emit("session_start"); assert.equal(h.statuses.get("gpt-speed"), "Speed: Fast");
	assert.equal(h.notices.filter(n => n.type === "warning").length, 1);
	await writeFile(h.globalPath, "[]"); await h.command("normal");
	assert.equal(await readFile(h.globalPath, "utf8"), "[]");
});

test("settings lock contention warns without changing persisted settings or deleting another owner's lock", async t => {
	const h = await harness(t); await h.save(h.globalPath, { theme: "keep" });
	const release = lockfile.lockSync(h.globalPath, { realpath: false });
	try {
		await h.command("ultrafast");
		assert.equal(h.statuses.get("gpt-speed"), "Speed: Ultrafast");
		assert.deepEqual(JSON.parse(await readFile(h.globalPath, "utf8")), { theme: "keep" });
		assert.equal(lockfile.checkSync(h.globalPath, { realpath: false }), true);
		assert.ok(h.notices.some(n => n.type === "warning"));
	} finally { release(); }
	await h.command("normal");
	assert.equal(JSON.parse(await readFile(h.globalPath, "utf8"))["pi-gpt-speed"].mode, "normal");
});

test("headless and RPC requests work without footer UI operations", async t => {
	const h = await harness(t, false);
	await h.emit("session_start"); await h.command("fast");
	assert.deepEqual(h.emit("before_provider_request", { payload: {} }), { service_tier: "priority" });
	assert.equal(h.statuses.size, 0); assert.equal(h.notices.length, 0);
	h.ctx.mode = "rpc"; h.ctx.hasUI = true;
	await h.command("ultrafast"); assert.equal(h.statuses.size, 0);
	assert.ok(h.notices.some(n => n.text === "Speed: Ultrafast"));
});
