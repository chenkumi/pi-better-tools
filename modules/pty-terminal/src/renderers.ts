import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const clean = (value: unknown, max = 1000) => typeof value === "string" || typeof value === "number"
  ? stripVTControlCharacters(String(value).slice(0, max * 4)).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").slice(0, max) : "";
const oneLine = (value: unknown, max = 300) => clean(value, max).replace(/\s+/g, " ");
type Action = "spawn" | "write" | "read" | "resize" | "wait_exit" | "kill" | "list";

/** Presentation only: never spawn, drain, write, resize or terminate a PTY. */
export function ptyRenderers(action: Action): Pick<ToolDefinition, "renderCall" | "renderResult"> {
  const name = `pty_${action}`;
  return {
    renderCall(args, theme) {
      const input = record(args);
      const target = action === "spawn" ? `${oneLine(input.command) || "…"} · target ${oneLine(input.target) || "local"}`
        : action === "list" ? "sessions" : oneLine(input.sessionId) || "…";
      // Do not preview potentially sensitive input/arguments/environment variables.
      return new Text(`${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("accent", target)}`, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
      if (context.isError) return new Text(theme.fg("error", `${name} failed\n${clean(text, expanded ? 4000 : 700)}`), 0, 0);
      if (isPartial) return new Text(theme.fg("muted", `${name} running…`), 0, 0);
      let value: unknown = result.details;
      if (value == null || (!Array.isArray(value) && !Object.keys(record(value)).length)) {
        try { if (text.length <= 64 * 1024) value = JSON.parse(text); } catch { /* legacy or text-only output */ }
      }
      const data = record(value), input = record(context.args);
      const session = oneLine(data.sessionId ?? input.sessionId) || "unknown";
      const lines: string[] = [];
      if (action === "read") {
        const body = clean(text, 50 * 1024);
        const all = body.split("\n");
        lines.push(`PTY output · ${session}`, (expanded ? body : all.slice(0, 12).join("\n")) || "No pending output");
        if (!expanded && all.length > 12) lines.push(`… (${all.length - 12} more lines; expand to view)`);
        if (data.truncated === true) lines.push("Output truncated; drained overflow is not retained in a full-output file.");
      } else if (action === "list") {
        if (!Array.isArray(value)) lines.push("PTY session details unavailable");
        else {
          lines.push(`PTY sessions: ${value.length}`);
          for (const item of value.slice(0, expanded ? 50 : 3)) {
            const entry = record(item);
            lines.push(`${oneLine(entry.sessionId) || "unknown"} · ${oneLine(entry.state) || "unknown state"} · ${oneLine(entry.target) || "unknown target"}/${oneLine(entry.transport) || "unknown transport"}`);
            if (expanded) lines.push(`Local transport PID: ${oneLine(entry.pid) || "?"} · Buffered bytes: ${oneLine(entry.bufferedBytes) || "0"}`);
          }
          if (value.length > (expanded ? 50 : 3)) lines.push("… (session display truncated)");
        }
      } else if (action === "spawn") {
        if (!data.sessionId) lines.push("PTY spawn result details unavailable");
        else lines.push(`PTY session created · ${session}`, `Target: ${oneLine(data.target) || "unknown"} · Transport: ${oneLine(data.transport) || "unknown"}`,
          `Local transport PID: ${oneLine(data.pid) || "?"}`, "Session creation does not confirm remote handshake or command success.");
      } else if (action === "wait_exit") {
        if (typeof data.exitCode !== "number") lines.push("PTY exit details unavailable");
        else if (data.exitCode === -1) lines.push(`PTY wait timed out or exit unconfirmed · ${session}`);
        else lines.push(`PTY transport exit code: ${data.exitCode} · ${session}`, "Transport exit does not verify command/business success or remote descendant termination.");
        if (expanded && typeof data.signal === "number") lines.push(`Signal: ${data.signal}`);
      } else if (text.trim() !== "ok") {
        lines.push(`${name}: result details unavailable`);
        if (expanded) lines.push(clean(text, 2000));
      } else if (action === "kill") {
        lines.push(data.released === false ? `PTY session retained (transport still running) · ${session}` : `PTY session released · ${session}`, "Local transport only; remote process-tree termination not confirmed.");
      } else if (action === "resize") {
        lines.push(`PTY resized · ${session} · ${oneLine(data.cols ?? input.cols) || "?"}×${oneLine(data.rows ?? input.rows) || "?"}`);
      } else {
        lines.push(`PTY input sent · ${session}`);
      }
      const output = lines.join("\n");
      return new Text(theme.fg("toolOutput", output.slice(0, 50 * 1024) + (output.length > 50 * 1024 ? "\n… (display truncated)" : "")), 0, 0);
    },
  };
}
