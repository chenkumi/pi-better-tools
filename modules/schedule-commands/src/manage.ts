/**
 * `/schedule-commands`: a list of this session's visible schedules in the bottom panel. The panel only picks an action; the
 * action itself goes through the same `schedule_prompt` / `schedule_shell` tool code the model uses, so validation, the
 * exact-command confirmation and the scheduled-turn rules are never duplicated here.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { bottomConfirm, bottomInput, isBottomPanelOpen, openBottomPanel } from "../../../shared/src/bottom-panel/index.js";
import type { BottomBody, PanelStyle } from "../../../shared/src/bottom-panel/index.js";
import { schedulePanelJob, type ScheduleRow } from "./panel.ts";
import { SCHEDULE_HELP } from "./shorthand.ts";
import { createPromptTool, createShellTool, type ToolDeps } from "./tool.ts";
import type { Job } from "./types.ts";

export type ManageAction = { type: "add-prompt" | "add-shell" | "cleanup" } | { type: "toggle" | "remove" | "run"; job: Job };

const KEYS = "↑/↓ PgUp/PgDn move  Enter details  a prompt  m shell  t on/off  r run  x delete  c clean  Esc close";

export class ManageBody implements BottomBody {
	#at = 0;
	#detail = false;
	#scroll = 0;
	#room = 5;
	constructor(
		private readonly rows: () => readonly ScheduleRow[],
		private readonly now: () => number,
		private readonly style: PanelStyle,
		private readonly screenRows: () => number,
		private readonly done: (action: ManageAction | null) => void,
		focus?: string,
	) {
		const index = focus ? this.rows().findIndex((r) => r.job.id === focus) : -1;
		if (index >= 0) this.#at = index;
	}

	#current(): ScheduleRow | undefined { return this.rows()[this.#at]; }

	render(width: number): string[] {
		const s = this.style, rows = this.rows();
		this.#at = Math.min(this.#at, Math.max(0, rows.length - 1));
		const room = Math.max(3, this.screenRows() - 12);
		this.#room = room;
		if (this.#detail && this.#current()) {
			const job = schedulePanelJob(this.#current()!, this.now());
			const text = [`${job.label} · ${job.title}`, ...job.details].flatMap((line) => wrapTextWithAnsi(line, Math.max(10, width - 1)));
			this.#scroll = Math.min(this.#scroll, Math.max(0, text.length - room));
			const shown = text.slice(this.#scroll, this.#scroll + room);
			return ["", ...shown.map((line) => truncateToWidth(line, width, "…", false)), "", s.fg("dim", `${text.length > room ? `lines ${this.#scroll + 1}-${this.#scroll + shown.length} of ${text.length}  ` : ""}↑/↓ PgUp/PgDn scroll  Esc back`)];
		}
		if (!rows.length) return ["", s.fg("dim", "No schedules yet."), "", s.fg("dim", "a add a prompt job   m add a shell job   Esc close")];
		const from = Math.min(Math.max(0, this.#at - Math.floor(room / 2)), Math.max(0, rows.length - room));
		const lines = rows.slice(from, from + room).map((row, i) => {
			const view = schedulePanelJob(row, this.now());
			const text = `${view.state.padEnd(9)} ${view.label} · ${view.title} · ${view.summary ?? ""}`;
			return from + i === this.#at ? s.fg("accent", `▸ ${truncateToWidth(text, width - 2)}`) : `  ${truncateToWidth(text, width - 2)}`;
		});
		return ["", ...lines, "", s.fg("dim", truncateToWidth(`${KEYS}${rows.length > room ? `  (${this.#at + 1}/${rows.length})` : ""}`, width))];
	}

	handleInput(data: string): void {
		const rows = this.rows();
		if (this.#detail) {
			if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "ctrl+c")) { this.#detail = false; this.#scroll = 0; }
			else if (matchesKey(data, "up")) this.#scroll = Math.max(0, this.#scroll - 1);
			else if (matchesKey(data, "down")) this.#scroll++;
			else if (matchesKey(data, "pageUp")) this.#scroll = Math.max(0, this.#scroll - this.#room);
			else if (matchesKey(data, "pageDown")) this.#scroll += this.#room;
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.done(null);
		if (data === "a") return this.done({ type: "add-prompt" });
		if (data === "m") return this.done({ type: "add-shell" });
		if (data === "c") return this.done({ type: "cleanup" });
		const row = this.#current();
		if (row && (data === "t" || data === "x" || data === "r")) return this.done({ type: data === "t" ? "toggle" : data === "x" ? "remove" : "run", job: row.job });
		if (!rows.length) return;
		if (matchesKey(data, "enter")) { this.#detail = true; this.#scroll = 0; }
		else if (matchesKey(data, "up")) this.#at = (this.#at - 1 + rows.length) % rows.length;
		else if (matchesKey(data, "down")) this.#at = (this.#at + 1) % rows.length;
		else if (matchesKey(data, "pageUp")) this.#at = Math.max(0, this.#at - this.#room);
		else if (matchesKey(data, "pageDown")) this.#at = Math.min(rows.length - 1, this.#at + this.#room);
	}
}

export interface ManageDeps extends ToolDeps {
	rows: () => readonly ScheduleRow[];
}

/** Runs one action through the tools; returns the text to show the user. */
export async function performAction(action: ManageAction, deps: ManageDeps, ctx: ExtensionCommandContext): Promise<string | undefined> {
	const prompt = createPromptTool(deps), shell = createShellTool(deps);
	const run = async (tool: typeof prompt | typeof shell, params: Record<string, unknown>) => {
		const result = await (tool.execute as (...args: unknown[]) => Promise<{ content: Array<{ text?: string }> }>)("panel", params, undefined, undefined, ctx);
		return result.content.map((part) => part.text ?? "").join("\n").split("\n")[0];
	};
	const toolFor = (job: Job) => (job.kind === "shell" ? shell : prompt);
	switch (action.type) {
		case "toggle": return run(toolFor(action.job), { action: action.job.enabled ? "disable" : "enable", jobId: action.job.id });
		case "run": return run(toolFor(action.job), { action: "run_now", jobId: action.job.id });
		case "remove":
			if (!await bottomConfirm(ctx, "Delete schedule", `Delete "${action.job.name}" (${action.job.id})?`)) return undefined;
			return run(toolFor(action.job), { action: "remove", jobId: action.job.id });
		case "cleanup": {
			const lines = [await run(prompt, { action: "cleanup" }), await run(shell, { action: "cleanup" })].filter(Boolean);
			return lines.join(" ");
		}
		case "add-prompt":
		case "add-shell": {
			const isShell = action.type === "add-shell";
			const title = isShell ? "New shell schedule" : "New prompt schedule";
			const name = await bottomInput(ctx, title, "Name (blank = generated):");
			if (name === undefined) return undefined;
			const schedule = await bottomInput(ctx, title, `When?\n${SCHEDULE_HELP}`, { required: true });
			if (schedule === undefined) return undefined;
			const body = await bottomInput(ctx, title, isShell ? "Shell command (you confirm the exact command next):" : "Prompt text to deliver:", { required: true });
			if (body === undefined) return undefined;
			return run(isShell ? shell : prompt, { action: "add", schedule: schedule.trim(), ...(name.trim() ? { name: name.trim() } : {}), ...(isShell ? { command: body } : { prompt: body }) });
		}
	}
}

export function registerManageCommand(pi: ExtensionAPI, deps: ManageDeps): void {
	pi.registerCommand("schedule-commands", {
		description: "List and manage scheduled prompts and shell commands",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") { if (ctx.hasUI) ctx.ui.notify("The schedule list needs the interactive TUI. Use schedule_prompt / schedule_shell.", "warning"); return; }
			if (isBottomPanelOpen()) { ctx.ui.notify("Another panel is open. Close it first, then run this command again.", "warning"); return; }
			let focus: string | undefined;
			for (;;) {
				try { deps.rows(); } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning"); return; }
				const action = await openBottomPanel<ManageAction | null>(ctx.ui, {
					key: "pi-better-tools-schedule", title: "Schedules",
					create: ({ done, theme, rows: screenRows }) => new ManageBody(() => deps.rows(), () => deps.clock.now(), theme, screenRows, done, focus),
				});
				if (!action) return;
				if ("job" in action) focus = action.job.id;
				try {
					const text = await performAction(action, deps, ctx);
					if (text) ctx.ui.notify(text, text.startsWith("Error") ? "warning" : "info");
				} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning"); }
			}
		},
	});
}
