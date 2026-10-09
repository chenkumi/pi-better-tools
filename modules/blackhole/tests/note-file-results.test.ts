import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { normalize } from "../src/core/normalize.js";
import { buildSections } from "../src/core/build-sections.js";
import { collectFilesTouched } from "../src/extract/file-touch.js";
import { loadAllMessages } from "../src/core/load-messages.js";
import { getTouchedFiles, searchEntriesDetailed } from "../src/core/search-entries.js";
import { expandEntryFile } from "../src/core/drill-down.js";
import { registerRecallTool } from "../src/tools/recall.js";

let time = 0;
const call = (...calls: any[]): any => ({ role: "assistant", content: calls.map(([id, name, args]) => ({ type: "toolCall", id, name, arguments: args })), timestamp: ++time });
const result = (id: string, name: string, details: any, isError = false, text = "result"): any => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], details, isError, timestamp: ++time });
const sections = (messages: any[], fileOps?: any) => buildSections({ blocks: normalize(messages), messages, cwd: "/repo", fileOps });
function session(messages: any[], fn: (file: string, dir: string) => any) {
  const dir = mkdtempSync(join(tmpdir(), "blackhole-note-file-")), file = join(dir, "session.jsonl");
  writeFileSync(file, messages.map((message, i) => JSON.stringify({ type: "message", id: `entry${i}`, message })).join("\n"));
  return Promise.resolve().then(() => fn(file, dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}
const noteArgs = { type: "report", content: "# N\n\nFIND_NOTE_CONTENT\n" };
const writeDetails = { path: "src/new.ts", created: true, bytes: 1, sha256: "a".repeat(32) };

describe("B1: result-authoritative Note and File tools", () => {
  it("matches parallel note results by toolCallId and classifies only successful returned paths", () => {
    const messages = [call(["n1", "note", noteArgs], ["n2", "note", { type: "plan", content: "# Plan" }], ["nf", "note", noteArgs], ["nm", "note", noteArgs]),
      result("n2", "note", { relativePath: "plan/PLAN-20261009T110000001Z.md" }),
      result("nf", "note", { relativePath: "report/WRONG.md" }, true, "NOTE_EMPTY"),
      result("n1", "note", { relativePath: "report/REPORT-20261009T110000000Z.md" }, false, "Saved note: report/BODY_FAKE.md")];
    const s = sections(messages), list = s.filesAndChanges.join("\n");
    expect(list).toContain("Created (2)"); expect(list).toContain("report/REPORT-20261009T110000000Z.md"); expect(list).toContain("plan/PLAN-20261009T110000001Z.md");
    expect(list).not.toMatch(/WRONG|BODY_FAKE/); expect(s.briefTranscript).toContain("NOTE_EMPTY");
    expect(collectFilesTouched(messages, "/repo")).toHaveLength(2);
  });
  it("does not resurrect error/cancelled/unexecuted or result-missing file attempts via args or native seeds", () => {
    const messages = [call(["wf", "write", { path: "failed.ts", content: "x" }], ["wm", "write", { path: "missing.ts", content: "x" }], ["ec", "edit", { path: "cancel.ts", edits: [{ oldText: "x", newText: "y" }] }], ["ru", "read", { path: "unexecuted.ts" }]),
      result("wf", "write", {}, true, "[FILE_TOOL_ERROR] STALE_FILE"), result("ec", "edit", {}, true, "[FILE_TOOL_ERROR] OPERATION_ABORTED"), result("ru", "read", undefined, true, "Provider request failed; previous tool call was not executed")];
    expect(sections(messages, { modifiedFiles: ["failed.ts", "missing.ts", "cancel.ts"], readFiles: ["unexecuted.ts"] }).filesAndChanges).toEqual([]);
  });
  it("uses successful write created and corrected read path; no-op edits do not claim modification", () => {
    const messages = [call(["w", "write", { path: "src/new.ts", content: "x" }], ["r", "read", { path: "bad/request.md" }], ["e", "edit", { path: "same.ts", edits: [{ oldText: "a", newText: "a" }] }]),
      result("w", "write", writeDetails, false, '[FILE_WRITE_SUCCESS] {"created":true}'),
      result("r", "read", { path: "skills/actual.md", pathAutoCorrected: true, requestedPath: "bad/request.md", sha256: "b".repeat(32) }, false, "[FILE_METADATA]"),
      result("e", "edit", { appliedEdits: 1, changedCount: 0, sha256Before: "a".repeat(32), sha256After: "a".repeat(32) }, false, "[FILE_EDIT_SUCCESS] no diff")];
    const list = sections(messages).filesAndChanges.join("\n");
    expect(list).toContain("Created (1)"); expect(list).toContain("src/new.ts"); expect(list).toContain("skills/actual.md"); expect(list).not.toMatch(/bad\/request|same\.ts/);
  });
  it("separates a successful exact-path retry from historical errors and unrelated same-tool successes", () => {
    const messages = [call(["a", "write", { path: "src/a.ts", content: "x" }]), result("a", "write", {}, true, "STALE_FILE"),
      call(["other", "write", { path: "src/b.ts", content: "x" }]), result("other", "write", { ...writeDetails, path: "src/b.ts", created: false }, false, "[FILE_WRITE_SUCCESS]"),
      call(["retry", "write", { path: "src/a.ts", content: "x" }]), result("retry", "write", { ...writeDetails, path: "src/a.ts", created: false }, false, "[FILE_WRITE_SUCCESS]"),
      call(["failed", "edit", { path: "src/c.ts", edits: [{ oldText: "a", newText: "b" }] }]), result("failed", "edit", {}, true, "ERROR_OLD"),
      call(["unrelated", "edit", { path: "src/d.ts", edits: [{ oldText: "a", newText: "b" }] }]), result("unrelated", "edit", { changedCount: 1 }, false, "[FILE_EDIT_SUCCESS]")];
    const s = sections(messages);
    expect(s.outstandingContext.join("\n")).not.toContain("STALE_FILE"); expect(s.outstandingContext.join("\n")).toContain("ERROR_OLD");
    expect(s.briefTranscript).toContain("STALE_FILE"); expect(s.briefTranscript).toContain("ERROR_OLD");
    const finalFailure = sections([...messages, call(["again", "write", { path: "src/a.ts", content: "x" }]), result("again", "write", {}, true, "FAILED_AGAIN")]);
    expect(finalFailure.outstandingContext.join("\n")).toContain("FAILED_AGAIN");
  });
  it("discovers note content, successful path, touched listing and paged drilldown without changing raw args or reading the document", async () => {
    const messages = [call(["n", "note", noteArgs]), result("n", "note", { relativePath: "report/SUCCESS.md" }, false, "Saved note: report/SUCCESS.md")];
    await session(messages, async (file, dir) => {
      const document = join(dir, "document.md"); writeFileSync(document, "IMMUTABLE\r\n");
      const before = createHash("sha256").update(readFileSync(document)).digest("hex");
      const loaded = loadAllMessages(file, false);
      expect(loaded.rawMessages[0]).toEqual(messages[0]);
      expect(searchEntriesDetailed(loaded.rendered, loaded.rawMessages, "FIND_NOTE_CONTENT", undefined, "file").hits).toHaveLength(1);
      expect(searchEntriesDetailed(loaded.rendered, loaded.rawMessages, "report/SUCCESS.md", undefined, "file").hits).toHaveLength(1);
      expect(getTouchedFiles(loaded.rawMessages, loaded.rendered)).toEqual([{ path: "report/SUCCESS.md", entries: [{ index: 0, toolName: "note" }] }]);
      expect(expandEntryFile(file, 0, "report/SUCCESS.md", true)).toContain(noteArgs.content);
      const ctx = { sessionManager: { getSessionFile: () => file, getBranch: () => messages.map((message, i) => ({ type: "message", id: `entry${i}`, message })) } };
      let tool: any;
      registerRecallTool({ registerTool: (t: any) => { tool = t; } } as any, { config: { recallResponseMaxChars: 200 } } as any);
      const r = await tool.execute("recall", { query: "#0:report/SUCCESS.md:full" }, undefined, undefined, ctx);
      expect(r.content[0].text).toContain("FIND_NOTE_CONTENT"); expect(r.content[0].text.length).toBeLessThanOrEqual(200);
      expect(createHash("sha256").update(readFileSync(document)).digest("hex")).toBe(before);
    });
  });
  it("does not resolve a note failure from a pathless/unsafe acknowledgement; exact-payload retry preserves the error history", () => {
    const failed = [call(["fail", "note", noteArgs]), result("fail", "note", undefined, true, "NOTE_ENOSPC")];
    const unsafe = sections([...failed, call(["bad", "note", noteArgs]), result("bad", "note", { relativePath: "../outside.md" }, false, "Saved note")]);
    expect(unsafe.outstandingContext.join("\n")).toContain("NOTE_ENOSPC");
    const good = sections([...failed, call(["good", "note", noteArgs]), result("good", "note", { relativePath: "report/RETRY.md" })]);
    expect(good.outstandingContext.join("\n")).not.toContain("NOTE_ENOSPC"); expect(good.briefTranscript).toContain("NOTE_ENOSPC");
  });
  it("preserves literal modern file paths rather than editor-looking string aliases", () => {
    const messages = [call(["w", "write", { path: "src/literal.ts#L12", content: "x" }], ["r", "read", { path: "src/data.ts:10-40" }]),
      result("w", "write", { ...writeDetails, path: "src/literal.ts#L12", created: false }), result("r", "read", { path: "src/data.ts:10-40", sha256: "b".repeat(32) })];
    const list = sections(messages).filesAndChanges.join("\n");
    expect(list).toContain("src/literal.ts#L12"); expect(list).toContain("src/data.ts:10-40");
  });
  it("keeps note full display within the existing 50KiB byte cap for UTF8", async () => {
    const messages = [call(["utf", "note", { type: "report", content: "界\n".repeat(30000) }]), result("utf", "note", { relativePath: "report/UTF8.md" })];
    await session(messages, file => {
      const text = expandEntryFile(file, 0, "report/UTF8.md", true);
      const body = text.split("\n\n")[1];
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(50 * 1024); expect(body).not.toContain("�");
    });
  });
  it("keeps the actual multiline FileToolError scalar code/message in bounded error history, without promoting body status", () => {
    const error = '[FILE_TOOL_ERROR]\n' + JSON.stringify({ status: "error", code: "STALE_FILE", message: "Version guard failed." });
    const failed = [call(["f", "edit", { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] }]), result("f", "edit", undefined, true, error)];
    const s = sections(failed);
    expect(s.briefTranscript).toContain("STALE_FILE"); expect(s.briefTranscript).toContain("Version guard failed."); expect(s.outstandingContext.join("\n")).toContain("STALE_FILE");
    const success = sections([call(["r", "read", { path: "data.txt" }]), result("r", "read", { path: "data.txt", sha256: "a".repeat(32) }, false, error)]);
    expect(success.outstandingContext).toEqual([]);
  });
  it("takes modern changedCount from successful details, not noop-looking text quoted in a diff", () => {
    const messages = [call(["edit", "edit", { path: "actual.ts", edits: [{ oldText: "before", newText: "no changes made" }] }]),
      result("edit", "edit", { appliedEdits: 1, changedCount: 1, sha256Before: "a".repeat(32), sha256After: "b".repeat(32) }, false, '[FILE_EDIT_SUCCESS] {"edits":1}\n[DIFF]\n+ no changes made')];
    expect(sections(messages).filesAndChanges.join("\n")).toContain("actual.ts");
  });
  it("keeps note search bounded and raw drilldown available, rejecting unsafe paths, mismatched/duplicate IDs", async () => {
    const content = "# LONG_FRONT\n" + "x\n".repeat(40000) + "LATE_NOT_INDEXED";
    const messages = [call(["n", "note", { type: "report", content }], ["escape", "note", noteArgs], ["wrong", "note", noteArgs], ["dup", "note", noteArgs], ["dup", "note", noteArgs]),
      result("n", "note", { relativePath: "report/LONG.md" }), result("escape", "note", { relativePath: "../outside.md" }), result("wrong", "write", { relativePath: "report/WRONG.md" }), result("dup", "note", { relativePath: "report/DUP.md" })];
    await session(messages, async file => {
      const loaded = loadAllMessages(file, false);
      expect(searchEntriesDetailed(loaded.rendered, loaded.rawMessages, "LONG_FRONT", undefined, "file").hits).toHaveLength(1);
      expect(searchEntriesDetailed(loaded.rendered, loaded.rawMessages, "LATE_NOT_INDEXED", undefined, "file").hits).toHaveLength(0);
      expect(expandEntryFile(file, 0, "report/LONG.md", true)).toContain("50KB display limit");
      expect(expandEntryFile(file, 0, "report/LONG.md", false, 40001, 2)).toContain("LATE_NOT_INDEXED");
      expect(sections(messages).filesAndChanges.join("\n")).not.toMatch(/outside|WRONG|DUP/);
      expect(expandEntryFile(file, 0, "file")).not.toContain("operations");
    });
  });
});
