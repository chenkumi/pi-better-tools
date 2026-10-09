import { describe, it, expect } from "vitest";
import { collectFilesTouched } from "../src/extract/file-touch.js";
import { normalize } from "../src/core/normalize.js";
import { buildSections } from "../src/core/build-sections.js";
import { compile, extractSection } from "../src/core/summarize.js";
import { getTouchedFiles } from "../src/core/search-entries.js";

const names = ["read", "write", "edit", "note"] as const;
type Name = typeof names[number];
const call = (name: string, args: any, id = "w"): any => ({ role: "assistant", timestamp: 1,
  content: [{ type: "toolCall", id, name, arguments: args }] });
const result = (name: string, details: any, isError: any = false): any => ({ role: "toolResult", timestamp: 2,
  toolCallId: "w", toolName: name, isError, details, content: [{ type: "text", text: "ok" }] });
const argsFor = (name: Name) => name === "note" ? { type: "report", content: "# stored note\n" }
  : name === "edit" ? { path: "ghost.ts", edits: [{ oldText: "before", newText: "after" }] }
  : name === "write" ? { path: "ghost.ts", content: "after" } : { path: "ghost.ts" };
const detailsFor = (name: Name) => name === "note" ? { relativePath: "report/GHOST.md" }
  : { path: "ghost.ts", created: false, sha256: "a".repeat(32), changedCount: 1,
      sha256Before: "a".repeat(32), sha256After: "b".repeat(32) };
const fileOpsFor = (name: Name) => name === "note" ? undefined
  : name === "read" ? { readFiles: ["ghost.ts"] } : { modifiedFiles: ["ghost.ts"] };
const rendered = (messages: any[]) => messages.map((m, index) => ({ index, role: m.role, summary: "", timestamp: m.timestamp }));
const variants = ["nonfile-mismatch", "nonfile-missing-isError", "before-call", "duplicate-call", "duplicate-result",
  "mixed-duplicate-call-file-first", "mixed-duplicate-call-file-last", "mixed-duplicate-result",
  "missing-isError", "assistant-only", "provider-unexecuted", "cancelled"] as const;
function negative(name: Name, variant: typeof variants[number]): any[] {
  const c = call(name, argsFor(name)), r = result(name, detailsFor(name));
  const bash = call("bash", { command: "touch ghost.ts" });
  switch (variant) {
    case "nonfile-mismatch": return [c, result("bash", {})];
    case "nonfile-missing-isError": { const bad = result("bash", {}); delete bad.isError; return [c, bad]; }
    case "before-call": return [r, c];
    case "duplicate-call": return [c, call(name, argsFor(name)), r];
    case "duplicate-result": return [c, r, result(name, detailsFor(name))];
    case "mixed-duplicate-call-file-first": return [c, bash, result("bash", {})];
    case "mixed-duplicate-call-file-last": return [bash, c, result("bash", {})];
    case "mixed-duplicate-result": return [c, r, result("bash", {})];
    case "missing-isError": delete r.isError; return [c, r];
    case "assistant-only": return [c];
    case "provider-unexecuted": r.isError = true; r.content[0].text = "Provider request failed; tool call was not executed"; return [c, r];
    case "cancelled": r.isError = true; r.content[0].text = "[FILE_TOOL_ERROR] OPERATION_ABORTED"; return [c, r];
  }
}
function noActivity(messages: any[], name: Name) {
  const before = JSON.stringify(messages), blocks = normalize(messages), fileOps = fileOpsFor(name), cwd = "/repo";
  expect(collectFilesTouched(messages, cwd)).toEqual([]);
  expect(buildSections({ blocks, cwd, fileOps }).filesAndChanges).toEqual([]);
  expect(buildSections({ blocks, messages, cwd, fileOps }).filesAndChanges).toEqual([]);
  expect(extractSection(compile({ messages, touchMessages: messages, cwd, fileOps }), "Files And Changes")).toBe("");
  expect(getTouchedFiles(messages, rendered(messages))).toEqual([]);
  expect(JSON.stringify(messages)).toBe(before);
}

describe("B1 review R1: originating File-call authority", () => {
  it("rejects the reported write call / same-ID bash result in the raw collector", () => {
    const messages: any[] = [
      { role: "assistant", timestamp: 1, content: [
        { type: "toolCall", id: "w", name: "write", arguments: { path: "ghost.ts", content: "x" } },
      ] },
      { role: "toolResult", toolCallId: "w", toolName: "bash", isError: false, timestamp: 2,
        content: [{ type: "text", text: "ok" }] },
    ];
    expect(collectFilesTouched(messages, "/repo")).toEqual([]);
    expect(buildSections({ blocks: normalize(messages), messages, cwd: "/repo" }).filesAndChanges).toEqual([]);
  });
  it.each(names.flatMap(name => variants.map(variant => ({ name, variant }))))(
    "$name / $variant fails closed consistently across normalized/raw sections, compact and touched", ({ name, variant }) => {
      noActivity(negative(name, variant), name);
    });
  it.each(names)("retains unique, same-name, later, explicit-false %s success", name => {
    const messages = [call(name, argsFor(name)), result(name, detailsFor(name))], before = JSON.stringify(messages);
    const path = name === "note" ? "report/GHOST.md" : "ghost.ts", blocks = normalize(messages), cwd = "/repo";
    expect(collectFilesTouched(messages, cwd)).toHaveLength(1);
    for (const raw of [false, true]) expect(buildSections({ blocks, ...(raw ? { messages } : {}), cwd }).filesAndChanges.join("\n")).toContain(path);
    expect(extractSection(compile({ messages, touchMessages: messages, cwd }), "Files And Changes")).toContain(path);
    // Existing touched mode indexes content-bearing calls, not path-only reads.
    expect(getTouchedFiles(messages, rendered(messages))).toHaveLength(name === "read" ? 0 : 1);
    expect(JSON.stringify(messages)).toBe(before);
  });
});
