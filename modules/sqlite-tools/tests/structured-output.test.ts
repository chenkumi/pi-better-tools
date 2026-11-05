import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import sqliteExtension from "../src/index.js";

test("every successful sqlite tool result validates against its outputSchema", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-sqlite-structured-"));
  const oldPath = process.env.SQLITE_PATH;
  delete process.env.SQLITE_PATH;
  const tools = new Map<string, ToolDefinition>();
  let onStart: ((event: unknown, ctx: ExtensionContext) => unknown) | undefined;
  let onShutdown: (() => unknown) | undefined;
  const ctx = { cwd: directory, hasUI: false, isProjectTrusted: () => false, ui: { notify: () => undefined } } as unknown as ExtensionToolContext;
  sqliteExtension({
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    on: (event: string, handler: never) => { if (event === "session_start") onStart = handler; else onShutdown = handler; },
    registerCommand: () => undefined,
  } as unknown as ExtensionAPI);
  t.after(async () => {
    await onShutdown?.();
    if (oldPath !== undefined) process.env.SQLITE_PATH = oldPath;
    rmSync(directory, { recursive: true, force: true });
  });
  await onStart?.({ type: "session_start", reason: "startup" }, ctx as unknown as ExtensionContext);

  async function call(name: string, params: Record<string, unknown> = {}) {
    const tool = tools.get(name);
    assert.ok(tool, name);
    assert.ok(tool.outputSchema, `${name} declares outputSchema`);
    const result = await tool.execute("test", params, undefined, undefined, ctx);
    assert.ok(result.structuredContent, `${name} returns structuredContent`);
    assert.equal(Value.Check(tool.outputSchema, result.structuredContent), true, `${name}: ${JSON.stringify([...Value.Errors(tool.outputSchema, result.structuredContent)])}`);
    return result;
  }

  const status = await call("sqlite_status");
  assert.equal((status.structuredContent as { isOpen: boolean }).isOpen, false);
  const opened = await call("sqlite_open", { file_path: "structured.sqlite" });
  assert.equal((opened.structuredContent as { success: boolean }).success, true);
  assert.equal(((await call("sqlite_status")).structuredContent as { isOpen: boolean }).isOpen, true);
  await call("sqlite_execute", { sql: "CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT DEFAULT 'x')" });
  const insert = await call("sqlite_execute", { sql: "INSERT INTO t (id, body) VALUES (?, ?)", bindings: [1, "alpha"] });
  assert.deepEqual(insert.structuredContent, { changes: 1, lastInsertRowid: 1, outputTruncated: false });
  await call("sqlite_execute", { sql: "WITH RECURSIVE n(i) AS (SELECT 2 UNION ALL SELECT i + 1 FROM n WHERE i < 600) INSERT INTO t (id, body) SELECT i, printf('%0300d', i) FROM n" });

  const small = await call("sqlite_query", { sql: "SELECT id, body FROM t WHERE id = ?", bindings: [1] });
  assert.deepEqual(small.structuredContent, { columns: ["id", "body"], rows: [[1, "alpha"]], rowCount: 1, outputTruncated: false });

  // Text is cut at 50 KB: the structured rows must be a prefix that fits, never more than the text shows.
  const big = await call("sqlite_query", { sql: "SELECT id, body FROM t ORDER BY id" });
  const bigStructured = big.structuredContent as { rows: unknown[][]; rowCount: number; outputTruncated: boolean };
  assert.equal(bigStructured.outputTruncated, true);
  assert.equal(bigStructured.rowCount, 600);
  assert.ok(bigStructured.rows.length > 0 && bigStructured.rows.length < 600);
  assert.ok(Buffer.byteLength(JSON.stringify(bigStructured.rows, null, 2)) <= 50 * 1024);
  const bigText = big.content[0].type === "text" ? big.content[0].text : "";
  assert.match(bigText, /Output truncated/);
  assert.ok(bigText.includes(`"${(bigStructured.rows.at(-1) as unknown[])[1]}"`), "last structured row appears in the text");

  const tables = await call("sqlite_list_tables");
  assert.deepEqual((tables.structuredContent as { tables: string[] }).tables, ["t"]);
  const described = await call("sqlite_describe_table", { table_name: "t" });
  assert.equal((described.structuredContent as { rowCount: number }).rowCount, 600);
  await call("sqlite_manual");
  const closed = await call("sqlite_close");
  assert.equal((closed.structuredContent as { success: boolean }).success, true);
});
