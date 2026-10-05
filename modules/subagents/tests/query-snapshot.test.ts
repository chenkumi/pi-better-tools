import assert from "node:assert/strict";
import test from "node:test";
import { ulid } from "ulid";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { controlText, pendingTools, safeSnapshot, validateInteraction } from "../extensions/subagent/query-snapshot.ts";

const header = { type: "session" as const, version: 3, id: ulid().toLowerCase(), cwd: process.cwd(), timestamp: "2026-10-05T00:00:00.000Z" };
function entries(messages: any[]) { return messages.map((message, index) => ({ type: "message" as const, id: `entry-${index}`, parentId: index ? `entry-${index - 1}` : null, timestamp: header.timestamp, message })); }
const call = { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "write", arguments: {} }], stopReason: "toolUse", timestamp: 2 };
const result = { role: "toolResult", toolCallId: "call-1", toolName: "write", content: [{ type: "text", text: "done" }], timestamp: 3 };
test("long-tool query captures preceding canonical prefix, never an unpaired tool call", () => {
	const source = entries([{ role: "user", content: "task", timestamp: 1 }, call]);
	const before = structuredClone(source);
	const snapshot = safeSnapshot(header, source, "entry-1", "effective prompt");
	assert.equal(snapshot.asOf.entryId, "entry-0"); assert.equal(snapshot.asOf.stale, true);
	assert.deepEqual(snapshot.asOf.pendingToolCallIds, ["call-1"]);
	assert.equal(snapshot.messages.some(m => m.role === "assistant"), false);
	assert.equal(pendingTools(snapshot.messages).size, 0); assert.deepEqual(source, before);
});
test("complete snapshot preserves system/opaque assistant metadata but removes executable declarations", () => {
	const messages = [{ role: "system", content: "system", sections: { identity: "agent" }, toolsAdded: [{ name: "write", parameters: {} }], timestamp: 0 },
		{ role: "user", content: controlText("id123", "/skill:literal\n@path"), timestamp: 1 }, call, result,
		{ role: "assistant", provider: "offline", model: "fixture", content: [{ type: "thinking", thinking: "private", thinkingSignature: "opaque-signature" }, { type: "text", text: "visible" }], stopReason: "stop", responseId: "opaque-response", timestamp: 4 }];
	const source = entries(messages); const before = structuredClone(source);
	const snapshot = safeSnapshot(header, source, source.at(-1)!.id, "fallback");
	assert.equal(snapshot.asOf.stale, false); assert.deepEqual(snapshot.asOf.appliedControlIds, ["id123"]);
	assert.deepEqual((snapshot.messages[0] as any).toolsAdded, []);
	assert.deepEqual((snapshot.messages[0] as any).sections, { identity: "agent" });
	assert.deepEqual((snapshot.messages.at(-1) as any).content[0], messages.at(-1)!.content[0]);
	assert.equal((snapshot.messages.at(-1) as any).responseId, "opaque-response");
	assert.deepEqual(source, before);
});
test("compaction is replayed with its canonical system checkpoint, not concatenated readable logs", () => {
	const source: any[] = entries([{ role: "user", content: "old task", timestamp: 1 }, { role: "assistant", content: [{ type: "text", text: "old result" }], stopReason: "stop", timestamp: 2 }]);
	source.push({ type: "compaction", id: "compact", parentId: "entry-1", timestamp: header.timestamp, firstKeptEntryId: "compact", summary: "canonical summary", tokensBefore: 100,
		systemMessage: { role: "system", content: "compacted prompt", toolsAdded: [{ name: "write", parameters: {} }], timestamp: 0 } });
	const snapshot = safeSnapshot(header, source, "compact", "fallback");
	assert.equal((snapshot.messages[0] as any).content, "compacted prompt");
	assert.deepEqual((snapshot.messages[0] as any).toolsAdded, []);
	assert.ok(JSON.stringify(snapshot.messages).includes("canonical summary"));
	assert.equal(JSON.stringify(snapshot.messages).includes("old result"), false);
});
test("branches, orphan results, and context edits breaking pairing fail closed", () => {
	const branched = entries([{ role: "user", content: "first", timestamp: 0 }, { role: "user", content: "second", timestamp: 1 }]); branched[1].parentId = null;
	assert.throws(() => safeSnapshot(header, branched, "entry-1", ""), /single canonical chain/);
	assert.throws(() => safeSnapshot(header, entries([result]), "entry-0", ""), /orphan raw/);
	const source: any[] = entries([{ role: "user", content: "task", timestamp: 0 }, call, result]);
	source.push({ type: "context_edit", id: "edit", parentId: "entry-2", targetId: "entry-1", replacement: null, timestamp: header.timestamp });
	assert.throws(() => safeSnapshot(header, source, "edit", ""), /orphan or duplicate tool result/);
});
test("interaction text remains literal and is UTF-8 bounded", () => {
	assert.equal(controlText("abc", "/template @file $&"), "[Delegated user control abc]\n/template @file $&");
	validateInteraction("🙂".repeat(16384));
	for (const text of [" ", "🙂".repeat(16385), undefined]) assert.throws(() => validateInteraction(text), /INVALID_MESSAGE/);
});
test("host ignoring inMemory replay entries fails closed rather than querying an empty guessed context", () => {
	const original = SessionManager.inMemory;
	SessionManager.inMemory = (cwd, options) => original(cwd, options);
	try { assert.throws(() => safeSnapshot(header, entries([{ role: "user", content: "task", timestamp: 1 }]), "entry-0", ""), /QUERY_HOST_UNSUPPORTED/); }
	finally { SessionManager.inMemory = original; }
});
