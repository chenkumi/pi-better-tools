import { ulid } from "ulid";
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const SPEED_MODES = ["normal", "fast", "ultrafast"] as const;
export type SpeedMode = (typeof SPEED_MODES)[number];
/**
 * Prompt-cache lifetime for GPT-5.6+ on the OpenAI Responses API. The API accepts only `prompt_cache_options.ttl` of "30m"
 * (its default, `short`) or "12h" (`long`); any other value returns 400, so no free-form durations are offered.
 */
export type CacheLifetime = "short" | "long";
const CACHE_LIFETIMES: readonly CacheLifetime[] = ["short", "long"];
const LONG_CACHE_TTL = "12h";
type SpeedModel = Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id"> & { api?: string };
/** Documented `api` of virtual catalog entries (docs/virtual-models.md); the physical route is not exposed to extensions. */
const VIRTUAL_MODEL_API = "pi-virtual";
const SETTINGS_KEY = "pi-gpt-speed";
const STATUS_KEY = "gpt-speed";
const CACHE_STATUS_KEY = "gpt-cache";
/** The documented `prompt_cache_options` lives on the Responses API; other routes (including the Codex backend) are not guessed. */
const CACHE_TTL_API = "openai-responses";
/**
 * `/cache-ttl-short` and `/cache-ttl-long` are disabled: testing showed the Responses `prompt_cache_options.ttl` request is not
 * usable yet. While false nothing is registered or written, the footer shows no `Cache:` item and no `ttl` is sent; the helpers
 * and the settings key stay so the feature can be re-enabled by flipping this. An explicit `boolean` keeps the gated code reachable.
 */
const CACHE_TTL_ENABLED: boolean = false;
const MODEL_PATTERN = /^gpt-(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?-(luna|terra|sol|astra)$/;
const LABELS = { normal: "Normal", fast: "Fast", ultrafast: "Ultrafast" } as const;

/** Versions are major/minor components, not decimals: 5.10 >= 5.6; 6 means 6.0. Returns the model family name, or undefined. */
function speedModelFamily(model: SpeedModel): string | undefined {
	const match = MODEL_PATTERN.exec(model.id);
	// JS $ also matches before a trailing newline; require an exact full ID.
	if (!match || match[0] !== model.id) return undefined;
	const major = BigInt(match[1]), minor = BigInt(match[2] ?? "0");
	if (major < 5n || (major === 5n && minor < 6n)) return undefined;
	return match[3];
}

export function effectiveSpeedMode(mode: SpeedMode, model: SpeedModel | undefined): SpeedMode {
	// A virtual model's name says nothing about the physical model that receives the request; never inject for it.
	if (mode === "normal" || !model || model.api === VIRTUAL_MODEL_API || !["openai", "openai-codex"].includes(model.provider)) return "normal";
	const family = speedModelFamily(model);
	if (!family) return "normal";
	if (mode === "ultrafast" && (family === "luna" || family === "terra")) return "fast";
	return mode;
}

/** The `ttl` sent for `model`: only `long` changes the request (short is the API default); undefined leaves it to Pi/OpenAI. */
export function effectiveCacheTtl(cache: CacheLifetime | undefined, model: SpeedModel | undefined): typeof LONG_CACHE_TTL | undefined {
	if (cache !== "long" || !model || model.provider !== "openai" || model.api !== CACHE_TTL_API) return undefined;
	return speedModelFamily(model) ? LONG_CACHE_TTL : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : undefined;
}

function readSettings(path: string): Record<string, unknown> {
	let content: string;
	try { content = readFileSync(path, "utf8"); }
	catch (error) {
		if (asObject(error)?.code === "ENOENT") return {};
		throw error;
	}
	const settings = asObject(JSON.parse(content.replace(/^\uFEFF/, "")));
	if (!settings) throw new Error(`Expected a settings object: ${path}`);
	return settings;
}

/** What the speed commands write (and `/cache-ttl-*` would write once enabled); omitted fields are left as they are. */
interface SettingsPatch { mode?: SpeedMode; cache?: CacheLifetime }

/** The valid `pi-gpt-speed` values in one settings file; invalid or missing values are undefined. */
function storedValues(settings: Record<string, unknown>): SettingsPatch {
	const section = asObject(settings[SETTINGS_KEY]);
	return {
		mode: SPEED_MODES.find(allowed => allowed === section?.mode),
		cache: CACHE_LIFETIMES.find(allowed => allowed === section?.cache),
	};
}

const RETRY_ATTEMPTS = 10;
const RETRY_DELAY_MS = 20;
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Run `operation`, retrying briefly while it fails with one of `retryableCodes`. */
function withSyncRetry<T>(retryableCodes: readonly string[], operation: () => T): T {
	for (let attempt = 1; ; attempt++) {
		try { return operation(); }
		catch (error) {
			const code = asObject(error)?.code;
			if (typeof code !== "string" || !retryableCodes.includes(code) || attempt >= RETRY_ATTEMPTS) throw error;
			sleepSync(RETRY_DELAY_MS);
		}
	}
}

/** Like the host settings manager: a few short retries while another process holds the lock. */
const lockWithRetry = (path: string) => withSyncRetry(["ELOCKED"], () => lockfile.lockSync(path, { realpath: false }));

/** Windows may transiently lock the target; retry the rename briefly. */
const renameWithRetry = (from: string, to: string) => withSyncRetry(["EPERM", "EBUSY", "EACCES"], () => renameSync(from, to));

/** Share Pi's settings lock; read/merge/write synchronously so no same-process await holds it. */
function persistSettings(path: string, patch: SettingsPatch): void {
	mkdirSync(dirname(path), { recursive: true });
	// Pi's FileSettingsStorage locks the lexical settings path with realpath=false. Use the same lock identity
	// (resolved before any symlink target) so a symlinked settings.json cannot split the two writers' locks.
	const release = lockWithRetry(resolve(path));
	try {
		persistLocked(path, patch);
	} finally { release(); }
}

function persistLocked(path: string, patch: SettingsPatch): void {
	// Follow a symlinked settings.json so the rename replaces its target, not the link itself.
	let target: string;
	try { target = realpathSync(path); }
	catch (error) {
		if (asObject(error)?.code !== "ENOENT") throw error;
		// ENOENT may be a dangling symlink, not a new file. Never replace that link.
		try {
			if (lstatSync(path).isSymbolicLink()) throw error;
		} catch (statError) {
			if (statError === error || asObject(statError)?.code !== "ENOENT") throw statError;
		}
		target = join(realpathSync(dirname(path)), "settings.json");
	}
	const temp = `${target}.${ulid().toUpperCase()}.tmp`;
	try {
		// Read permissions under the same lock as the settings, not before waiting for it.
		let fileMode = 0o600;
		try { fileMode = statSync(target).mode & 0o777; }
		catch (error) { if (asObject(error)?.code !== "ENOENT") throw error; }
		const settings = readSettings(target);
		const section = { ...asObject(settings[SETTINGS_KEY]) };
		if (patch.mode !== undefined) section.mode = patch.mode;
		if (patch.cache !== undefined) section.cache = patch.cache;
		settings[SETTINGS_KEY] = section;
		writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: fileMode });
		// Creation mode is filtered by umask; explicitly restore an existing file's permissions.
		chmodSync(temp, fileMode);
		renameWithRetry(temp, target);
	} finally {
		rmSync(temp, { force: true });
	}
}

export default function gptSpeedExtension(pi: ExtensionAPI): void {
	let mode: SpeedMode = "normal";
	let cache: CacheLifetime = "short";
	const projectOverrideNoticed = new Set<"mode" | "cache">();
	const globalPath = () => join(getAgentDir(), "settings.json");

	const projectPath = (ctx: ExtensionContext) => join(ctx.cwd, ".pi", "settings.json");

	/** Trusted project-level values, if any; unreadable settings count as absent here (session_start already warns). */
	function projectSettings(ctx: ExtensionContext): SettingsPatch {
		if (!ctx.isProjectTrusted()) return {};
		try { return storedValues(readSettings(projectPath(ctx))); }
		catch { return {}; }
	}

	function statusLabel(model: SpeedModel | undefined): string {
		const effective = effectiveSpeedMode(mode, model);
		if (effective === mode) return `Speed: ${LABELS[effective]}`;
		return effective === "normal"
			? `Speed: Normal (${LABELS[mode]} inactive)`
			: "Speed: Fast (Ultrafast → Fast)";
	}

	function cacheLabel(model: SpeedModel | undefined): string {
		if (cache === "short") return "Cache: Short (30m)";
		return effectiveCacheTtl(cache, model) ? "Cache: Long (12h)" : "Cache: Long (12h, inactive)";
	}

	function updateStatus(ctx: ExtensionContext, model = ctx.model): void {
		if (ctx.mode !== "tui") return;
		const effective = effectiveSpeedMode(mode, model);
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(effective === "normal" ? "muted" : "accent", statusLabel(model)));
		if (CACHE_TTL_ENABLED) ctx.ui.setStatus(CACHE_STATUS_KEY, ctx.ui.theme.fg(effectiveCacheTtl(cache, model) ? "accent" : "muted", cacheLabel(model)));
	}

	function warn(ctx: ExtensionContext, action: string, error: unknown): void {
		report(ctx, `pi-gpt-speed: failed to ${action}: ${error instanceof Error ? error.message : String(error)}`);
	}

	function report(ctx: ExtensionContext, message: string, type: "info" | "warning" = "warning"): void {
		if (ctx.hasUI) ctx.ui.notify(message, type);
		else if (type === "warning") console.error(message);
	}

	/** A trusted project value wins at the next session start, so say once per key that the saved global value is shadowed. */
	function noticeProjectOverride(ctx: ExtensionContext, key: "mode" | "cache", command: string): void {
		if (projectOverrideNoticed.has(key) || projectSettings(ctx)[key] === undefined) return;
		projectOverrideNoticed.add(key);
		report(ctx, `pi-gpt-speed: this project's .pi/settings.json sets ${SETTINGS_KEY}.${key}, which overrides the global setting saved by /${command} the next time a session starts.`);
	}

	for (const selected of ["fast", "ultrafast", "normal"] as const) {
		pi.registerCommand(selected, {
			description: `Set GPT speed to ${LABELS[selected]}`,
			handler: async (_args, ctx) => {
				mode = selected;
				updateStatus(ctx);
				if (ctx.hasUI) ctx.ui.notify(statusLabel(ctx.model), "info");
				try { persistSettings(globalPath(), { mode: selected }); }
				catch (error) { warn(ctx, "save speed settings (current mode remains active)", error); }
				noticeProjectOverride(ctx, "mode", selected);
			},
		});
	}

	if (CACHE_TTL_ENABLED) {
		for (const selected of CACHE_LIFETIMES) {
			pi.registerCommand(`cache-ttl-${selected}`, {
				description: selected === "long"
					? "Set the OpenAI prompt cache lifetime to long (12h, GPT-5.6+ Responses API)"
					: "Set the OpenAI prompt cache lifetime to short (30m, the API default)",
				handler: async (_args, ctx) => {
					cache = selected;
					updateStatus(ctx);
					report(ctx, cacheLabel(ctx.model), "info");
					try { persistSettings(globalPath(), { cache: selected }); }
					catch (error) { warn(ctx, "save cache setting (current value remains active)", error); }
					noticeProjectOverride(ctx, "cache", `cache-ttl-${selected}`);
				},
			});
		}
	}

	pi.on("session_start", (_event, ctx) => {
		mode = "normal";
		cache = "short";
		projectOverrideNoticed.clear();
		try {
			const stored = storedValues(readSettings(globalPath()));
			mode = stored.mode ?? mode;
			cache = stored.cache ?? cache;
		} catch (error) { warn(ctx, "load global speed settings", error); }
		if (ctx.isProjectTrusted()) {
			try {
				const stored = storedValues(readSettings(projectPath(ctx)));
				mode = stored.mode ?? mode;
				cache = stored.cache ?? cache;
			} catch (error) { warn(ctx, "load project speed settings", error); }
		}
		updateStatus(ctx);
	});

	pi.on("model_select", (event, ctx) => updateStatus(ctx, event.model));
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setStatus(CACHE_STATUS_KEY, undefined);
	});
	pi.on("before_provider_request", (event, ctx) => {
		const effective = effectiveSpeedMode(mode, ctx.model);
		const ttl = CACHE_TTL_ENABLED ? effectiveCacheTtl(cache, ctx.model) : undefined;
		if (effective === "normal" && !ttl) return;
		const payload = asObject(event.payload);
		if (!payload) return;
		const next: Record<string, unknown> = { ...payload };
		if (effective !== "normal") next.service_tier = effective === "fast" ? "priority" : "ultrafast";
		// Keep Pi's own fields (e.g. `mode`); only the lifetime is ours.
		if (ttl) next.prompt_cache_options = { ...asObject(payload.prompt_cache_options), ttl };
		return next;
	});
}
