import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getActiveLineageEntryIds } from "../src/core/lineage.js";
import { loadAllMessages } from "../src/core/load-messages.js";
import { renderMessage } from "../src/core/render-entries.js";
import { searchEntriesDetailed } from "../src/core/search-entries.js";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function history() {
  const dir = mkdtempSync(join(tmpdir(), "bh-review-recall-")); dirs.push(dir);
  const file = join(dir, "session.jsonl");
  writeFileSync(file, JSON.stringify({ type: "message", id: "old", parentId: null, timestamp: new Date(0).toISOString(), message: { role: "user", content: "old branch", timestamp: 0 } }) + "\n");
  return file;
}
describe("R15 fail-closed lineage and distinct cache scopes", () => {
  it("matches real Pi 1.1 resetLeaf shape without expanding to abandoned entries", () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage({ role: "user", content: "abandoned", timestamp: 0 });
    manager.resetLeaf();
    expect(manager.getEntries()).toHaveLength(1);
    expect(getActiveLineageEntryIds(manager).size).toBe(0);
  });
  it("throwing branch lookup cannot grant all-history authority", () => {
    expect([...getActiveLineageEntryIds({ getBranch() { throw Error("unavailable"); }, getEntries: () => [{ id: "old" }] })]).toEqual([]);
  });
  it.each([false, true])("cache isolates empty lineage in both orders (empty first=%s)", emptyFirst => {
    const file = history();
    const empty = () => loadAllMessages(file, false, new Set());
    const all = () => loadAllMessages(file, false);
    const first = emptyFirst ? empty() : all();
    const second = emptyFirst ? all() : empty();
    expect((emptyFirst ? first : second).rawMessages).toEqual([]);
    expect((emptyFirst ? second : first).entryIds).toEqual(["old"]);
  });
});
describe("R5 conservative regex admission", () => {
  // Short matching inputs demonstrate unsafe admission, not catastrophic timing.
  // No long failing tail is ever passed to a native matcher in the test process.
  it.each(["(a+)+", "(a|aa)+", "a+a+", "(a)\\1", "a{1,100}"])("treats unsafe %s as literal", query => {
    const msg: any = { role: "user", content: "aaaa", timestamp: 0 };
    expect(searchEntriesDetailed([renderMessage(msg, 0, "old", false)], [msg], query).hits).toEqual([]);
  });
  it("retains finite alternation, classes, anchors and literal unsafe-pattern lookup", () => {
    for (const [query, text] of [["hook|inject", "inject"], ["^user", "hook"], ["[ab]cd", "acd"], ["(a+)+$", "literal (a+)+$"]]) {
      const msg: any = { role: "user", content: text, timestamp: 0 };
      expect(searchEntriesDetailed([renderMessage(msg, 0, "old", false)], [msg], query).hits).toHaveLength(1);
    }
  });
});
