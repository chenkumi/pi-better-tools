import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canonicalMonitorCwd, publishJobBriefs } from "../../shell-tools/src/monitor-capability.ts";
import type { PanelHost } from "../../shell-tools/src/background-panel.ts";
import { safeJobText, type PanelJob } from "../../shell-tools/src/job-view.ts";
import { JobsWidgetBinding } from "../../shell-tools/src/widget-binding.ts";
import type { PtySessionManager, PtySessionSummary } from "./pty-manager.ts";

const MAX_ROWS = 32;

/**
 * Plain projection of one PTY session. Never reads output, the command line or typed secrets: only identity, target and
 * lifecycle. Counters that change with every byte of output are left out because the panel refreshes on lifecycle changes.
 */
export function ptyPanelJob(session: PtySessionSummary): PanelJob {
	const active = session.state === "running";
	const title = session.transport === "local" ? session.target : `${session.target} (${session.transport})`;
	const exit = session.exitCode === undefined ? "exit code not observed" : `exit code ${session.exitCode}`;
	return {
		kind: "pty", jobId: session.sessionId, label: "pty", title: safeJobText(title, 256), state: session.state, active,
		activity: active ? "Running · local transport alive" : `Exited · ${exit} · unread output may remain`,
		usageState: "na", startedAt: session.startedAt,
		summary: active ? "running" : `exited | ${session.exitCode ?? "?"}`,
		details: [
			`Session ID: ${session.sessionId}`,
			`Target: ${title} · local transport PID ${session.pid} (not a remote process ID)`,
			`Started: ${new Date(session.startedAt).toISOString()}`,
			active ? "State: running" : `State: exited (${exit}); the session stays listed until released or reclaimed`,
			...(session.recovered ? ["Recovered after a failed shutdown: local transport exit is unconfirmed. Use pty_kill to retry."] : []),
			"Use pty_list, pty_read or pty_kill (load them with tool_search if needed). Output is not shown here.",
			"Closing the local transport does not prove a remote/WSL process tree stopped. Tokens N/A: PTY has no model usage ledger.",
		].map(line => safeJobText(line, 512)),
	};
}

/** Binding-scoped, event-driven view of this workspace's PTY sessions. Presentation only: no polling, no model work. */
export class PtySessionsWidget extends JobsWidgetBinding<PtySessionSummary> {
	constructor(api?: PanelHost) { super("pty", rows => rows.slice(0, MAX_ROWS).map(ptyPanelJob), api); }
}

/** Running sessions only (id and status, nothing else) for the live background-jobs reminder at compaction. Returns the revoke handle. */
export function publishPtyBriefs(sessions: PtySessionManager, ctx: ExtensionContext): () => void {
	const scope = { sessionId: ctx.sessionManager.getSessionId(), cwd: canonicalMonitorCwd(ctx.cwd) };
	return publishJobBriefs("pty_session", scope,
		() => sessions.snapshot(scope.cwd).filter(session => session.state === "running").map(session => ({ jobId: session.sessionId, status: "running" })),
		() => {
			try { return ctx.sessionManager.getSessionId() === scope.sessionId && canonicalMonitorCwd(ctx.cwd) === scope.cwd; } catch { return false; }
		});
}
