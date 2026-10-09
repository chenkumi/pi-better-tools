import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { Box, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const clean = (value: unknown, limit = 16000) => typeof value === "string"
  ? stripVTControlCharacters(value.slice(0, limit)).replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\t/g, "  ") : "";

export const renderScheduledMessage: MessageRenderer = (message, { expanded }, theme) => {
  const d = message.details && typeof message.details === "object" && !Array.isArray(message.details) ? message.details as Record<string, unknown> : {};
  const legacy = !d.mode && !d.jobId && !d.jobName && !d.prompt;
  const content = typeof message.content === "string" ? message.content : Array.isArray(message.content)
    ? message.content.filter(b => b && b.type === "text" && typeof b.text === "string").map(b => (b as { text: string }).text).join("\n") : "";
  // Legacy skipped messages had no structured flag. Match only our exact
  // historical runner reason, not arbitrary model text beginning with Skipped.
  const skipped = d.skipped === true || (d.mode === "subagent_done" && d.output === "Skipped: deadline reached or job unavailable before prompt start");
  const failed = d.mode === "subagent_error";
  const done = d.mode === "subagent_done" && !skipped;
  const label = skipped ? "skipped" : failed ? "failed" : done ? "finished" : d.mode === "subagent_start" ? "starting" : legacy || d.mode ? "message (status unknown)" : "delivered (not completed)";
  const background = skipped ? "toolPendingBg" : failed ? "toolErrorBg" : done ? "toolSuccessBg" : "toolPendingBg";
  const color = skipped ? "warning" : failed ? "error" : done ? "success" : "accent";
  const rows: { text: string; color: Parameters<typeof theme.fg>[0] }[] = [{ text: `${skipped ? "!" : failed ? "✗" : done ? "✓" : "○"} Scheduled ${label}: ${clean(d.jobName, 240).replace(/\n/g, " ") || "Unknown"}`, color }];
  if (d.model) rows.push({ text: `Model: ${clean(d.model, 240).replace(/\n/g, " ")}`, color: "dim" });
  if (expanded) {
    rows.push({ text: `Job: ${clean(d.jobId, 200) || "(unknown)"}`, color: "dim" });
    if (d.prompt) rows.push({ text: `Prompt: ${clean(d.prompt)}`, color: "dim" });
  }
  const sourceOutput = failed ? d.error : d.output ?? (legacy ? content : undefined);
  const output = clean(sourceOutput);
  if (output) {
    rows.push({ text: skipped ? "Reason:" : failed ? "Error:" : "Result (untrusted):", color: failed ? "error" : "dim" });
    const lines = output.split("\n").filter(line => line.trim());
    rows.push({ text: expanded ? output : lines.slice(0, 3).map(line => truncateToWidth(line, 240)).join("\n"), color: failed ? "error" : "dim" });
    if (typeof sourceOutput === "string" && sourceOutput.length > 16000) {
      rows.push({ text: "… Display truncated (message content unchanged)", color: "warning" });
    }
  } else if (done || failed || skipped) rows.push({ text: "(No result retained in this message)", color: "dim" });
  else if (!expanded && d.prompt) rows.push({ text: `Prompt: ${clean(d.prompt, 240).replace(/\n/g, " ")}`, color: "dim" });
  if (!expanded) rows.push({ text: "Expand for job ID, prompt and retained result", color: "dim" });
  return {
    render(width) {
      const outerWidth = Math.max(0, Math.floor(width));
      const padding = outerWidth >= 3 ? 1 : 0;
      width = outerWidth - padding * 2;
      const bgAnsi = theme.getBgAnsi(background);
      const finish = (lines: string[]) => {
        const box = new Box(padding, 1, text => theme.bg(background, text.replace(/\x1b\[(?:0)?m/g, reset => reset + bgAnsi)));
        box.addChild({ render: () => lines, invalidate() {} });
        return box.render(outerWidth);
      };
      const limit = 298;
      const lines: string[] = [];
      for (const row of rows) {
        const text = theme.fg(row.color, row.text);
        const wrapped = expanded ? wrapTextWithAnsi(text, Math.max(1, width)) : text.split("\n");
        for (const line of wrapped) {
          if (lines.length >= limit - 1) { lines.push(truncateToWidth("… Display limit (message content unchanged)", Math.max(0, width))); return finish(lines); }
          lines.push(truncateToWidth(line, Math.max(0, width)));
        }
      }
      return finish(lines);
    },
    invalidate() {},
  };
};
