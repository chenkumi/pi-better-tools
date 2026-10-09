import { ulid } from "ulid";
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export type SpeedMode = "normal" | "fast" | "ultrafast";
type SpeedModel = Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id">;
const SETTINGS_KEY = "pi-gpt-speed";
const STATUS_KEY = "gpt-speed";
const MODEL_PATTERN = /^gpt-(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?-(luna|terra|sol|astra)$/;
const LABELS = { normal: "Normal", fast: "Fast", ultrafast: "Ultrafast" } as const;

/** Versions are major/minor components, not decimals: 5.10 >= 5.6; 6 means 6.0. */
export function effectiveSpeedMode(mode: SpeedMode, model: SpeedModel | undefined): SpeedMode {
	if (mode === "normal" || !model || !["openai", "openai-codex"].includes(model.provider)) return "normal";
	const match = MODEL_PATTERN.exec(model.id);
	// JS $ also matches before a trailing newline; require an exact full ID.
	if (!match || match[0] !== model.id) return "normal";
	const major = BigInt(match[1]), minor = BigInt(match[2] ?? "0");
	if (major < 5n || (major === 5n && minor < 6n)) return "normal";
	if (mode === "ultrafast" && (match[3] === "luna" || match[3] === "terra")) return "fast";
	return mode;
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

function storedMode(settings: Record<string, unknown>): SpeedMode | undefined {
	const mode = asObject(settings[SETTINGS_KEY])?.mode;
	return mode === "normal" || mode === "fast" || mode === "ultrafast" ? mode : undefined;
}

const LOCK_ATTEMPTS = 10;
const LOCK_RETRY_MS = 20;
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Like the host settings manager: a few short retries while another process holds the lock. */
function lockWithRetry(path: string): () => void {
	for (let attempt = 1; ; attempt++) {
		try { return lockfile.lockSync(path, { realpath: false }); }
		catch (error) {
			if (asObject(error)?.code !== "ELOCKED" || attempt >= LOCK_ATTEMPTS) throw error;
			sleepSync(LOCK_RETRY_MS);
		}
	}
}

/** Windows may transiently lock the target; retry the rename briefly. */
function renameWithRetry(from: string, to: string): void {
	for (let attempt = 1; ; attempt++) {
		try { return renameSync(from, to); }
		catch (error) {
			const code = asObject(error)?.code;
			if ((code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") || attempt >= LOCK_ATTEMPTS) throw error;
			sleepSync(LOCK_RETRY_MS);
		}
	}
}

/** Share Pi's settings lock; read/merge/write synchronously so no same-process await holds it. */
function persistMode(path: string, mode: SpeedMode): void {
	mkdirSync(dirname(path), { recursive: true });
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
	const release = lockWithRetry(target);
	const temp = `${target}.${ulid().toUpperCase()}.tmp`;
	try {
		// Read permissions under the same lock as the settings, not before waiting for it.
		let fileMode = 0o600;
		try { fileMode = statSync(target).mode & 0o777; }
		catch (error) { if (asObject(error)?.code !== "ENOENT") throw error; }
		const settings = readSettings(target);
		settings[SETTINGS_KEY] = { ...asObject(settings[SETTINGS_KEY]), mode };
		writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: fileMode });
		// Creation mode is filtered by umask; explicitly restore an existing file's permissions.
		chmodSync(temp, fileMode);
		renameWithRetry(temp, target);
	} finally {
		try { rmSync(temp, { force: true }); }
		finally { release(); }
	}
}

export default function gptSpeedExtension(pi: ExtensionAPI): void {
	let mode: SpeedMode = "normal";
	let projectOverrideNoticed = false;
	const globalPath = () => join(getAgentDir(), "settings.json");

	/** Trusted project-level mode, if any; unreadable settings count as absent here (session_start already warns). */
	function projectMode(ctx: ExtensionContext): SpeedMode | undefined {
		if (!ctx.isProjectTrusted()) return undefined;
		try { return storedMode(readSettings(join(ctx.cwd, ".pi", "settings.json"))); }
		catch { return undefined; }
	}

	function statusLabel(model: SpeedModel | undefined): string {
		const effective = effectiveSpeedMode(mode, model);
		if (effective === mode) return `Speed: ${LABELS[effective]}`;
		return effective === "normal"
			? `Speed: Normal (${LABELS[mode]} inactive)`
			: "Speed: Fast (Ultrafast → Fast)";
	}

	function updateStatus(ctx: ExtensionContext, model = ctx.model): void {
		if (ctx.mode !== "tui") return;
		const effective = effectiveSpeedMode(mode, model);
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(effective === "normal" ? "muted" : "accent", statusLabel(model)));
	}

	function warn(ctx: ExtensionContext, action: string, error: unknown): void {
		const message = `pi-gpt-speed: failed to ${action}: ${error instanceof Error ? error.message : String(error)}`;
		if (ctx.hasUI) ctx.ui.notify(message, "warning");
		else console.error(message);
	}

	for (const selected of ["fast", "ultrafast", "normal"] as const) {
		pi.registerCommand(selected, {
			description: `Set GPT speed to ${LABELS[selected]}`,
			handler: async (_args, ctx) => {
				mode = selected;
				updateStatus(ctx);
				if (ctx.hasUI) ctx.ui.notify(statusLabel(ctx.model), "info");
				try { persistMode(globalPath(), selected); }
				catch (error) { warn(ctx, "save speed settings (current mode remains active)", error); }
				if (!projectOverrideNoticed && projectMode(ctx) !== undefined) {
					projectOverrideNoticed = true;
					const message = `pi-gpt-speed: this project's .pi/settings.json sets ${SETTINGS_KEY}.mode, which overrides the global setting saved by /${selected} the next time a session starts.`;
					if (ctx.hasUI) ctx.ui.notify(message, "warning");
					else console.error(message);
				}
			},
		});
	}

	pi.on("session_start", (_event, ctx) => {
		mode = "normal";
		projectOverrideNoticed = false;
		try { mode = storedMode(readSettings(globalPath())) ?? "normal"; }
		catch (error) { warn(ctx, "load global speed settings", error); }
		if (ctx.isProjectTrusted()) {
			try { mode = storedMode(readSettings(join(ctx.cwd, ".pi", "settings.json"))) ?? mode; }
			catch (error) { warn(ctx, "load project speed settings", error); }
		}
		updateStatus(ctx);
	});

	pi.on("model_select", (event, ctx) => updateStatus(ctx, event.model));
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
	});
	pi.on("before_provider_request", (event, ctx) => {
		const effective = effectiveSpeedMode(mode, ctx.model);
		if (effective === "normal") return;
		const payload = asObject(event.payload);
		if (!payload) return;
		return { ...payload, service_tier: effective === "fast" ? "priority" : "ultrafast" };
	});
}
