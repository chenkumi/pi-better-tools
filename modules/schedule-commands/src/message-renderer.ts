/** Presentation of `scheduled_command` markers. Command output and agent results are untrusted display text. */
import { stripVTControlCharacters } from "node:util";
import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { MarkerDetails } from "./markers.ts";

const clean = (value: unknown, limit: number): string =>
	typeof value === "string" ? stripVTControlCharacters(value.slice(0, limit)).replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/g, "").replace(/\t/g, "  ") : "";

export const renderMarker: MessageRenderer = (message, { expanded }, theme) => {
	const d = (message.details && typeof message.details === "object" && !Array.isArray(message.details) ? message.details : {}) as Partial<MarkerDetails>;
	const failed = d.phase === "error", skipped = d.phase === "skipped", done = d.phase === "done";
	const color = failed ? "error" : skipped ? "warning" : done ? "success" : "accent";
	const icon = failed ? "✗" : skipped ? "!" : done ? "✓" : "○";
	const label = failed ? "failed" : skipped ? "skipped" : done ? "finished" : "starting";
	const rows: Array<{ text: string; color: Parameters<typeof theme.fg>[0] }> = [];
	rows.push({ text: `${icon} Scheduled ${d.kind ?? "job"} ${label}: ${clean(d.jobName, 120).replace(/\n/g, " ") || "(unnamed)"}${d.catchUp !== undefined ? ` · catch-up (missed ${d.catchUp})` : ""}`, color });
	if (d.model) rows.push({ text: `Model: ${clean(d.model, 200).replace(/\n/g, " ")}`, color: "dim" });
	if (d.command) rows.push({ text: `Command${d.shell ? ` (${clean(d.shell, 20)})` : ""}: ${clean(d.command, expanded ? 8000 : 200).replace(/\n/g, " ")}`, color: "accent" });
	if (expanded) {
		if (d.jobId) rows.push({ text: `Job: ${clean(d.jobId, 100)}`, color: "dim" });
		if (d.cwd) rows.push({ text: `Directory: ${clean(d.cwd, 1000).replace(/\n/g, " ")}`, color: "dim" });
		if (d.scheduledFor) rows.push({ text: `Scheduled for: ${clean(d.scheduledFor, 40)}`, color: "dim" });
		if (d.prompt) rows.push({ text: `Prompt: ${clean(d.prompt, 4000)}`, color: "dim" });
	}
	if (typeof d.exitCode === "number") rows.push({ text: `Exit code: ${d.exitCode}`, color: "dim" });
	const error = clean(d.error, 4000), output = clean(d.output, 16000);
	if (error) rows.push({ text: expanded ? error : error.split("\n").slice(0, 2).join("\n"), color: "error" });
	if (output) {
		const lines = output.split("\n").filter((line) => line.trim());
		rows.push({ text: d.kind === "shell" ? "Command output (untrusted):" : "Result (untrusted):", color: "dim" });
		rows.push({ text: expanded ? output : lines.slice(0, 3).map((line) => truncateToWidth(line, 200)).join("\n"), color: "dim" });
	}
	if (!expanded && (d.command || d.prompt || output)) rows.push({ text: "Expand for job id, directory and the full text", color: "dim" });
	const background = failed ? "toolErrorBg" : done ? "toolSuccessBg" : "toolPendingBg";
	// Same card as the native tool calls: a full-width colored block that never exceeds the width and never lets a reset break the fill.
	return {
		render(width: number): string[] {
			const outerWidth = Math.max(0, Math.floor(width));
			const padding = outerWidth >= 3 ? 1 : 0;
			const inner = outerWidth - padding * 2;
			const bgAnsi = theme.getBgAnsi(background);
			const finish = (lines: string[]) => {
				const box = new Box(padding, 1, (text: string) => theme.bg(background, text.replace(/\x1b\[(?:0)?m/g, (reset) => reset + bgAnsi)));
				box.addChild({ render: () => lines, invalidate() {} });
				return box.render(outerWidth);
			};
			const limit = 298;
			const lines: string[] = [];
			for (const row of rows) {
				const text = theme.fg(row.color, row.text);
				for (const line of expanded ? wrapTextWithAnsi(text, Math.max(1, inner)) : text.split("\n")) {
					if (lines.length >= limit - 1) { lines.push(truncateToWidth("… Display limit (message content unchanged)", Math.max(0, inner))); return finish(lines); }
					lines.push(truncateToWidth(line, Math.max(0, inner)));
				}
			}
			return finish(lines);
		},
		invalidate() {},
	};
};
