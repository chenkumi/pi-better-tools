import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bottomConfirm, bottomInput, bottomSelect } from "../../../../shared/src/bottom-panel/index.ts";
import type { SpinoffUiAnswer, SpinoffUiRequest } from "./child.ts";

/**
 * Shows a dialog that a Spinoff child's extension opened to the user of the parent session, in the same bottom panel the
 * parent's own questions use. The title names the Spinoff so the user can tell whose question it is; the text is the child's
 * (already control-stripped and bounded by child.ts) and is shown as data. Anything that goes wrong, a parent without a UI, a
 * session that was replaced, an abort or a timeout, answers "cancelled": a question nobody saw is never approved.
 */
export async function askParentUser(ctx: ExtensionContext, jobId: string, request: SpinoffUiRequest, signal: AbortSignal): Promise<SpinoffUiAnswer> {
	const cancelled: SpinoffUiAnswer = { cancelled: true };
	try {
		if (!ctx.hasUI || signal.aborted) return cancelled;
		const until = request.timeout ? AbortSignal.any([signal, AbortSignal.timeout(request.timeout)]) : signal;
		const title = `Spinoff ${jobId.slice(-6)}: ${request.title || request.method}`;
		const body = request.message ?? request.placeholder ?? "";
		let answer: SpinoffUiAnswer = cancelled;
		if (request.method === "confirm") answer = { confirmed: await bottomConfirm(ctx, title, body, { signal: until }) };
		else if (request.method === "select") { const value = await bottomSelect(ctx, title, request.options ?? [], { signal: until }); if (value !== undefined) answer = { value }; }
		else if (request.method === "input") { const value = await bottomInput(ctx, title, body, { signal: until }); if (value !== undefined) answer = { value }; }
		else { const value = await ctx.ui.editor(title, request.prefill ?? ""); if (value !== undefined) answer = { value }; }
		return until.aborted ? cancelled : answer;
	} catch { return cancelled; }
}
