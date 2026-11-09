/**
 * `/settings:schedule-commands`. Edits the project layer `<cwd>/.pi/schedule-commands-settings.json` (a trusted project
 * only); the file is written when Save is pressed and never by loading the extension. Settings are read when a session
 * starts, so a saved change needs a reload.
 */
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSettingsCommand, SettingsInputError } from "../../../shared/src/settings-panel/index.ts";
import type { Field, SettingsSchema, Values } from "../../../shared/src/settings-panel/index.ts";
import { DEFAULT_SETTINGS, parseSettingsObject, SettingsError, USER_SETTINGS_NAME, type ScheduleSettings } from "./settings.ts";
import { isProjectTrusted } from "./trust.ts";

const KEYS = Object.keys(DEFAULT_SETTINGS) as Array<keyof ScheduleSettings>;
const MINUTE = 60_000;

const FIELDS: readonly Field[] = [
	{ key: "panelVisible", label: "Show in Jobs panel", group: "General", type: "boolean", help: "Show schedules in the Jobs panel under the editor." },
	{ key: "defaultJobScope", label: "New job scope", group: "General", type: "enum", options: ["session", "workdir"], help: "session: a new job belongs to this session only; workdir: every session of this directory sees it." },
	{ key: "defaultMissed", label: "Missed runs", group: "Catch-up", type: "enum", options: ["skip", "run-once", "run-all"], help: "What to do with runs that came due while Pi was closed." },
	{ key: "defaultMaxLateMs", label: "Max late (minutes)", group: "Catch-up", type: "int", min: 0, max: 7 * 24 * 60, help: "A missed run later than this is skipped. 0 means no limit." },
	{ key: "maxCatchUp", label: "Max catch-up runs", group: "Catch-up", type: "int", min: 1, max: 100, help: "Upper bound for run-all." },
	{ key: "allowShellRunAll", label: "Allow run-all for shell", group: "Catch-up", type: "boolean", help: "Without this a shell job never replays every missed run." },
	{ key: "maxConcurrentAgents", label: "Concurrent agents", group: "Limits", type: "int", min: 1, max: 16 },
	{ key: "maxConcurrentCommands", label: "Concurrent commands", group: "Limits", type: "int", min: 1, max: 16 },
	{ key: "commandOutputTailBytes", label: "Output tail (KiB)", group: "Limits", type: "int", min: 1, max: 1024, help: "How much command output a run keeps for its marker." },
];

/** Panel units (minutes, KiB) to stored units (ms, bytes) and back. */
const SCALE: Partial<Record<keyof ScheduleSettings, number>> = { defaultMaxLateMs: MINUTE, commandOutputTailBytes: 1024 };

export function scheduleSettingsSchema(cwd: string): SettingsSchema<Partial<ScheduleSettings>> {
	return {
		id: "schedule-commands", title: "Schedule Commands", path: join(cwd, ".pi", USER_SETTINGS_NAME), fields: FIELDS, deleteWhenEmpty: true,
		notice: "Project settings; they override the user-level file. Applied when a session starts.",
		parse(raw) {
			try { return parseSettingsObject(raw); }
			catch (error) { throw new Error(error instanceof SettingsError ? error.message : String(error)); }
		},
		toValues(config) {
			const merged = { ...DEFAULT_SETTINGS, ...config };
			const values: Values = {};
			for (const key of KEYS) {
				const v = merged[key];
				values[key] = typeof v === "number" ? Math.round(v / (SCALE[key] ?? 1)) : v;
			}
			return values;
		},
		toPatch(values, dirty) {
			return KEYS.filter((key) => dirty.has(key)).map((key) => {
				const v = values[key];
				if (typeof v === "number") return { path: [key], value: v * (SCALE[key] ?? 1) };
				if (v === undefined) throw new SettingsInputError(`${key} has no value`);
				return { path: [key], value: v };
			});
		},
		appliesWithoutReload: false,
	};
}

/** `/settings:schedule-commands`; refuses (with a reason) in an untrusted project. */
export function registerScheduleSettings(pi: ExtensionAPI): void {
	registerSettingsCommand(pi, (ctx) => (isProjectTrusted(ctx) ? scheduleSettingsSchema(ctx.cwd) : "Schedule settings are only available in a trusted project."), { id: "schedule-commands", title: "Schedule Commands" });
}
