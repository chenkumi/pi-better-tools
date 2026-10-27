import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteClient } from "../src/sqlite-client.js";

test("BLOBs, bigint and bindings round-trip through the JSON IPC channel", async t => {
  const directory = mkdtempSync(join(tmpdir(), "pi-sqlite-ipc-"));
  const client = new SqliteClient();
  t.after(async () => { await client.dispose(); rmSync(directory, { recursive: true, force: true }); });
  const opened = await client.open(join(directory, "ipc.db"));
  assert.equal(opened.success, true, opened.message);
  await client.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, big INTEGER, data BLOB, ratio REAL)");
  const blob = new Uint8Array([0, 1, 2, 253, 254, 255]);
  const big = 2n ** 40n + 1n; // bigint bindings must cross the channel; node:sqlite reads results back as numbers
  await client.execute("INSERT INTO t (name, big, data, ratio) VALUES (?, ?, ?, ?)", ["héllo ✓", big, blob, 1.5]);
  await client.execute("INSERT INTO t (name, big, data) VALUES (:name, :big, :data)", { name: "named", big: 7, data: blob });
  const result = await client.query("SELECT name, big, data, ratio FROM t ORDER BY id");
  assert.equal(result.rowCount, 2);
  assert.equal(result.rows[0]![0], "héllo ✓");
  assert.equal(String(result.rows[0]![1]), String(big));
  assert.deepEqual(new Uint8Array(result.rows[0]![2] as Uint8Array), blob);
  assert.equal(result.rows[0]![3], 1.5);
  assert.equal(result.rows[1]![0], "named");
});
