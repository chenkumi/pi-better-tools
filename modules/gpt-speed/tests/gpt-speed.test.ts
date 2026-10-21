import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import lockfile from "proper-lockfile";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import extension, { effectiveCacheTtl, effectiveSpeedMode, type SpeedMode } from "../extensions/gpt-speed.ts";

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
test("virtual selected model never activates (its physical route is unknown), even if named like a GPT model", () => {
	for (const mode of ["fast", "ultrafast"] as const) assert.equal(effectiveSpeedMode(mode, { ...model("gpt-5.7-astra"), api: "pi-virtual" }), "normal");
});
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
	const command = (name: string, args = "") => commands.get(name)!.handler(args, ctx as ExtensionCommandContext);
	const globalPath = join(agentDir, "settings.json"), projectPath = join(cwd, ".pi", "settings.json");
	const save = async (path: string, settings: unknown) => { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, JSON.stringify(settings)); };
	return { root, ctx, commands, hooks, statuses, notices, emit, command, globalPath, projectPath, save };
}

test("registers exactly five commands, default Normal and no factory filesystem writes", async t => {
	const h = await harness(t);
	assert.deepEqual([...h.commands.keys()], ["fast", "ultrafast", "normal", "cache-ttl-short", "cache-ttl-long"]);
	assert.deepEqual(await readdir(h.root), ["workspace"]);
	await h.emit("session_start");
	assert.equal(h.statuses.get("gpt-speed"), "Speed: Normal");
	assert.equal(h.statuses.get("gpt-cache"), "Cache: Short (30m)");
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

test("a command warns once when a trusted project setting will override the saved global mode", async t => {
	const h = await harness(t); await h.emit("session_start");
	await h.command("fast");
	assert.equal(h.notices.some(n => n.type === "warning"), false);
	await h.save(h.projectPath, { "pi-gpt-speed": { mode: "normal" } });
	await h.command("ultrafast"); await h.command("fast");
	const warnings = h.notices.filter(n => n.type === "warning");
	assert.equal(warnings.length, 1);
	assert.match(warnings[0].text, /project.*overrides/);
	assert.equal(JSON.parse(await readFile(h.globalPath, "utf8"))["pi-gpt-speed"].mode, "fast");
	h.ctx.isProjectTrusted = () => false; h.notices.length = 0;
	await h.emit("session_start"); await h.command("normal");
	assert.equal(h.notices.some(n => n.type === "warning"), false);
});

test("a lock held briefly by another process is retried instead of dropping the setting", async t => {
	const h = await harness(t); await h.save(h.globalPath, { theme: "keep" });
	const script = `const l=require("proper-lockfile");const r=l.lockSync(process.argv[1],{realpath:false});process.stdout.write("held");setTimeout(()=>{r();},80);`;
	const child = spawn(process.execPath, ["-e", script, h.globalPath], { stdio: ["ignore", "pipe", "inherit"], cwd: process.cwd() });
	const exited = new Promise(resolve => child.once("exit", resolve));
	await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", () => reject(new Error("lock holder exited early"))); child.stdout.once("data", () => resolve()); });
	await h.command("fast");
	await exited;
	assert.deepEqual(h.notices.filter(n => n.type === "warning"), []);
	assert.equal(JSON.parse(await readFile(h.globalPath, "utf8"))["pi-gpt-speed"].mode, "fast");
});

test("transient ELOCKED retries synchronously and merges settings after lock acquisition", async t => {
	const h = await harness(t); await h.save(h.globalPath, { theme: "before" });
	const original = lockfile.lockSync;
	let attempts = 0;
	const waits: number[] = [];
	t.mock.method(Atomics, "wait", (_array: unknown, _index: number, _value: number, ms: number) => { waits.push(ms); return "timed-out"; });
	t.mock.method(lockfile, "lockSync", (path: string, options: Parameters<typeof original>[1]) => {
		attempts++;
		if (attempts <= 2) throw Object.assign(new Error("busy"), { code: "ELOCKED" });
		fs.writeFileSync(h.globalPath, JSON.stringify({ theme: "updated by other owner" }));
		return original(path, options);
	});
	await h.command("fast");
	assert.equal(attempts, 3);
	assert.deepEqual(waits, [20, 20]);
	assert.deepEqual(h.notices.filter(n => n.type === "warning"), []);
	assert.deepEqual(JSON.parse(await readFile(h.globalPath, "utf8")), { theme: "updated by other owner", "pi-gpt-speed": { mode: "fast" } });
	assert.equal(lockfile.checkSync(h.globalPath, { realpath: false }), false);
});

test("lock retries stop after ten attempts and do not retry non-contention errors", async t => {
	const h = await harness(t); await h.save(h.globalPath, { theme: "keep" });
	const waits: number[] = [];
	t.mock.method(Atomics, "wait", (_array: unknown, _index: number, _value: number, ms: number) => { waits.push(ms); return "timed-out"; });
	for (const [code, expectedAttempts] of [["ELOCKED", 10], ["EACCES", 1]] as const) {
		let attempts = 0;
		const mock = t.mock.method(lockfile, "lockSync", () => { attempts++; throw Object.assign(new Error(code), { code }); });
		waits.length = 0; h.notices.length = 0;
		await h.command("fast");
		mock.mock.restore();
		assert.equal(attempts, expectedAttempts);
		assert.deepEqual(waits, Array(expectedAttempts - 1).fill(20));
		assert.equal(h.notices.filter(n => n.type === "warning").length, 1);
		assert.deepEqual(JSON.parse(await readFile(h.globalPath, "utf8")), { theme: "keep" });
		assert.deepEqual(await readdir(join(h.globalPath, "..")), ["settings.json"]);
	}
});

test("saving keeps a symlinked settings file and the original permissions", async t => {
	const h = await harness(t);
	const real = join(h.root, "real-settings.json");
	await writeFile(real, JSON.stringify({ theme: "keep" }), { mode: 0o640 });
	await mkdir(join(h.globalPath, ".."), { recursive: true });
	try { await symlink(real, h.globalPath); } catch (error) { t.skip(`symlink unavailable: ${(error as Error).message}`); return; }
	await h.command("fast");
	assert.ok((await lstat(h.globalPath)).isSymbolicLink());
	assert.deepEqual(JSON.parse(await readFile(real, "utf8")), { theme: "keep", "pi-gpt-speed": { mode: "fast" } });
	if (process.platform !== "win32") assert.equal((await stat(real)).mode & 0o777, 0o640);
});

test("settings realpath and stat errors fail closed instead of replacing settings", async t => {
	const h = await harness(t); await h.save(h.globalPath, { theme: "keep" });
	for (const name of ["realpathSync", "statSync"] as const) {
		const original = fs[name];
		const mock = t.mock.method(fs, name, (...args: unknown[]) => {
			if (args[0] === h.globalPath) throw Object.assign(new Error(`${name} denied`), { code: "EACCES" });
			return (original as (...args: unknown[]) => unknown)(...args);
		});
		syncBuiltinESMExports();
		t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
		h.notices.length = 0;
		try {
			await h.command("fast");
			assert.equal(h.notices.filter(n => n.type === "warning").length, 1);
			assert.deepEqual(JSON.parse(await readFile(h.globalPath, "utf8")), { theme: "keep" });
			assert.deepEqual(await readdir(join(h.globalPath, "..")), ["settings.json"]);
		} finally { mock.mock.restore(); syncBuiltinESMExports(); }
	}
});

test("a dangling settings symlink is not replaced", async t => {
	const h = await harness(t);
	const missing = join(h.root, "missing-settings.json");
	await mkdir(join(h.globalPath, ".."), { recursive: true });
	try { await symlink(missing, h.globalPath); } catch (error) { t.skip(`symlink unavailable: ${(error as Error).message}`); return; }
	await h.command("fast");
	assert.ok((await lstat(h.globalPath)).isSymbolicLink());
	await assert.rejects(readFile(missing), { code: "ENOENT" });
	assert.equal(h.notices.filter(n => n.type === "warning").length, 1);
	assert.deepEqual(await readdir(join(h.globalPath, "..")), ["settings.json"]);
});

test("permission restoration is not filtered by the process umask", async t => {
	const h = await harness(t); await h.save(h.globalPath, { theme: "keep" });
	const chmod = t.mock.method(fs, "chmodSync");
	syncBuiltinESMExports();
	t.after(() => { chmod.mock.restore(); syncBuiltinESMExports(); });
	const previous = process.umask(0o077);
	try {
		const mode = (await stat(h.globalPath)).mode & 0o777;
		await h.command("fast");
		assert.equal(chmod.mock.callCount(), 1);
		assert.equal(chmod.mock.calls[0].arguments[1], mode);
		if (process.platform !== "win32") assert.equal((await stat(h.globalPath)).mode & 0o777, mode);
		assert.deepEqual(h.notices.filter(n => n.type === "warning"), []);
	} finally { process.umask(previous); }
});

// --- Prompt cache lifetime: short = 30m (API default, request untouched), long = 12h (`prompt_cache_options.ttl`) ---
const responses = (id: string, provider = "openai", api = "openai-responses") => ({ id, provider, api }) as Model;

test("long cache sends ttl 12h only for openai Responses-API GPT >= 5.6 models; short, default and other routes never inject", () => {
	for (const version of ["5.6", "5.10", "6", "6.1"]) for (const name of names) {
		assert.equal(effectiveCacheTtl("long", responses(`gpt-${version}-${name}`)), "12h");
		assert.equal(effectiveCacheTtl("short", responses(`gpt-${version}-${name}`)), undefined, "short is the API default: nothing to send");
	}
	assert.equal(effectiveCacheTtl("long", responses("gpt-6-sol", "openai-codex", "openai-codex-responses")), undefined);
	assert.equal(effectiveCacheTtl("long", responses("gpt-6-sol", "openai", "openai-completions")), undefined);
	assert.equal(effectiveCacheTtl("long", responses("gpt-6-sol", "openai", "pi-virtual")), undefined);
	assert.equal(effectiveCacheTtl("long", responses("gpt-6-sol", "anthropic")), undefined);
	assert.equal(effectiveCacheTtl("long", responses("gpt-5.5-sol")), undefined);
	assert.equal(effectiveCacheTtl("long", responses("gpt-6-sol\n")), undefined);
	assert.equal(effectiveCacheTtl("long", model("gpt-6-sol")), undefined, "a model without a documented Responses api is not guessed");
	assert.equal(effectiveCacheTtl("long", undefined), undefined);
	assert.equal(effectiveCacheTtl(undefined, responses("gpt-6-sol")), undefined);
});

test("long cache is merged into prompt_cache_options without dropping existing fields or mutating the payload", async t => {
	const h = await harness(t); await h.emit("session_start");
	h.ctx.model = responses("gpt-6-sol");
	const payload = Object.freeze({ model: "gpt-6-sol", prompt_cache_key: "k", prompt_cache_options: Object.freeze({ mode: "explicit", ttl: "30m" }), stream: true });
	assert.equal(h.emit("before_provider_request", { payload }), undefined, "default leaves the request alone");
	await h.command("cache-ttl-long");
	assert.deepEqual(h.emit("before_provider_request", { payload }), { ...payload, prompt_cache_options: { mode: "explicit", ttl: "12h" } });
	assert.deepEqual(h.emit("before_provider_request", { payload: { model: "gpt-6-sol" } }), { model: "gpt-6-sol", prompt_cache_options: { ttl: "12h" } });
	assert.deepEqual(h.emit("before_provider_request", { payload: { prompt_cache_options: "bogus" } }), { prompt_cache_options: { ttl: "12h" } });
	assert.deepEqual(payload.prompt_cache_options, { mode: "explicit", ttl: "30m" });
	for (const bad of [null, [], "request", 1]) assert.equal(h.emit("before_provider_request", { payload: bad }), undefined);
	await h.command("cache-ttl-short");
	assert.equal(h.emit("before_provider_request", { payload }), undefined, "short stops injecting");
	await h.command("cache-ttl-long");
	h.ctx.model = responses("gpt-5.5-sol");
	assert.equal(h.emit("before_provider_request", { payload: { x: 1 } }), undefined);
});

test("speed tier and long cache combine in one payload and stay independent", async t => {
	const h = await harness(t); await h.emit("session_start");
	h.ctx.model = responses("gpt-6-sol");
	await h.command("fast"); await h.command("cache-ttl-long");
	assert.deepEqual(h.emit("before_provider_request", { payload: { stream: true } }), { stream: true, service_tier: "priority", prompt_cache_options: { ttl: "12h" } });
	await h.command("normal");
	assert.deepEqual(h.emit("before_provider_request", { payload: { stream: true } }), { stream: true, prompt_cache_options: { ttl: "12h" } });
	await h.command("cache-ttl-short");
	assert.equal(h.emit("before_provider_request", { payload: { stream: true } }), undefined);
});

test("/cache-ttl-short and /cache-ttl-long set rather than toggle, ignore arguments, and persist only short or long", async t => {
	const h = await harness(t); await h.emit("session_start");
	assert.equal(h.statuses.get("gpt-cache"), "Cache: Short (30m)");
	await assert.rejects(readFile(h.globalPath, "utf8"), { code: "ENOENT" });
	await h.save(h.globalPath, { theme: "dark", "pi-gpt-speed": { mode: "fast", keep: true } });
	await h.command("cache-ttl-long");
	assert.equal(h.notices.at(-1)!.text, "Cache: Long (12h, inactive)", "the default test model is not a Responses-API model");
	assert.equal(h.statuses.get("gpt-cache"), "Cache: Long (12h, inactive)");
	assert.deepEqual(JSON.parse(await readFile(h.globalPath, "utf8")), { theme: "dark", "pi-gpt-speed": { mode: "fast", keep: true, cache: "long" } });
	await h.command("cache-ttl-long", "ignored extra text");
	assert.deepEqual(JSON.parse(await readFile(h.globalPath, "utf8"))["pi-gpt-speed"], { mode: "fast", keep: true, cache: "long" }, "repeating a command is idempotent");
	await h.command("cache-ttl-short");
	assert.equal(h.notices.at(-1)!.text, "Cache: Short (30m)");
	assert.deepEqual(JSON.parse(await readFile(h.globalPath, "utf8")), { theme: "dark", "pi-gpt-speed": { mode: "fast", keep: true, cache: "short" } });
	await h.command("cache-ttl-long");
	await h.command("normal");
	assert.deepEqual(JSON.parse(await readFile(h.globalPath, "utf8"))["pi-gpt-speed"], { mode: "normal", keep: true, cache: "long" }, "setting the speed keeps the cache setting");
	assert.ok(!h.commands.has("cache-ttl"), "the argument-taking command is gone");
});

test("TUI status shows the configured cache lifetime and whether long is active for the selected model", async t => {
	const h = await harness(t); await h.emit("session_start");
	h.ctx.model = responses("gpt-6-sol");
	assert.equal(h.statuses.get("gpt-cache"), "Cache: Short (30m)");
	await h.command("cache-ttl-long");
	assert.equal(h.statuses.get("gpt-cache"), "Cache: Long (12h)");
	await h.emit("model_select", { model: responses("gpt-5.5-sol") });
	assert.equal(h.statuses.get("gpt-cache"), "Cache: Long (12h, inactive)");
	await h.emit("model_select", { model: responses("gpt-6-sol", "openai-codex", "openai-codex-responses") });
	assert.equal(h.statuses.get("gpt-cache"), "Cache: Long (12h, inactive)");
	await h.emit("model_select", { model: responses("gpt-6-luna") });
	assert.equal(h.statuses.get("gpt-cache"), "Cache: Long (12h)");
	await h.command("cache-ttl-short");
	assert.equal(h.statuses.get("gpt-cache"), "Cache: Short (30m)");
	await h.emit("session_shutdown");
	assert.equal(h.statuses.get("gpt-cache"), undefined);
});

test("cache setting follows the same global/project precedence, trust gate and invalid-value handling as the speed mode", async t => {
	const h = await harness(t);
	h.ctx.model = responses("gpt-6-sol");
	await h.save(h.globalPath, { "pi-gpt-speed": { cache: "short" } });
	await h.save(h.projectPath, { "pi-gpt-speed": { cache: "long" } });
	await h.emit("session_start"); assert.equal(h.statuses.get("gpt-cache"), "Cache: Long (12h)", "trusted project overrides global");
	h.ctx.isProjectTrusted = () => false;
	await h.emit("session_start"); assert.equal(h.statuses.get("gpt-cache"), "Cache: Short (30m)", "untrusted project is ignored");
	h.ctx.isProjectTrusted = () => true;
	await h.save(h.globalPath, { "pi-gpt-speed": { cache: "long" } });
	await h.save(h.projectPath, { "pi-gpt-speed": { cache: "12h" } });
	await h.emit("session_start"); assert.equal(h.statuses.get("gpt-cache"), "Cache: Long (12h)", "an unsupported project value falls back to the global one");
	await h.save(h.globalPath, { "pi-gpt-speed": { cache: "bogus" } });
	await h.emit("session_start"); assert.equal(h.statuses.get("gpt-cache"), "Cache: Short (30m)");
});

test("/cache-ttl-long warns once when a trusted project setting will override the saved global value", async t => {
	const h = await harness(t); await h.emit("session_start");
	await h.save(h.projectPath, { "pi-gpt-speed": { cache: "short" } });
	await h.command("cache-ttl-long");
	assert.equal(JSON.parse(await readFile(h.globalPath, "utf8"))["pi-gpt-speed"].cache, "long");
	const warnings = () => h.notices.filter(n => n.type === "warning" && /overrides/.test(n.text));
	assert.equal(warnings().length, 1); assert.match(warnings()[0].text, /pi-gpt-speed\.cache/);
	await h.command("cache-ttl-short");
	assert.equal(warnings().length, 1);
});

test("a corrupt global settings file is warned about and not overwritten when setting the cache lifetime", async t => {
	const h = await harness(t);
	await mkdir(join(h.globalPath, ".."), { recursive: true }); await writeFile(h.globalPath, "{ not json");
	await h.emit("session_start");
	h.ctx.model = responses("gpt-6-sol");
	await h.command("cache-ttl-long");
	assert.equal(await readFile(h.globalPath, "utf8"), "{ not json");
	assert.ok(h.notices.some(n => n.type === "warning" && /save/.test(n.text)));
	assert.deepEqual(h.emit("before_provider_request", { payload: {} }), { prompt_cache_options: { ttl: "12h" } }, "the in-memory value stays active");
});
