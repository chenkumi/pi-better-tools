import type { Message } from "@earendil-works/pi-ai";
import type { NormalizedBlock } from "../types.js";
import { extractPath } from "./tool-args.js";

type Call = Extract<NormalizedBlock, { kind: "tool_call" }>;
type Result = Extract<NormalizedBlock, { kind: "tool_result" }>;
export interface ToolPair { call: Call; callIndex: number; result?: Result; resultIndex?: number }
export const FILE_TOOL_NAMES = new Set(["note", "read", "write", "edit", "Read", "Write", "Edit", "View", "view", "read_file", "write_file", "edit_file", "MultiEdit"]);

/** Exact unique ID/name/chronological correlation, never nearest-name inference. */
export function pairToolBlocks(blocks: NormalizedBlock[]): Map<string, ToolPair> {
  const calls = new Map<string, ToolPair>(), duplicates = new Set<string>(), results = new Map<string, { result: Result; index: number }>();
  blocks.forEach((b, index) => {
    if ((b.kind !== "tool_call" && b.kind !== "tool_result") || !b.toolCallId) return;
    const id = b.toolCallId;
    if (b.kind === "tool_call") {
      if (calls.has(id)) duplicates.add(id);
      else calls.set(id, { call: b, callIndex: index });
    } else {
      if (results.has(id)) duplicates.add(id);
      else results.set(id, { result: b, index });
    }
  });
  for (const [id, p] of calls) {
    if (duplicates.has(id)) { calls.delete(id); continue; }
    const r = results.get(id);
    if (r && r.index > p.callIndex && r.result.name === p.call.name) { p.result = r.result; p.resultIndex = r.index; }
  }
  return calls;
}

/** Read-only adapter; does not alter raw arguments or persist synthetic path fields. */
export function pairFileMessages(messages: Message[]): Map<string, ToolPair> {
  const blocks: NormalizedBlock[] = [];
  messages.forEach((m, sourceIndex) => {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const p of m.content) if (p.type === "toolCall") blocks.push({ kind: "tool_call", name: p.name, args: p.arguments, toolCallId: p.id, sourceIndex });
    } else if (m.role === "toolResult") {
      blocks.push({ kind: "tool_result", name: m.toolName, toolCallId: m.toolCallId, isError: m.isError, details: m.details,
        text: Array.isArray(m.content) ? m.content.filter(p => p.type === "text").map(p => p.text).join("\n") : "", sourceIndex });
    }
  });
  return pairToolBlocks(blocks);
}
export const succeeded = (p: ToolPair): boolean => p.result?.isError === false;
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

export function noteResultPath(p: ToolPair): string | undefined {
  if (p.call.name !== "note" || !succeeded(p)) return;
  const { type, content } = p.call.args;
  if (typeof type !== "string" || !["plan", "issue", "research", "report", "task"].includes(type) || typeof content !== "string" || !content.trim()) return;
  const path = object(p.result?.details).relativePath;
  // Validate a workspace-relative returned path, not a guessed filename/date.
  if (typeof path !== "string" || path.length > 1024 || /[\\:\u0000-\u001f\u007f]/.test(path)) return;
  const parts = path.split("/");
  if (parts.length !== 2 || parts[0] !== type || !parts[1] || parts[1] === "." || parts[1] === "..") return;
  return path;
}
export function successfulNotePaths(messages: Message[]): Map<string, string> {
  const paths = new Map<string, string>();
  for (const [id, p] of pairFileMessages(messages)) { const path = noteResultPath(p); if (path) paths.set(id, path); }
  return paths;
}
export function noOpFileResult(p: ToolPair): boolean {
  const count = object(p.result?.details).changedCount;
  if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) return count === 0;
  return /applied:\s*0|no changes applied|no changes made|nothing to (?:do|change)|classification:\s*noop/i.test(p.result?.text ?? "");
}
export function fileResult(p: ToolPair): { path: string; operation: "read" | "write" | "edit" | "create"; literalPath?: boolean } | undefined {
  if (!succeeded(p) || !FILE_TOOL_NAMES.has(p.call.name)) return;
  if (p.call.name === "note") { const path = noteResultPath(p); return path ? { path, operation: "create" } : undefined; }
  const details = object(p.result?.details), name = p.call.name.toLowerCase();
  const token = (v: unknown) => typeof v === "string" && /^[a-fA-F0-9]{32}$/.test(v);
  const literal = token(details.sha256) || (token(details.sha256Before) && token(details.sha256After)) ? { literalPath: true } : {};
  let path = extractPath(p.call.args);
  if ((name === "read" || name === "read_file" || name === "view") && typeof details.path === "string" && details.path) path = details.path;
  if (!path) return;
  if (name === "read" || name === "read_file" || name === "view") return { path, operation: "read", ...literal };
  if (name === "write" || name === "write_file") return { path, operation: details.created === true ? "create" : "write", ...literal };
  if (noOpFileResult(p)) return;
  return { path, operation: "edit", ...literal };
}
