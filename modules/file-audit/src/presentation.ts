import { stripVTControlCharacters } from "node:util";
import { relative } from "node:path";
import type { ActivityWindow } from "./activity-window.js";
import type { ScanResult } from "./provenance.js";

export const MAX_OUTPUT_BYTES = 8192;
const MAX_DETAIL_LINES = 10;
const REPORT_HEADER = "File Audit — recent incremental inspection, NOT full-project verification.";
export function safeText(value: string, max = 200): string {
  return stripVTControlCharacters(value.slice(0, max * 4)).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ").slice(0, max);
}
function bounded(lines: string[]): string {
  let result = "";
  for (const line of lines) {
    if (Buffer.byteLength(result, "utf8") + Buffer.byteLength(line, "utf8") + 1 > MAX_OUTPUT_BYTES - 80) return result + "\nFurther display details omitted.";
    result += (result ? "\n" : "") + line;
  }
  return result;
}
export function statusText(window: ActivityWindow, pending: number, cwd: string): string {
  const files = window.snapshot(), limits = window.limits;
  return bounded([
    REPORT_HEADER,
    `Observation starts: ${window.since}; run: ${window.run}; window: ${limits.windowRuns}; max-files: ${limits.maxFiles}`,
    `Candidates: ${files.length}; pending: ${pending}`,
    `Eviction/skip EVENTS (not unique file counts): capacity=${window.stats.capacityEvictions}, expired=${window.stats.expired}, skipped=${window.stats.skipped}`,
    "Only successful read/write/edit/note since observation start; no Shell/search/other sessions/history replay.",
    ...files.slice(0, MAX_DETAIL_LINES).map(item => `${item.createdRun !== undefined ? "created" : item.writeRun !== undefined ? "modified" : "read"}: ${safeText(relative(cwd, item.path))} (last: ${item.action})`),
    ...(files.length > MAX_DETAIL_LINES ? [`${files.length - MAX_DETAIL_LINES} retained file details hidden.`] : []),
  ]);
}
export function resultText(result: ScanResult, cwd: string): string {
  const counts = new Map<string, number>();
  for (const item of result.findings) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  const checked = (counts.get("matched") ?? 0) + (counts.get("mismatch") ?? 0) + (counts.get("expected-absent") ?? 0) + (counts.get("missing") ?? 0);
  const details = result.findings.filter(item => item.status !== "matched" && item.status !== "expected-absent");
  return bounded([
    REPORT_HEADER,
    `Selected: ${result.findings.length}; checked: ${checked}; content bytes: ${result.bytes}; metadata bytes: ${result.metadataBytes}; elapsed: ${Math.round(result.elapsedMs)}ms`,
    Array.from(counts, ([status, count]) => `${status}=${count}`).join(", ") || "No candidates; no verification performed.",
    ...(result.error ? [`Inspection unavailable: ${safeText(result.error)}`] : []),
    ...details.slice(0, MAX_DETAIL_LINES).map(item => `${item.status}: ${safeText(relative(cwd, item.path))}${item.reason ? ` (${safeText(item.reason)})` : ""}`),
    ...(details.length > MAX_DETAIL_LINES ? [`${details.length - MAX_DETAIL_LINES} finding details hidden.`] : []),
    ...(result.findings.some(item => item.historical) ? ["Historical earlier diff unavailable: matching hashes do not certify historical-diff equivalence."] : []),
    "Only selected recent files were inspected. Untracked/skipped/unavailable items are NOT passes; no author or change-time attribution.",
  ]);
}
