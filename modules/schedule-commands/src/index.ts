/**
 * pi-schedule-commands: schedules prompts, agent sessions and shell commands while this Pi session is open.
 * Not an OS scheduler and not a sandbox: nothing runs when Pi is closed, and missed runs are only handled when a
 * session next loads the jobs. Project schedules are read only for a trusted project.
 */
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isManagedForegroundChild } from "../../../shared/src/background/index.js";
import { realClock } from "./clock.ts";
import { ScheduleEngine, type EngineEvent } from "./engine.ts";
import { createExecutor } from "./executor.ts";
import { JobError, JobService } from "./jobs.ts";
import { MARKER_TYPE, postMarker } from "./markers.ts";
import { registerManageCommand } from "./manage.ts";
import { renderMarker } from "./message-renderer.ts";
import { orderRows, publishScheduleBriefs, SchedulePanel } from "./panel.ts";
import { registerScheduleSettings } from "./settings-ui.ts";
import { DEFAULT_SETTINGS, loadSettings, type ScheduleSettings } from "./settings.ts";
import { ScheduleStore } from "./storage.ts";
import { createPromptTool, createShellTool, type ToolDeps } from "./tool.ts";
import { isProjectTrusted } from "./trust.ts";

interface Live {
	store: ScheduleStore;
	jobs: JobService;
	engine: ScheduleEngine;
	executor: ReturnType<typeof createExecutor>;
}

export default function (pi: ExtensionAPI): void {
	// A managed child never schedules: only the main agent owns schedules.
	if (isManagedForegroundChild()) return;

	let live: Live | undefined;
	let settings: ScheduleSettings = DEFAULT_SETTINGS;
	let current: ExtensionContext | undefined;
	let legacyNoticeShown = false;
	let revokeBriefs: (() => void) | undefined;
	const panel = new SchedulePanel(realClock);

	pi.registerMessageRenderer(MARKER_TYPE, renderMarker);

	const need = (): Live => {
		if (!live) throw new JobError("schedules are unavailable: this project is not trusted or the session has not started, so no project schedules are loaded. Trust the project and reload");
		return live;
	};
	const deps: ToolDeps = {
		jobs: () => need().jobs, engine: () => need().engine, approvals: () => need().executor.approvals,
		clock: realClock, activeTools: () => pi.getActiveTools(),
	};
	// Declared directly (user-requested default loading), so their definitions go with every request; the host's
	// allowlist and exclusions still decide whether each one is active.
	pi.registerTool({ ...createPromptTool(deps), defaultActive: true } as never);
	pi.registerTool({ ...createShellTool(deps), defaultActive: true } as never);

	registerManageCommand(pi, { ...deps, rows: () => { const l = need(); return orderRows(l.store.read().store.jobs.filter(l.jobs.visible).map((job) => ({ job, running: l.engine.runningJobs.has(job.id) }))); } });
	registerScheduleSettings(pi);

	const teardown = () => {
		if (!live) return;
		panel.clear();
		revokeBriefs?.();
		revokeBriefs = undefined;
		live.engine.stop();
		live.executor.abortAll();
		live = undefined;
	};

	pi.on("session_start", async (_event, ctx) => {
		teardown();
		current = ctx;
		if (!isProjectTrusted(ctx)) return;
		try { settings = loadSettings({ agentDir: getAgentDir(), cwd: ctx.cwd, trusted: true }); }
		catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Schedules not started: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		const store = new ScheduleStore(ctx.cwd);
		if (!legacyNoticeShown && store.hasLegacyFile()) {
			legacyNoticeShown = true;
			if (ctx.hasUI) ctx.ui.notify("The old Schedule Prompt file is no longer read; recreate jobs with schedule_prompt or schedule_shell.", "info");
		}
		const executor = createExecutor({ pi, context: () => current ?? ctx, trusted: () => isProjectTrusted(current ?? ctx), tailBytes: settings.commandOutputTailBytes });
		const onEvent = (event: EngineEvent) => {
			if (event.type === "skipped" && event.job) postMarker(pi, { jobId: event.job.id, jobName: event.job.name, kind: event.job.kind, phase: "skipped", error: event.message });
			else if ((event.type === "error" || event.type === "expired") && ctx.hasUI) ctx.ui.notify(event.message, event.type === "error" ? "warning" : "info");
		};
		const engine = new ScheduleEngine({ store, clock: realClock, sessionId: ctx.sessionManager.getSessionId(), settings, execute: executor.execute, onEvent, onChange: () => panel.refresh() });
		const jobs = new JobService({ store, clock: realClock, sessionId: ctx.sessionManager.getSessionId(), scope: () => settings.defaultJobScope, changed: () => { engine.reload(); panel.refresh(); } });
		live = { store, jobs, engine, executor };
		if (settings.panelVisible) {
			panel.bind(ctx, () => store.read().store.jobs.filter(jobs.visible).map((job) => ({ job, running: engine.runningJobs.has(job.id) })));
			try { revokeBriefs = publishScheduleBriefs(() => engine.runningJobs, ctx); } catch { /* briefs are a reminder aid only */ }
		}
		try { await engine.start(); }
		catch (error) {
			teardown();
			if (ctx.hasUI) ctx.ui.notify(`Schedules not started: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		teardown();
		current = undefined;
	});
}
