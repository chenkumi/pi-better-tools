/** Presentation of `scheduled_command` markers. Command output and agent results are untrusted display text. */
import { stripVTControlCharacters } from "node:util";
import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
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
	const box = new Box(1, 0, (text: string) => text);
	box.addChild(new Text(rows.map((row) => theme.fg(row.color, row.text)).join("\n"), 0, 0));
	return box;
};
