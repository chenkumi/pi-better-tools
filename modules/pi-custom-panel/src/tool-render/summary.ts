// What the two collapsed rows say for each tool. Pure functions over untrusted tool arguments and results: no theme, no width.
import { stripVTControlCharacters } from "node:util";

/** Same rules as the live-view text sanitiser: no escape sequences, no cursor/row control, no bidi overrides. */
export function safeText(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/\r\n?/g, "\n").replace(/\t/g, "  ")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩]/g, "");
}

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);
const firstLine = (text: string) => safeText(text).split("\n").find(line => line.trim())?.trim() ?? "";

/** Argument keys that identify what a call acts on, most specific first. */
const SUMMARY_KEYS = ["command", "pattern", "query", "path", "file_path", "url", "jobId", "task", "title", "name", "action", "type"];

export interface CallTitle {
  /** `name` shown bold, or the shell prompt marker for command tools. */
  label: string;
  /** What the call acts on; shortened from the middle-less end when the row is narrow. */
  target: string;
  /** Kept whole when the row is shortened, e.g. `(timeout 20s)`. */
  suffix: string;
}

const SHELL_TOOLS = new Set(["bash", "powershell", "shell"]);
export const isShellTool = (toolName: string) => SHELL_TOOLS.has(toolName);

/** `(timeout 20s)` from `timeoutMs`, or the legacy seconds-based `timeout`. */
function timeoutSuffix(args: Rec): string {
  const ms = typeof args.timeoutMs === "number" ? args.timeoutMs : typeof args.timeout === "number" ? args.timeout * 1000 : undefined;
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return "";
  const seconds = ms / 1000;
  return ` (timeout ${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s)`;
}

export function callTitle(toolName: string, args: unknown): CallTitle {
  const record = isRec(args) ? args : {};
  const text = (key: string) => typeof record[key] === "string" ? firstLine(record[key] as string) : "";
  if (isShellTool(toolName)) return { label: "$", target: text("command"), suffix: timeoutSuffix(record) };
  for (const key of SUMMARY_KEYS) if (text(key)) return { label: toolName, target: text(key), suffix: "" };
  const anyString = Object.values(record).find((value): value is string => typeof value === "string" && value.trim() !== "");
  return { label: toolName, target: anyString ? firstLine(anyString) : "", suffix: "" };
}

export interface ResultView {
  /** Sanitised result text, one entry per line (no trailing blank). */
  lines: string[];
  /** Second collapsed row, without the duration. */
  summary: string;
  isError: boolean;
}

function contentOf(result: unknown): { text: string; images: number } {
  const content = isRec(result) && Array.isArray(result.content) ? result.content : [];
  let images = 0;
  const text = content.map(part => {
    if (!isRec(part)) return "";
    if (part.type === "image") { images++; return ""; }
    return typeof part.text === "string" ? part.text : "";
  }).join("\n");
  return { text, images };
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Collapsed second row. Every branch falls back to the first non-empty line, so an unknown tool still says something useful. */
export function resultView(toolName: string, result: unknown, isError: boolean): ResultView {
  const { text, images } = contentOf(result);
  const details = isRec(result) && isRec(result.details) ? result.details : {};
  // write/edit put a machine marker in the model-visible text; the expanded view shows what the details say instead.
  const readable = isError ? undefined
    : toolName === "write" && typeof details.bytes === "number" ? [`${details.created === true ? "Created" : "Updated"} ${typeof details.path === "string" ? details.path : "file"}`, `${details.bytes} bytes`].join("\n")
    : toolName === "edit" && typeof details.diff === "string" && details.diff.trim() ? details.diff
    : undefined;
  const lines = safeText(readable ?? text).split("\n");
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const first = lines.find(line => line.trim())?.trim() ?? "";
  const more = lines.length > 1 ? ` (+${lines.length - 1} ${lines.length - 1 === 1 ? "line" : "lines"})` : "";
  let summary: string;
  if (isError) summary = first || "failed";
  else if (isShellTool(toolName)) summary = lines.length ? plural(lines.length, "line") + " of output" : "no output";
  else if (toolName === "write" && num(details.bytes) !== undefined) summary = `${plural(num(details.bytes)!, "byte")} written`;
  else if (toolName === "edit" && (num(details.changedCount) ?? num(details.appliedEdits)) !== undefined) summary = `${plural((num(details.changedCount) ?? num(details.appliedEdits))!, "edit")} applied`;
  else if (toolName === "read") summary = images ? `${plural(images, "image")}${lines.length ? `, ${plural(lines.length, "line")}` : ""}` : plural(lines.length, "line");
  else if (!lines.length) summary = images ? plural(images, "image") : "done";
  else summary = `${first}${more}`;
  return { lines, summary, isError };
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
