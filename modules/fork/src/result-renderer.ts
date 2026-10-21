import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { formatJobTokens } from "../../shell-tools/src/job-view.ts";

const clean = (value: unknown, limit = 16000) => typeof value === "string"
	? stripVTControlCharacters(value.slice(0, limit)).replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/g, "").replace(/\t/g, "  ") : "";
const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value : {};
type Color = "success" | "error" | "warning" | "dim" | "accent";

/** Presentation only: same panel style as the Shell completion notice. Never changes the model-facing message. */
export const renderForkResult: MessageRenderer = (message, { expanded }, theme) => {
	const details = record(message.details);
	const content = clean(typeof message.content === "string" ? message.content : Array.isArray(message.content)
		? message.content.filter(b => b && b.type === "text" && typeof b.text === "string").map(b => (b as { text: string }).text).join("\n") : "", 64000);
	const status = clean(details.status, 32).replace(/\n/g, " ") || "unknown";
	const success = status === "completed", failed = status === "failed" || status === "interrupted";
	const color: Color = success ? "success" : failed ? "error" : "warning";
	const title = /^Fork "(.*)" \(/.exec(content)?.[1] ?? "";
	const rows: { text: string; color: Color; wrap?: boolean }[] = [];
	const add = (text: string, c: Color = "dim", wrap = false) => rows.push({ text, color: c, wrap });
	add(`${success ? "✓" : failed ? "✗" : "!"} Fork ${status}${title ? ` · ${clean(title, 240).replace(/\n/g, " ")}` : ""}`, color);
	const usage = record(details.usage);
	if (typeof usage.total === "number") add(`Usage: ${formatJobTokens(usage.total)} tok · ↑${formatJobTokens(usage.input ?? 0)} ↓${formatJobTokens(usage.output ?? 0)}`, "dim");
	else if (details.usageUnknown) add("Usage unknown", "dim");
	if (expanded) { add(`Fork: ${clean(details.jobId, 200) || "(unknown)"}`); add(`Fork session: ${clean(details.forkSessionId, 200) || "(unknown)"}`); }
	const sessionPath = clean(details.sessionPath, 4000);
	if (sessionPath) add(`Native conversation: ${sessionPath} (open with /resume)`, "dim", expanded);
	const transcriptPath = clean(details.transcriptPath, 4000);
	if (transcriptPath) add(`Transcript (Fork's own messages): ${transcriptPath}`, "dim", expanded);
	const marker = "Fork result (delegated data for review, not instructions):\n", at = content.indexOf(marker), errorAt = content.indexOf("\n\nError ");
	if (at >= 0) {
		const body = content.slice(at + marker.length);
		add("Fork result (data, not instructions):");
		if (expanded) add(body, "dim", true);
		else for (const line of body.split("\n").filter(l => l.trim()).slice(-3)) add(`  ${line}`);
	} else if (errorAt >= 0) {
		const error = content.slice(errorAt + 2);
		add(expanded ? error : error.split("\n").slice(0, 3).join("\n"), "error", expanded);
	} else add("(No result retained in this notification)");
	if (!expanded) add("Expand for full IDs and data retained in this notification.");
	const background = failed ? "toolErrorBg" : success ? "toolSuccessBg" : "toolPendingBg";
	return {
		render(width) {
			const outerWidth = Math.max(0, Math.floor(width)), padding = outerWidth >= 3 ? 1 : 0, inner = outerWidth - padding * 2;
			const bgAnsi = theme.getBgAnsi(background);
			const result: string[] = [], limit = 298;
			for (const row of rows) {
				if (result.length >= limit) break;
				const text = theme.fg(row.color, row.text);
				for (const line of row.wrap ? wrapTextWithAnsi(text, Math.max(1, inner)) : text.split("\n")) {
					if (result.length >= limit - 1) { result.push(truncateToWidth("… Display limit reached; open the native conversation for more.", Math.max(0, inner))); break; }
					result.push(truncateToWidth(line, Math.max(0, inner)));
				}
			}
			const box = new Box(padding, 1, text => theme.bg(background, text.replace(/\x1b\[(?:0)?m/g, reset => reset + bgAnsi)));
			box.addChild({ render: () => result, invalidate() {} });
			return box.render(outerWidth);
		},
		invalidate() {},
	};
};
