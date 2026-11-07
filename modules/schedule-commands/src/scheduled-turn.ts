/**
 * Is the current model turn one this scheduler started? Provenance comes from persisted entries of the current branch,
 * not from a text heuristic:
 * - prompt job: a marker (kind "prompt", phase "start") sits after the previous user message, and its `details.prompt`
 *   equals the text of the latest user message, which is the delivered prompt;
 * - agent job with notify: a done/error marker with `details.notify` after the latest user message woke the agent
 *   without any user message.
 * Older scheduled runs behind a later user message never match, so they do not block unrelated turns.
 */
import { MARKER_TYPE } from "./markers.ts";

type Entry = { type?: string; customType?: string; message?: { role?: string; content?: unknown }; details?: Record<string, unknown> };

function textOf(entry: Entry | undefined): string {
	const content = entry?.message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part: { type?: string; text?: string }) => (part?.type === "text" ? part.text ?? "" : "")).join("");
}

export function isInScheduledExecution(sessionManager: { getBranch?: () => unknown[]; getEntries?: () => unknown[] }): boolean {
	const branch = ((sessionManager.getBranch ?? sessionManager.getEntries)?.call(sessionManager) ?? []) as Entry[];
	const isUser = (e: Entry) => e?.type === "message" && e.message?.role === "user";
	const isMarker = (e: Entry) => e?.type === "custom_message" && e.customType === MARKER_TYPE;
	let latest = -1, previous = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (!isUser(branch[i])) continue;
		if (latest < 0) latest = i; else { previous = i; break; }
	}
	for (let i = latest + 1; i < branch.length; i++) {
		const e = branch[i];
		if (isMarker(e) && e.details?.kind === "agent" && e.details.notify === true && (e.details.phase === "done" || e.details.phase === "error")) return true;
	}
	if (latest < 0) return false;
	const prompt = textOf(branch[latest]);
	for (let i = previous + 1; i < latest; i++) {
		const e = branch[i];
		if (isMarker(e) && e.details?.kind === "prompt" && e.details.phase === "start" && e.details.prompt === prompt) return true;
	}
	return false;
}
