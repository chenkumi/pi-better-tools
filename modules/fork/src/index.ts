// Public Pi entry for the native Fork module (independent Pi process, cross-session background hand-over).
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { stripVTControlCharacters } from "node:util";
import { consumeManagedChildGuard } from "../../shell-tools/src/managed-child.ts";
import { consumeForkChildGuard } from "./identity.ts";
import { renderForkResult } from "./result-renderer.ts";
import { RESULT_TYPE, acceptFork, onSessionShutdown, onSessionStart, onTurnEnd, ownedJobs, requestCancel, summarize } from "./manager.ts";

const display = (value: unknown, max = 300) => typeof value === "string" ? stripVTControlCharacters(value.slice(0, max * 4)).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "").slice(0, max) : "";
const renderers = (name: string) => ({
	renderCall(args: any, theme: any) { return new Text(`${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("muted", display(args?.jobId, 40))}`, 0, 0); },
	renderResult(result: any, _options: unknown, theme: any, context: any) {
		const text = result.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
		return new Text(theme.fg(context.isError ? "error" : "success", display(text, 600)), 0, 0);
	},
});
const textResult = (text: string, details: Record<string, unknown>) => ({ content: [{ type: "text" as const, text }], details });

export default function (pi: ExtensionAPI) {
	// Subagent and Fork children never register creation tools; the schema is also excluded by their argument builders.
	if (consumeManagedChildGuard() || consumeForkChildGuard()) return;

	pi.registerMessageRenderer(RESULT_TYPE, renderForkResult);

	pi.registerTool(defineTool({
		name: "fork",
		label: "Fork",
		description: "Start an independent Pi process that continues THIS conversation (full history, same model, thinking level, tools and permissions) on a task, in the background. " +
			"The Fork keeps working even if you switch to another conversation, then reports back to this conversation. It can use subagent but cannot create another Fork. " +
			"It shares this workspace (no worktree, no merge) and its conversation is a native session you can open with /resume after it finishes. Quit or /reload cancels unfinished Forks.",
		promptSnippet: "Hand a task to an independent background Pi that inherits this conversation; the result is reported back here.",
		promptGuidelines: ["Use fork for long, self-contained work that benefits from this conversation's full context; use subagent for fresh-context workers."],
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		defaultActive: true,
		parameters: Type.Object({
			task: Type.String({ description: "What the Fork must do. It sees this conversation up to the end of the current turn." }),
			title: Type.Optional(Type.String({ description: "Short label (<=120 chars) shown in status and the result notice." })),
		}, { additionalProperties: false }),
		renderCall(args, theme) { return new Text(`${theme.fg("toolTitle", theme.bold("fork"))} ${theme.fg("muted", display(args?.title || args?.task, 100))}`, 0, 0); },
		renderResult(result, _options, theme, context) {
			const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
			return new Text(theme.fg(context.isError ? "error" : "success", display(text, 600)), 0, 0);
		},
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// Admission is re-checked here: a direct call or forged arguments cannot lift a Subagent/Fork identity.
			const receipt = acceptFork(pi, ctx, params);
			return textResult(`Fork accepted: ${receipt.jobId} (${receipt.title}). It starts at the end of this turn as an independent Pi process (session ${receipt.forkSessionId}); the result will be reported to this conversation. Use fork_status ${receipt.jobId} to check, fork_cancel to request cancellation.`, { ...receipt });
		},
	}));

	pi.registerTool(defineTool({
		name: "fork_status",
		...renderers("fork_status"),
		label: "Fork status",
		description: "Read-only status of Forks created from THIS conversation. Without jobId lists up to 32; with jobId shows one including its bounded result.",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		defaultActive: true,
		parameters: Type.Object({ jobId: Type.Optional(Type.String()) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const jobs = ownedJobs(ctx);
			if (params.jobId) {
				const job = jobs.find(candidate => candidate.record.jobId === params.jobId);
				if (!job) throw new Error("FORK_NOT_FOUND: no such Fork in this conversation.");
				return textResult(JSON.stringify(summarize(job, true)), summarize(job, true));
			}
			const list = jobs.slice(0, 32).map(job => summarize(job));
			return textResult(JSON.stringify({ forks: list, partial: jobs.length > 32 }), { forks: list });
		},
	}));

	pi.registerTool(defineTool({
		name: "fork_cancel",
		...renderers("fork_cancel"),
		label: "Fork cancel",
		description: "Request cancellation of a Fork created from THIS conversation. Cancellation is a request: status stays cancelling until the child process actually closes.",
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		defaultActive: true,
		parameters: Type.Object({ jobId: Type.String() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const job = ownedJobs(ctx).find(candidate => candidate.record.jobId === params.jobId);
			if (!job) throw new Error("FORK_NOT_FOUND: no such Fork in this conversation.");
			await requestCancel(job);
			const summary = summarize(job);
			return textResult(`Cancel requested for ${job.record.jobId}; status ${job.record.status}. Requested is not the same as exited.`, summary);
		},
	}));

	pi.on("session_start", (_event, ctx) => { onSessionStart(pi, ctx); });
	pi.on("session_shutdown", async event => { await onSessionShutdown(event.reason); });
	pi.on("turn_end", (event, ctx) => { onTurnEnd(ctx, event as never); });
}
