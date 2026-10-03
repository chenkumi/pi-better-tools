import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ToolResultSpool, toolResultKey, type ToolSpoolRecord } from "../extensions/subagent/tool-result-spool.ts";

const record = (id?: string, text = "same"): ToolSpoolRecord => ({
	toolCallId: id, toolName: "read", isError: false, serialized: { content: [{ type: "text", text }], omitted: [] },
});

test("spool retains only latest undeleted version in update order and isolates identities", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-spool-"));
	try {
		const spool = await ToolResultSpool.create(root);
		const other = await ToolResultSpool.create(root);
		assert.notEqual(spool.directory, other.directory);
		await spool.put(record("a", "old"));
		await spool.put(record("b"));
		await spool.put(record("a", "new"));
		await spool.put(record("deleted"));
		await spool.remove(record("deleted"));
		await spool.put(record(undefined));
		await spool.remove(record(undefined));
		await spool.put(record("../escape"));
		const rows = [];
		for await (const entry of spool.records()) rows.push(entry);
		assert.deepEqual(rows.map((entry) => entry.toolCallId), ["b", "a", "../escape"]);
		assert.equal(rows[1].serialized.content[0].text, "new");
		assert.notEqual(toolResultKey(record("a")), toolResultKey(record("b")));
		assert.notEqual(toolResultKey(record("")), toolResultKey(record(undefined)));
		await assert.rejects(stat(join(root, "escape.json")), { code: "ENOENT" });
		await spool.cleanup();
		await spool.cleanup();
		await other.cleanup();
		await assert.rejects(stat(spool.directory), { code: "ENOENT" });
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("breaking spool iteration closes the journal handle before cleanup", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-spool-break-"));
	try {
		const spool = await ToolResultSpool.create(root);
		await spool.put(record("one"));
		await spool.put(record("two"));
		const originalOpen = fs.promises.open;
		let journalClosed = false;
		t.mock.method(fs.promises, "open", async (...args: Parameters<typeof originalOpen>) => {
			const handle = await originalOpen(...args);
			if (String(args[0]).endsWith("journal.jsonl")) {
				const close = handle.close.bind(handle);
				t.mock.method(handle, "close", async () => { journalClosed = true; return close(); });
			}
			return handle;
		});
		for await (const _entry of spool.records()) break;
		assert.equal(journalClosed, true);
		await spool.cleanup();
	} finally { await rm(root, { recursive: true, force: true }); }
});

for (const operation of ["writeFile", "appendFile", "rename", "unlink"] as const) {
	test(`spool ${operation} failures preserve diagnostic artifacts`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "pi-spool-fail-"));
		try {
			const spool = await ToolResultSpool.create(root);
			await spool.put(record("one", "old"));
			const target = join(spool.directory, `${toolResultKey(record("one"))}.json`);
			const previous = await readFile(target, "utf8");
			const mock = t.mock.method(fs.promises, operation, async () => { throw new Error(`injected ${operation}`); });
			await assert.rejects(operation === "unlink" ? spool.remove(record("one")) : spool.put(record("one", "new")), /diagnostic files preserved/);
			assert.equal(await readFile(target, "utf8"), previous);
			mock.mock.restore();
			await spool.cleanup();
		} finally { await rm(root, { recursive: true, force: true }); }
	});
}

test("spool detects malformed journal and oversized record without unbounded reads", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-spool-corrupt-"));
	try {
		const spool = await ToolResultSpool.create(root);
		await spool.put(record("one"));
		await fs.promises.appendFile(join(spool.directory, "journal.jsonl"), "x".repeat(300));
		await assert.rejects(async () => { for await (const _entry of spool.records()) { /* drain */ } }, /Oversized/);
		await spool.cleanup();
		const oversized = await ToolResultSpool.create(root);
		await assert.rejects(oversized.put(record("large", "x".repeat(1024 * 1024 + 1))), /oversized/i);
		await oversized.cleanup();
	} finally { await rm(root, { recursive: true, force: true }); }
});
