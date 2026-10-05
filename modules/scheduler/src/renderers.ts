import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const clean = (value: unknown, max = 500) => typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  ? stripVTControlCharacters(String(value).slice(0, max * 4)).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").slice(0, max) : "";
const oneLine = (value: unknown, max = 160) => clean(value, max).replace(/\s+/g, " ");
const items = (value: unknown) => Array.isArray(value) ? value : [];
function scheduleLines(value: unknown, expanded: boolean): string[] {
  const s = record(value), timing = record(s.timing);
  const lines = [`${oneLine(s.title) || oneLine(s.id) || "Schedule"} · ${oneLine(s.state) || "unknown state"} · revision ${oneLine(s.revision) || "?"}`,
    `ID: ${oneLine(s.id) || "?"}`,
    `Next: ${s.nextRun === null || s.nextRun === undefined ? "none" : oneLine(s.nextRun) || "unknown"}${timing.timezone ? ` · Timezone: ${oneLine(timing.timezone)}` : ""}${s.lastRunAt ? ` · Last: ${oneLine(s.lastRunAt)}` : ""}`];
  if (expanded) {
    lines.push(`Timing: ${oneLine(timing.kind)} ${oneLine(timing.expression, 300)}`, `Mode: ${oneLine(s.mode)} · Cwd: ${oneLine(s.cwd, 1000)}`);
    if (s.consumed === true) lines.push("One-shot already consumed");
    const execution = record(s.execution);
    if (Object.keys(execution).length) lines.push(`Execution: ${oneLine(execution.provider)}/${oneLine(execution.model)} · thinking ${oneLine(execution.thinkingLevel) || "default"}`);
    if (typeof s.projectTrust === "boolean") lines.push(`Project trust: ${s.projectTrust}`);
    if (typeof s.prompt === "string") lines.push(`Prompt:\n${clean(s.prompt, 4000)}${s.prompt.length > 4000 ? "\n… (prompt preview truncated)" : ""}`);
  }
  return lines;
}

/** Pure presentation only: no scheduling, registry access or cancellation side effects. */
export function scheduleRenderers(action: "create" | "update" | "status" | "cancel" | "delete"): Pick<ToolDefinition, "renderCall" | "renderResult"> {
  const name = `schedule_${action}`;
  return {
    renderCall(args, theme) {
      const input = record(args), timing = record(input.timing);
      const target = action === "create" ? [oneLine(input.title), oneLine(timing.expression), oneLine(timing.timezone)].filter(Boolean).join(" · ")
        : action === "update" || action === "delete" ? `${oneLine(input.id) || "…"} · revision ${oneLine(input.revision) || "?"}`
        : oneLine(input.id ?? input.runId) || (action === "status" ? "all schedules" : "…");
      return new Text(`${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("accent", target || "…")}`, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
      if (context.isError) return new Text(theme.fg("error", `${name} failed\n${clean(text, expanded ? 4000 : 700)}`), 0, 0);
      if (isPartial) return new Text(theme.fg("muted", `${name} running…`), 0, 0);
      let data = record((result as { structuredContent?: unknown }).structuredContent ?? result.details);
      if (!Object.keys(data).length && text.length < 2 * 1024 * 1024) {
        try { data = record(JSON.parse(text)); } catch { /* old/partial/missing metadata */ }
      }
      if (!Object.keys(data).length) return new Text(theme.fg("muted", `${name}: result details unavailable`), 0, 0);
      const runtime = record(data.runtime);
      const lines: string[] = [];
      if (action === "status") {
        lines.push(`Schedules: ${oneLine(data.total) || "?"} · Host: ${oneLine(runtime.role) || "unknown"}`,
          `Now: ${oneLine(data.now)} · Timezone: ${oneLine(data.timezone)}`);
        const schedules = items(data.schedules);
        for (const s of schedules.slice(0, expanded ? 50 : 3)) lines.push(...scheduleLines(s, expanded));
        if (schedules.length > (expanded ? 50 : 3)) lines.push(`… (${schedules.length - (expanded ? 50 : 3)} more returned schedules; expand to view)`);
        const runs = items(data.runs);
        lines.push(`Recent runs returned: ${runs.length}`);
        const result = record(data.result);
        if (result.runId) lines.push(`Result ${oneLine(result.runId)} (${oneLine(result.source)}${result.truncated ? ", truncated" : ""}): ${clean(result.tail, expanded ? 2000 : 200)}`);
        if (expanded) for (const item of runs.slice(0, 50)) {
          const run = record(item);
          lines.push(`Run ${oneLine(run.runId)} · ${oneLine(run.status)} · schedule ${oneLine(run.scheduleId)}`);
          for (const key of ["plannedAt", "startedAt", "endedAt", "error", "restoreError", "outputSummary"] as const) if (run[key]) lines.push(`${key}: ${clean(run[key], 1000)}`);
          if (run.status === "missed") lines.push("missed (no backfill)");
        }
      } else if (action === "delete") {
        const deleted = record(data.deleted);
        lines.push(`Schedule deleted: ${oneLine(deleted.title) || oneLine(deleted.id) || "?"}`, `ID: ${oneLine(deleted.id) || "?"}`, `Finished runs removed: ${oneLine(data.prunedRuns) || "0"}`);
        if (expanded && data.note) lines.push(clean(data.note, 2000));
      } else if (action === "cancel") {
        if (record(data.schedule).state === "cancelled") lines.push("Future schedule dispatch disabled", ...scheduleLines(data.schedule, expanded));
        const requested = items(data.cancellationRequested);
        lines.push(`Run cancellation requests: ${requested.length} · termination not confirmed`);
        if (expanded) { for (const id of requested) lines.push(`Requested: ${oneLine(id)}`); if (data.note) lines.push(clean(data.note, 2000)); }
      } else {
        lines.push(action === "create" ? "Schedule created" : "Schedule updated", ...scheduleLines(data.schedule, expanded));
      }
      if (action !== "status") lines.push(`Host: ${oneLine(runtime.role) || "unknown"}`);
      lines.push("Requires an open Pi app · missed runs are not backfilled");
      for (const key of ["lastError", "sessionError"] as const) if (runtime[key]) lines.push(`Warning: ${key}: ${clean(runtime[key], 1000)}`);
      const independent = record(runtime.independent);
      if (independent.lastError) lines.push(`Warning: independent.lastError: ${clean(independent.lastError, 1000)}`);
      if (record(independent.retention).logCleanupError) lines.push(`Warning: ${clean(record(independent.retention).logCleanupError, 1000)}`);
      if (expanded && runtime.independent) {
        lines.push(`Independent: running=${oneLine(independent.running)} · children=${oneLine(independent.activeChildren)}/${oneLine(independent.maxChildren)}`);
      }
      const output = lines.join("\n");
      return new Text(theme.fg(action === "cancel" || action === "delete" ? "warning" : "toolOutput", output.slice(0, 24000) + (output.length > 24000 ? "\n… (display truncated; full data remains in tool result)" : "")), 0, 0);
    },
  };
}
