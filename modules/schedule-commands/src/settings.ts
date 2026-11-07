/**
 * Settings: user level `<agentDir>/schedule-commands-settings.json` as defaults, project level
 * `<cwd>/.pi/schedule-commands-settings.json` on top (read only for a trusted project). Strict: unknown keys and bad
 * values are errors, and a bad file never falls back to defaults silently. Only the settings panel writes (later phase).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineSettings } from "./engine.ts";
import { DEFAULT_ENGINE_SETTINGS } from "./engine.ts";
import { DEFAULT_TAIL_BYTES } from "./shell-run.ts";
import type { MissedPolicy } from "./types.ts";

export type JobScope = "session" | "workdir";
export interface ScheduleSettings extends EngineSettings {
	panelVisible: boolean;
	defaultJobScope: JobScope;
	commandOutputTailBytes: number;
}
export const DEFAULT_SETTINGS: ScheduleSettings = { ...DEFAULT_ENGINE_SETTINGS, panelVisible: true, defaultJobScope: "session", commandOutputTailBytes: DEFAULT_TAIL_BYTES };

export class SettingsError extends Error {}

const SPEC: Record<keyof ScheduleSettings, (value: unknown) => unknown> = {
	panelVisible: bool("panelVisible"),
	defaultJobScope: oneOf("defaultJobScope", ["session", "workdir"]),
	defaultMissed: oneOf("defaultMissed", ["skip", "run-once", "run-all"] satisfies MissedPolicy[]),
	defaultMaxLateMs: int("defaultMaxLateMs", 0, 7 * 24 * 3_600_000),
	maxCatchUp: int("maxCatchUp", 1, 100),
	allowShellRunAll: bool("allowShellRunAll"),
	maxConcurrentAgents: int("maxConcurrentAgents", 1, 16),
	maxConcurrentCommands: int("maxConcurrentCommands", 1, 16),
	commandOutputTailBytes: int("commandOutputTailBytes", 1024, 1024 * 1024),
};

function bool(key: string) { return (v: unknown) => { if (typeof v !== "boolean") throw new SettingsError(`${key} must be true or false`); return v; }; }
function int(key: string, min: number, max: number) { return (v: unknown) => { if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new SettingsError(`${key} must be an integer from ${min} to ${max}`); return v; }; }
function oneOf(key: string, values: string[]) { return (v: unknown) => { if (typeof v !== "string" || !values.includes(v)) throw new SettingsError(`${key} must be one of ${values.join(", ")}`); return v; }; }

/** Parse one settings file's JSON text; every key must be known and valid. */
export function parseSettings(text: string): Partial<ScheduleSettings> {
	let raw: unknown;
	try { raw = JSON.parse(text); } catch { throw new SettingsError("the settings file is not valid JSON"); }
	return parseSettingsObject(raw);
}

/** Same rules for an already parsed document (the settings panel validates what it is about to write). */
export function parseSettingsObject(raw: unknown): Partial<ScheduleSettings> {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new SettingsError("the settings file must be a JSON object");
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		const check = (SPEC as Record<string, ((v: unknown) => unknown) | undefined>)[key];
		if (!check) throw new SettingsError(`${key} is not a known setting`);
		out[key] = check(value);
	}
	return out as Partial<ScheduleSettings>;
}

function readLayer(file: string): Partial<ScheduleSettings> {
	let text: string;
	try { text = readFileSync(file, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new SettingsError(`cannot read the settings file: ${(error as Error).message}`);
	}
	return parseSettings(text);
}

export const USER_SETTINGS_NAME = "schedule-commands-settings.json";

export function loadSettings(options: { agentDir: string; cwd: string; trusted: boolean }): ScheduleSettings {
	const user = readLayer(join(options.agentDir, USER_SETTINGS_NAME));
	const project = options.trusted ? readLayer(join(options.cwd, ".pi", USER_SETTINGS_NAME)) : {};
	return { ...DEFAULT_SETTINGS, ...user, ...project };
}
