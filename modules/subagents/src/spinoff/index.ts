// The Spinoff half of the Subagents extension (independent Pi process, cross-session background hand-over). Only `spinoff` is registered here;
// reading, cancelling and messaging a Spinoff go through the shared agent_status / agent_cancel / agent_message tools of ../../extensions/subagent/index.ts.
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { stripVTControlCharacters } from "node:util";
import { consumeManagedChildGuard } from "../../../../shared/src/background/index.ts";
import { SPINOFF_CHILD_REFUSAL, consumeSpinoffChildGuard } from "./identity.ts";
import { renderSpinoffResult } from "./result-renderer.ts";
import { RESULT_TYPE, acceptSpinoff, onSessionShutdown, onSessionStart, onTurnEnd } from "./manager.ts";
import { publishSpinoffMonitor } from "./monitor-capability.ts";
import { SPINOFF_RULES_SECTION, renderSpinoffRules } from "./prompt-rules.ts";
import { spinoffReceiptSchema } from "./output-schema.ts";
import { registerPromptSection } from "../../../../shared/src/prompt/index.ts";

const display = (value: unknown, max = 300) => typeof value === "string" ? stripVTControlCharacters(value.slice(0, max * 4)).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "").slice(0, max) : "";
function renderTextResult(result: any, _options: unknown, theme: any, context: any) {
	const text = result.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
	return new Text(theme.fg(context.isError ? "error" : "success", display(text, 600)), 0, 0);
}
/** structuredContent is the JSON-clean copy of `structured` (what codemode scripts resolve to); `details` stays as before. `structured` must be plain JSON data (no Map/Set/Date/BigInt/cycles): the round-trip drops or throws on those. */
const textResult = (text: string, details: Record<string, unknown>, structured: Record<string, unknown> = details) => ({ content: [{ type: "text" as const, text }], details, structuredContent: JSON.parse(JSON.stringify(structured)) });

export default function (pi: ExtensionAPI) {
	// Subagent children never register Spinoff tools; their argument builder also excludes them.
	if (consumeManagedChildGuard()) return;
	// A Spinoff child registers the very same definitions as its parent and refuses every call at execute time: providers match the
	// cached prefix on the tool list (some, e.g. DeepSeek, on the exact list), so a child with fewer tools cannot continue the parent's cache.
	const childGuard = consumeSpinoffChildGuard();
	const spinoffChild = !!childGuard;
	const refuseInChild = () => { if (spinoffChild) throw new Error(SPINOFF_CHILD_REFUSAL); };

	// The child carries the same rule text as its parent: the system prompt prefix has to match for the cached prefix to continue.
	registerPromptSection(pi, SPINOFF_RULES_SECTION, renderSpinoffRules);
	if (!spinoffChild) pi.registerMessageRenderer(RESULT_TYPE, renderSpinoffResult);

	pi.registerTool(defineTool({
		name: "spinoff",
		label: "Spinoff",
		description: "Start an independent Pi process that continues THIS conversation (full history, same model, thinking level, tools and permissions) on a task, in the background. " +
			"The Spinoff keeps working even if you switch to another conversation, then reports back to this conversation. It can use subagent but cannot create another Spinoff. " +
			"It shares this workspace (no worktree, no merge) and its conversation is a native session you can open with /resume after it finishes. A query-only transcript of what the Spinoff does after starting (no inherited context) is also written; its path is returned when the Spinoff is accepted and in the completion notice. Quit or /reload cancels unfinished Spinoffs.",
		promptSnippet: "Hand a task to an independent background Pi that inherits this conversation; the result is reported back here.",
		promptGuidelines: ["Use spinoff for long, self-contained work that benefits from this conversation's full context; use subagent for fresh-context workers."],
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		defaultActive: true,
		parameters: Type.Object({
			task: Type.String({ description: "What the Spinoff must do. It sees this conversation up to the end of the current turn." }),
			title: Type.Optional(Type.String({ description: "Short label (<=120 chars) shown in status and the result notice." })),
		}, { additionalProperties: false }),
		outputSchema: spinoffReceiptSchema,
		renderCall(args, theme) { return new Text(`${theme.fg("toolTitle", theme.bold("spinoff"))} ${theme.fg("muted", display(args?.title || args?.task, 100))}`, 0, 0); },
		renderResult: renderTextResult,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			refuseInChild();
			// Admission is re-checked here: a direct call or forged arguments cannot lift a Subagent/Spinoff identity.
			const receipt = acceptSpinoff(pi, ctx, params);
			return textResult(`Spinoff accepted: ${receipt.jobId} (${receipt.title}). It starts at the end of this turn as an independent Pi process (session ${receipt.spinoffSessionId}); the result will be reported to this conversation. Its own messages after it starts (no inherited context) are logged for querying at ${receipt.transcriptPath} (".partial" suffix while running; final path is announced on completion). Use agent_status ${receipt.jobId} to check, agent_cancel to request cancellation, agent_message to send it an instruction.`, { ...receipt });
		},
	}));

	if (childGuard) return; // no store, Monitor provider or turn hooks
	// Readonly Monitor capability: optional, never gates Spinoff acceptance or delivery.
	let revokeMonitor: (() => void) | undefined;
	pi.on("session_start", (_event, ctx) => { onSessionStart(pi, ctx); revokeMonitor?.(); revokeMonitor = undefined; try { revokeMonitor = publishSpinoffMonitor(ctx); } catch (error) { if (ctx.hasUI) ctx.ui.notify(`Spinoff monitor capability unavailable (spinoff_job Monitor disabled for this session): ${display(String(error), 200)}`, "warning"); } });
	pi.on("session_shutdown", async event => { revokeMonitor?.(); revokeMonitor = undefined; await onSessionShutdown(event.reason); });
	pi.on("turn_end", (event, ctx) => { onTurnEnd(ctx, event as never); });
}
