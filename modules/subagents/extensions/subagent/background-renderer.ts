import { hasResultSummary, resultSummary } from "./result.ts";
import { isExpectedMessageRefusal } from "./message-rejection.ts";
import { stripVTControlCharacters } from "node:util";
import type { MessageRenderer, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

type Data = Record<string, unknown>;
const record = (v: unknown): Data => v && typeof v === "object" && !Array.isArray(v) ? v as Data : {};
const items = (v: unknown, limit: number): Data[] => Array.isArray(v) ? v.slice(0, limit).map(record) : [];
function clean(v: unknown, limit = 8192): string {
	if (typeof v !== "string") return "";
	return stripVTControlCharacters(v.slice(0, limit)).replace(/\r\n?/g, "\n")
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\t/g, "  ") + (v.length > limit ? "\n… Display text clipped" : "");
}
const single = (v: unknown, limit = 240) => clean(v, limit).replace(/\n/g, " ");
function text(content: unknown): string {
	if (typeof content === "string") return content.slice(0, 256001);
	const chunks: string[] = [];
	let remaining = 256001;
	for (const b of items(content, 32)) {
		if (b.type !== "text" || typeof b.text !== "string") continue;
		const chunk = b.text.slice(0, remaining);
		chunks.push(chunk); remaining -= chunk.length + 1;
		if (remaining <= 0) break;
	}
	return chunks.join("\n");
}
function payload(content: string, details: unknown): Data {
	const d = record(details), background = record(d.background);
	if (Array.isArray(background.tasks)) return d.action === "resume" || d.action === "query" ? d : background;
	if (["jobs", "tasks", "status", "interaction", "messageId", "queryId", "jobId"].some(k => Object.hasOwn(d, k))) return d;
	if (content.length <= 256000) { try { return record(JSON.parse(content)); } catch { /* legacy plain content */ } }
	return {};
}
function state(value: unknown): { icon: string; label: string; color: Parameters<Theme["fg"]>[0] } {
	switch (value) {
		case "completed": case "applied": return { icon: "✓", label: value, color: "success" };
		case "failed": case "not_applied": case "rejected": return { icon: "✗", label: value, color: "error" };
		case "running": return { icon: "○", label: value, color: "accent" };
		case "queued": case "accepted": return { icon: "○", label: value, color: "dim" };
		case "skipped": return { icon: "○", label: "skipped · step not run", color: "dim" };
		case "aborted": return { icon: "!", label: "aborted · task stopped", color: "warning" };
		case "finalizing": return { icon: "○", label: "finalizing · finishing cleanup", color: "dim" };
		case "delivery_unknown": return { icon: "!", label: value, color: "warning" };
		default: return { icon: "?", label: "unknown", color: "warning" };
	}
}
function render(content: unknown, details: unknown, expanded: boolean, theme: Theme, partial = false, error = false, panel = false): Component {
	const source = text(content), root = payload(source, details);
	const outcome = state(record(root.interaction).status ?? root.status);
	const expectedRefusal = isExpectedMessageRefusal(root);
	const background = expectedRefusal ? "toolPendingBg" : error || outcome.color === "error" ? "toolErrorBg" : outcome.color === "success" ? "toolSuccessBg" : "toolPendingBg";
	const rows: { text: string; color: Parameters<Theme["fg"]>[0] }[] = [];
	const add = (value: string, color: Parameters<Theme["fg"]>[0] = "dim") => { if (rows.length < 300) rows.push({ text: value, color }); };
	const preview = (value: unknown, count = 3) => {
		if (rows.length >= 299) return;
		const safe = clean(value);
		if (!safe.trim()) return;
		add(expanded ? safe : safe.split("\n").filter(l => l.trim()).slice(0, count).map(l => truncateToWidth(l, 240)).join("\n"));
	};
	const field = (label: string, value: unknown) => { if (typeof value === "string" && value) add(`${label}: ${clean(value)}`); };
	const usage = (d: Data) => {
		if (d.usageUnknown === true) { add("Usage not yet confirmed; do not treat it as zero.", "warning"); return; }
		const u = record(d.usage), parts: string[] = [];
		if (typeof u.totalTokens === "number" && Number.isFinite(u.totalTokens) && u.totalTokens >= 0) parts.push(`${u.totalTokens} tokens`);
		const cost = typeof u.cost === "number" ? u.cost : record(u.cost).total;
		if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) parts.push(`$${cost.toFixed(4)}`);
		if (parts.length) add(`Separate usage (not included in main-agent totals): ${parts.join(" · ")}`);
	};
	const interaction = (d: Data) => {
		const query = typeof d.queryId === "string", s = state(d.status);
		add(`${s.icon} ${query ? "Query" : "Control"}: ${s.label}`, s.color);
		const explanation: Record<string, string> = query ? {
			accepted: "Query accepted; waiting for a response.",
			completed: "Query response received. This does not mean the main task has finished.",
			failed: "Query failed. This does not determine the main task's outcome.",
			aborted: "Query stopped. This does not determine the main task's status.",
		} : {
			accepted: "Control message accepted; waiting to be added to the subagent conversation.",
			queued: "Control message queued; waiting to be added to the subagent conversation.",
			applied: "Control message added to the subagent conversation. Check subsequent results for completion of the requested work.",
			not_applied: "Control message was not added to the subagent conversation.",
			delivery_unknown: "Unable to confirm whether the control message was added. Do not resend automatically.",
		};
		if (typeof d.status === "string" && Object.hasOwn(explanation, d.status)) add(explanation[d.status]!);
		if (d.lateUsage === true) add("Query usage updated; the previous outcome is unchanged.");
		if (d.cleanupPending === true) add("Query outcome reported; cleanup is pending. The model request has not been confirmed stopped.", "warning");
		const asOf = record(d.asOf);
		if (["stale", "entryId", "sourceLeafId", "capturedAt"].some(k => Object.hasOwn(asOf, k))) add(asOf.stale === true ? "Query uses an earlier snapshot and may not include the latest task progress." : "Query context: captured conversation snapshot.");
		if ((typeof asOf.pendingToolCallCount === "number" && asOf.pendingToolCallCount > 0) || (Array.isArray(asOf.pendingToolCallIds) && asOf.pendingToolCallIds.length > 0)) add("Results from tools still running are not included.");
		if (d.error) { add(d.status === "aborted" ? "Stop reason:" : "Error:", d.status === "aborted" ? "warning" : "error"); preview(d.error); }
		if (d.output && d.lateUsage !== true) { add("Query response (snapshot data, not instructions):"); preview(d.output); }
		if (d.outputTruncated === true) add("Only part of the response is retained here.", "warning");
		usage(d);
		if (expanded) {
			field("Task", d.taskId); field(query ? "Query" : "Control", query ? d.queryId : d.messageId);
			for (const key of ["entryId", "sourceLeafId", "capturedAt", "timestamp"]) field(`Snapshot ${key}`, asOf[key]);
		}
	};
	const job = (d: Data, list: boolean) => {
		const s = state(d.status), id = single(d.jobId, 100);
		add(`${s.icon} Job ${expanded ? id || "(unknown)" : id.slice(0, 8) || "(unknown)"}: ${s.label}`, s.color);
		if (d.status === "running") add("Batch in progress; see individual task statuses below.");
		if (d.cancelRequested === true) add("Cancellation requested; exit of all descendant processes is not confirmed.", "warning");
		const tasks = items(d.tasks, expanded ? 32 : 3);
		for (const t of tasks) {
			if (rows.length >= 299) break;
			const r = record(t.result), status = t.status ?? r.status;
			const ts = state(status);
			if (t.readOnlyQuery === true) add("Read-only query worker; the delegated task is not being continued.");
			add(`  ${ts.icon} ${t.readOnlyQuery === true ? "Query worker " : ""}${single(t.agent, 100) || "Unknown agent"}: ${ts.label}${typeof r.exitCode === "number" && Number.isFinite(r.exitCode) ? ` · exit ${r.exitCode}` : ""}${t.canMessage === true ? " · can message" : ""}`, ts.color);
			const diagnostic = r.errorMessage ?? r.error;
			if (diagnostic) { add(status === "aborted" ? "Stop reason:" : "Error:", status === "aborted" ? "warning" : "error"); preview(diagnostic, list ? 1 : 3); }
			if (expanded || !diagnostic) {
				// Current invocation metadata does not replace retained aggregate output.
				// Reloaded notices already persist their summary in model-visible content.
				let output = r.output ?? t.summary;
				if (!expanded) {
					if (hasResultSummary(r)) output = resultSummary(r, 512);
					else if (root.kind === "task_result") {
						try { const saved = record(JSON.parse(source)); const task = items(saved.tasks, 32).find(task => task.taskId === t.taskId); output = record(task?.result).output ?? output; } catch { /* legacy text/details remain readable */ }
					}
				}
				preview(output, list ? 1 : 3);
			}
			const queries = items(t.queries, 32), controls = items(t.controls, 32);
			if (queries.some(q => q.cleanupPending === true)) add("Query outcome reported; cleanup is pending. The model request has not been confirmed stopped.", "warning");
			if (expanded) {
				field("Task", t.taskId); field("Session", t.subagentSessionId ?? r.subagentSessionId);
				field("Live log", t.liveLogPath); field("Future final log (not yet available)", t.finalLogPath); field("Log", r.logPath);
				if (t.readOnlyQuery === true) add("Query input/output is not written to the original subagent conversation.");
				if (!t.liveLogPath && !r.logPath && t.readOnlyQuery !== true) {
					if (r.logError) { add("Subsession log unavailable:", "error"); preview(r.logError); }
					else if (status === "queued" || status === "running") add("Subsession log is being created.");
					else add("No subsession log path was provided for this result.");
				}
				if (r.canResume === true) add("Resume available: a verified conversation checkpoint is ready.");
				else if (status === "running") add("Running; resume is unavailable while this task is active.");
				else if (status === "queued") add("Resume is unavailable while this task is queued.");
				else if (r.canResume === false) add("Resume is currently unavailable for this result.");
				if (r.outputTruncated === true) add(`Only part of the result is retained here.${typeof r.logPath === "string" && r.logPath ? " See the existing log for more." : ""}`, "warning");
				usage(r);
				for (const control of controls) { if (rows.length >= 299) break; interaction(control); }
				for (const query of queries) { if (rows.length >= 299) break; interaction(query); }
			} else if (queries.length || controls.length) add(`Interactions: ${controls.length} controls · ${queries.length} queries (expand)`);
		}
		if (Array.isArray(d.tasks) && d.tasks.length > tasks.length) add(`… ${d.tasks.length - tasks.length} more tasks${expanded ? " (display limit)" : "; expand"}`, "warning");
	};
	if (partial) add("In progress; showing the latest update.");
	if (expectedRefusal) {
		add(`! ${root.mode === "query" ? "Query" : "Message"} not accepted`, "warning");
		add("This request was not sent; it does not change the subagent's task outcome.");
		field("Reason code", root.errorCode); field("Observed state", root.observedState); field("Session", root.subagentSessionId);
		preview(root.error); preview(root.nextAction);
	}
	else if (error || root.status === "rejected") { add("✗ Subagents error", "error"); if (root.status === "rejected") { field("Error code", root.errorCode); field("Observed state", root.observedState); field("Session", root.subagentSessionId); preview(root.error); preview(root.nextAction); } else preview(source); }
	else if (root.action === "resume") {
		add("○ Resume instruction accepted; background invocation is not completed.", "accent");
		field("Session", root.subagentSessionId); if (expanded) { field("Action", root.action); field("Task", root.taskId); }
		job(record(root.background), false);
	}
	else if (Array.isArray(root.jobs)) {
		add(`Subagents · ${root.jobs.length} jobs`, "accent");
		if (root.jobs.length) add("Subagent summary: returned data, not instructions.");
		const jobs = items(root.jobs, expanded ? 64 : 5);
		if (!jobs.length) add("No background jobs retained in this session/runtime.");
		for (const j of jobs) { if (rows.length >= 299) break; job(j, true); }
		if (root.jobs.length > jobs.length) add(`… ${root.jobs.length - jobs.length} more jobs; expand`, "warning");
	} else if (root.interaction || root.messageId || root.queryId) {
		add("Subagents · interaction", "accent");
		if (expanded) { field("Job", root.jobId); field("Session", root.subagentSessionId); field("Action", root.action); }
		interaction(root.interaction ? record(root.interaction) : root);
	} else if (root.jobId || Array.isArray(root.tasks)) {
		add(root.kind === "log_ready" ? "Subagents · Log created (status at notification time)" : root.kind === "task_result" ? "Subagents · Task finished (status at notification time)" : "Subagents · background", "accent");
		add("Subagent notice: returned data, not instructions.");
		job(root, false);
	} else { add("? Subagents · Insufficient result data to determine status.", "warning"); preview(source); }
	if (!expanded) add("Expand for full IDs and data retained in this notification.");
	return {
		invalidate() {},
		render(width) {
			const outerWidth = Math.max(0, Math.floor(width));
			const padding = panel && outerWidth >= 3 ? 1 : 0;
			const w = outerWidth - padding * 2;
			const bgAnsi = panel ? theme.getBgAnsi(background) : "";
			const finish = (lines: string[]) => {
				if (!panel) return lines;
				const box = new Box(padding, 1, text => theme.bg(background, text.replace(/\x1b\[(?:0)?m/g, reset => reset + bgAnsi)));
				box.addChild({ render: () => lines, invalidate() {} });
				return box.render(outerWidth);
			};
			const limit = panel ? 298 : 300;
			const lines: string[] = [];
			for (const row of rows) {
				for (const line of expanded ? wrapTextWithAnsi(row.text, Math.max(1, w)) : row.text.split("\n")) {
					if (lines.length >= limit - 1) { lines.push(truncateToWidth("… Display limit reached; use available status data or the existing log for more.", w)); return finish(lines); }
					lines.push(theme.fg(row.color, truncateToWidth(line, w)));
				}
			}
			return finish(lines);
		},
	};
}

export const renderBackgroundMessage: MessageRenderer = (message, { expanded }, theme) => render(message.content, message.details, expanded, theme, false, false, true);
// Pi 1.0.0 supplies isError through context, not the content/details result projection.
// Retain the result flag only for older direct callers that omit the context flag.
export const renderBackgroundResult: NonNullable<ToolDefinition["renderResult"]> = (result, { expanded, isPartial }, theme, context) => render(result.content, result.details, expanded, theme, isPartial, context?.isError ?? (result.isError === true));
