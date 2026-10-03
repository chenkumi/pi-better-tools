import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const clean = (value: unknown, max = 1000) => typeof value === "string" || typeof value === "number"
  ? stripVTControlCharacters(String(value).slice(0, max * 4)).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").slice(0, max) : "";

export const goalRenderers: Pick<ToolDefinition, "renderCall" | "renderResult"> = {
  renderCall(args, theme) {
    const input = record(args);
    return new Text(`${theme.fg("toolTitle", theme.bold("goal"))} ${theme.fg("accent", clean(input.action, 30) || "…")}` +
      (input.goalId ? ` ${theme.fg("muted", clean(input.goalId, 128))}` : ""), 0, 0);
  },
  renderResult(result, { expanded, isPartial }, theme, context) {
    const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    if (context.isError) return new Text(theme.fg("error", `Goal failed\n${clean(text, expanded ? 4000 : 700)}`), 0, 0);
    if (isPartial) return new Text(theme.fg("muted", "Reading/updating goal…"), 0, 0);
    let data = record(result.details);
    if (!Object.keys(data).length && text.length < 128 * 1024) {
      try { data = record(JSON.parse(text)); } catch { /* old/missing result metadata */ }
    }
    const goal = record(data.goal), status = clean(goal.status, 30);
    const lines = Object.keys(goal).length ? [`Goal: ${status || "unknown state"}`, clean(goal.objective, expanded ? 4000 : 300)]
      : [Object.hasOwn(data, "goal") && data.goal === null ? "No goal set" : "Goal result details unavailable"];
    if (data.diagnostic) lines.push(`Diagnostic: ${clean(data.diagnostic, expanded ? 4000 : 700)}`);
    if (goal.resultSummary) lines.push(`Summary: ${clean(goal.resultSummary, expanded ? 4000 : 300)}`);
    if (goal.stopReason) lines.push(`Reason: ${clean(goal.stopReason, expanded ? 4000 : 300)}`);
    if (goal.suggestedAction) lines.push(`Next action: ${clean(goal.suggestedAction, expanded ? 2000 : 300)}`);
    const verification = Array.isArray(goal.verification) ? goal.verification : [];
    if (status === "complete") lines.push(`Acceptance evidence: ${verification.length} item(s) · model-reported, not an independent audit`);
    if (expanded && Object.keys(goal).length) {
      lines.push(`Goal ID: ${clean(goal.id, 128)} · Run ID: ${clean(goal.runId, 128)}`,
        `Cwd: ${clean(goal.cwd, 4000)}`, `Auto continuations: ${clean(goal.autoRequests, 20)}/20`,
        `Updated: ${clean(goal.updatedAt, 64)}`);
      for (const item of verification.slice(0, 32)) {
        const evidence = record(item);
        lines.push(`Criterion: ${clean(evidence.criterion, 2000)}`, `Evidence: ${clean(evidence.evidence, 4000)}`);
      }
    }
    const output = lines.join("\n");
    return new Text(theme.fg(status === "blocked" || data.diagnostic ? "warning" : status === "complete" ? "success" : "toolOutput",
      output.slice(0, 48000) + (output.length > 48000 ? "\n… (display truncated; full evidence remains in tool result)" : "")), 0, 0);
  },
};
