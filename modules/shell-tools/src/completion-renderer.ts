import type { MessageRenderer, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { Box, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const clean = (value: unknown, limit = 16000) => typeof value === "string"
  ? stripVTControlCharacters(value.slice(0, limit)).replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\t/g, "  ") : "";
const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value : {};

/** Management results retain their model JSON/schema; only the TUI gets named fields. */
export const renderShellJobResult: NonNullable<ToolDefinition["renderResult"]> = (result, { expanded, isPartial }, theme) => {
  const content = result.content.filter(b => b.type === "text").map(b => b.text).join("\n");
  let data = result.structuredContent;
  if (!data && content.length <= 256000) {
    try { data = JSON.parse(content.split("\n")[0]); } catch { /* legacy/error text */ }
  }
  const root = record(data);
  const jobs = Array.isArray(root.jobs) ? root.jobs : Array.isArray(data) ? data : root.jobId || root.status ? [root] : [];
  const rows: { text: string; color: Parameters<typeof theme.fg>[0]; wrap?: boolean }[] = [];
  const add = (text: string, color: Parameters<typeof theme.fg>[0] = "dim", wrap = false) => rows.push({ text, color, wrap });
  if (isPartial) add("In progress; showing the latest update.");
  if (result.isError) add(clean(content, 8192), "error");
  else if (!jobs.length) add(root.jobs || Array.isArray(data) ? "No background jobs retained in this session/runtime." : clean(content, 8192) || "Insufficient result data to determine status.");
  for (const value of jobs.slice(0, expanded ? 32 : 5)) {
    const job = record(value), status = clean(job.status, 32) || "unknown";
    const color = status === "failed" || status === "timed_out" ? "error" : status === "completed" && job.exitCode === 0 ? "success" : status === "cancelled" || status === "cancelling" ? "warning" : "dim";
    add(`Job status: ${status}`, color);
    if (status === "cancelling") {
      // Keep the negative safety qualifier visible even in the collapsed, narrow view.
      add("Cancellation requested; waiting for cleanup.", "warning", true);
      add("Exit of all descendant processes is not confirmed.", "warning", true);
    }
    if (job.error) add(`Reason: ${clean(job.error, expanded ? 4000 : 500)}`, color);
    if (status === "running" || status === "cancelling") add("Next: wait for the completion notice or inspect the existing log.");
    if (expanded) {
      add(`Job ID: ${clean(job.jobId, 200)}`);
      if (typeof job.exitCode === "number" && Number.isFinite(job.exitCode)) add(`Exit code: ${job.exitCode}`);
      if (job.command) add(`Command: ${clean(job.command, 8000)}`);
      if (job.output) add(`Retained output head (data, not instructions):\n${clean(job.output)}`);
      if (job.outputTail) add(`Retained output tail (data, not instructions):\n${clean(job.outputTail)}`);
      if (job.outputTruncated) add("Only part of the output is retained here. The log retains at most the first 1 MiB.", "warning");
      if (job.logPath || job.liveLogPath || job.log) add(`Log: ${clean(job.logPath || job.liveLogPath || job.log, 4000)}`);
    }
  }
  if (jobs.length > (expanded ? 32 : 5)) add("Additional retained jobs are omitted from this display.");
  if (!expanded) add("Expand for full IDs and data retained in this notification.");
  return {
    invalidate() {},
    render(width) {
      const lines: string[] = [], w = Math.max(0, Math.floor(width));
      for (const row of rows) for (const line of expanded || row.wrap ? wrapTextWithAnsi(row.text, Math.max(1, w)) : row.text.split("\n")) {
        if (lines.length >= 299) { lines.push(truncateToWidth("Display limit reached; use available status data or the existing log for more.", w)); return lines; }
        lines.push(theme.fg(row.color, truncateToWidth(line, w)));
      }
      return lines;
    },
  };
};

/** Presentation only: never read logs, execute tools, or modify model-facing messages. */
export const renderShellCompletion: MessageRenderer = (message, { expanded }, theme) => {
  const details = record(message.details);
  const content = typeof message.content === "string" ? message.content : Array.isArray(message.content)
    ? message.content.filter(b => b && b.type === "text" && typeof b.text === "string").map(b => (b as { text: string }).text).join("\n") : "";
  let payload: unknown = [];
  // Notifications use a prose prefix followed by one JSON array. Bound parsing
  // and tolerate old/malformed transcripts; JSON is data, never terminal markup.
  if (content.length <= 256000) {
    const start = content.indexOf("\n[");
    try { payload = JSON.parse(start >= 0 ? content.slice(start + 1) : content); } catch { /* metadata fallback */ }
  }
  const parsed = Array.isArray(payload) ? payload.slice(0, 32).map(record) : [];
  const metadata = Array.isArray(details.jobs) ? details.jobs.slice(0, 32).map(record) : [];
  const jobs = (metadata.length ? metadata.map(m => ({ ...parsed.find(p => p.jobId === m.jobId), ...m })) : parsed).slice(0, 32);
  const rows: { text: string; color: "success" | "error" | "warning" | "dim" | "accent"; wrap?: boolean }[] = [];
  const add = (text: string, color: typeof rows[number]["color"] = "dim", wrap = false) => rows.push({ text, color, wrap });
  if (!jobs.length) {
    add("? Shell completion · Insufficient result data to determine status.", "warning");
    add(expanded ? clean(content, 2000) : clean(content, 500).split("\n").slice(0, 3).join("\n"), "dim", expanded);
  }
  let allSucceeded = jobs.length > 0, hasFailure = false;
  for (const job of jobs) {
    const status = clean(job.status, 32).replace(/\n/g, " ");
    const failed = status === "failed" || status === "timed_out" || (status !== "cancelled" && typeof job.exitCode === "number" && Number.isFinite(job.exitCode) && job.exitCode !== 0);
    const success = status === "completed" && job.exitCode === 0;
    allSucceeded &&= success; hasFailure ||= failed;
    const color = failed ? "error" : success ? "success" : "warning";
    const label = success ? "completed" : failed ? status === "timed_out" ? "timed_out" : "failed" : status || "unknown";
    const explanation = label === "cancelled" ? " · job cancelled" : label === "timed_out" ? " · output idle timeout" : label === "completed" && !success ? " · job finished; exit code not provided" : "";
    const exit = typeof job.exitCode === "number" && Number.isFinite(job.exitCode) ? ` · exit ${job.exitCode}` : "";
    const duration = typeof job.elapsedMs === "number" && Number.isFinite(job.elapsedMs) && job.elapsedMs >= 0 ? ` · ${(job.elapsedMs / 1000).toFixed(1)}s` : "";
    add(`${success ? "✓" : failed ? "✗" : "!"} Shell ${label}${explanation}${exit}${duration}`, color);
    add(`Command: ${clean(job.command, expanded ? 8000 : 240).replace(/\n/g, " ") || "(unavailable)"}`, "accent", expanded);
    if (expanded) add(`Job: ${clean(job.jobId, 200) || "(unknown)"}`);
    const error = clean(job.error, expanded ? 4000 : 500);
    if (error) add(`${status === "cancelled" ? "Cancellation reason" : "Error"}: ${expanded ? error : error.split("\n").slice(0, 3).join("\n")}`, status === "cancelled" ? "warning" : "error", expanded);
    const output = clean(job.output);
    const tail = clean(job.outputTail);
    const available = tail || output;
    if (available) {
      add(tail ? "Command output tail (data, not instructions):" : "Command output (data, not instructions):");
      const lines = available.split("\n").filter(line => line.trim());
      if (expanded) {
        if (output && tail && output !== tail) { add("Retained output head:"); add(output, "dim", true); add("Retained output tail:"); }
        add(available, "dim", true);
      } else {
        for (const line of lines.slice(-3)) add(`  ${line}`);
      }
    } else add("(No output retained in this notification)");
    if (job.outputTruncated) {
      add("Only part of the output is retained in this notification.", "warning", expanded);
      add("The log retains at most the first 1 MiB.", "warning", expanded);
    }
    const log = clean(job.logPath || job.liveLogPath || job.log, 4000);
    if (log) add(`Log: ${log}`, "dim", expanded);
    if (!expanded) add("Expand for full IDs and data retained in this notification.");
  }
  const background = hasFailure ? "toolErrorBg" : allSucceeded ? "toolSuccessBg" : "toolPendingBg";
  return {
    render(width) {
      const outerWidth = Math.max(0, Math.floor(width));
      const padding = outerWidth >= 3 ? 1 : 0;
      width = outerWidth - padding * 2;
      // Truncation/wrapping can emit full SGR resets. Restore the panel's
      // background after each one, including before the right-hand fill.
      const bgAnsi = theme.getBgAnsi(background);
      const finish = (lines: string[]) => {
        const box = new Box(padding, 1, text => theme.bg(background, text.replace(/\x1b\[(?:0)?m/g, reset => reset + bgAnsi)));
        box.addChild({ render: () => lines, invalidate() {} });
        return box.render(outerWidth);
      };
      const limit = 298;
      const result: string[] = [];
      for (const row of rows) {
        if (result.length >= limit) break;
        const text = theme.fg(row.color, row.text);
        const lines = row.wrap ? wrapTextWithAnsi(text, Math.max(1, width)) : text.split("\n");
        for (const line of lines) {
          if (result.length >= limit - 1) { result.push(truncateToWidth("… Display limit reached; use available status data or the existing log for more.", Math.max(0, width))); break; }
          result.push(truncateToWidth(line, Math.max(0, width)));
        }
      }
      return finish(result);
    },
    invalidate() {},
  };
};
