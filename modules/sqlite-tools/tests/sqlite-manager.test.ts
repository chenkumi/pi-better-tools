import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { BUSY_TIMEOUT_MS, MAX_BLOB_BYTES, MAX_QUERY_BYTES, MAX_QUERY_ROWS, SqliteManager } from "../src/sqlite-manager.js";

test("supports the SQLite tool workflow with positional and named parameters", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-sqlite-tools-"));
  const manager = new SqliteManager();

  assert.equal(manager.open(join(directory, "app.db")).success, true);
  assert.deepEqual(manager.execute(
    "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)",
  ), { changes: 0, lastInsertRowid: 0 });
  assert.equal(manager.execute("INSERT INTO users (name) VALUES (?)", ["Ada"]).changes, 1);
  assert.equal(manager.execute("INSERT INTO users (name) VALUES (:name)", { name: "Grace" }).changes, 1);

  assert.deepEqual(manager.query("SELECT name FROM users WHERE id = ?", [1]), {
    columns: ["name"],
    rows: [["Ada"]],
    rowCount: 1,
  });
  assert.deepEqual(manager.listTables(), { tables: ["users"] });

  const description = manager.describeTable("users");
  assert.equal(description.rowCount, 2);
  assert.deepEqual(description.columns.map((column) => column.name), ["id", "name"]);
  assert.equal(manager.close().success, true);
});

test("requires a connection and keeps query and execute roles separate", () => {
  const manager = new SqliteManager();
  assert.throws(() => manager.query("SELECT 1"), /No database is currently open/);

  const directory = mkdtempSync(join(tmpdir(), "pi-sqlite-tools-"));
  manager.open(join(directory, "app.db"));
  assert.throws(() => manager.query("CREATE TABLE test (id INTEGER)"), /sqlite_query accepts only/);
  manager.execute("CREATE TABLE test (id INTEGER)");
  assert.throws(() => manager.execute("SELECT * FROM test"), /sqlite_execute does not accept/);
  manager.close();
});

test("quotes unusual table names safely", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-sqlite-tools-"));
  const manager = new SqliteManager();
  manager.open(join(directory, "app.db"));
  manager.execute('CREATE TABLE "odd""name" (value TEXT)');
  manager.execute('INSERT INTO "odd""name" (value) VALUES (?)', ["ok"]);

  assert.equal(manager.describeTable('odd"name').rowCount, 1);
  manager.close();
});

test("keeps the database's journal mode and reports a newly created file", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-sqlite-tools-"));
  const path = join(directory, "existing.db");
  const seed = new DatabaseSync(path);
  seed.exec("CREATE TABLE t (x); INSERT INTO t VALUES (1)");
  seed.close();

  const manager = new SqliteManager();
  assert.match(manager.open(path).message, /^Database opened:/);
  manager.query("SELECT * FROM t");
  manager.close();
  const reopened = new DatabaseSync(path);
  assert.equal((reopened.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "delete");
  reopened.close();

  const created = manager.open(join(directory, "typo.db"));
  assert.equal(created.success, true);
  assert.match(created.message, /did not exist, so a new empty database was created/);
  manager.close();
});

test("bounds rows, bytes and BLOB values read by one query", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-sqlite-tools-"));
  const manager = new SqliteManager();
  manager.open(join(directory, "big.db"));
  manager.execute("CREATE TABLE n (v INTEGER)");
  manager.execute(`INSERT INTO n WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${MAX_QUERY_ROWS + 5}) SELECT x FROM c`);

  const many = manager.query("SELECT v FROM n ORDER BY v");
  assert.equal(many.rowCount, MAX_QUERY_ROWS);
  assert.equal(many.truncated, true);
  assert.deepEqual(manager.query("SELECT v FROM n WHERE v <= 3 ORDER BY v"), { columns: ["v"], rows: [[1], [2], [3]], rowCount: 3 });

  manager.execute("CREATE TABLE b (data BLOB)");
  for (let i = 0; i < 12; i++) manager.execute("INSERT INTO b VALUES (zeroblob(1048576))");
  const blobs = manager.query("SELECT data FROM b");
  const first = blobs.rows[0]![0] as { byteLength: number; data: number[]; truncated: boolean };
  assert.equal(first.byteLength, 1048576);
  assert.equal(first.data.length, MAX_BLOB_BYTES);
  assert.equal(first.truncated, true);
  assert.equal(blobs.truncated, undefined);

  manager.execute("CREATE TABLE s (text TEXT)");
  for (let i = 0; i < 10; i++) manager.execute("INSERT INTO s VALUES (?)", ["x".repeat(MAX_QUERY_BYTES / 4)]);
  const strings = manager.query("SELECT text FROM s");
  assert.ok(strings.rowCount < 10 && strings.rowCount > 0);
  assert.equal(strings.truncated, true);
  manager.close();
});

test("keeps duplicate column names and reports columns for empty results", () => {
  const manager = new SqliteManager();
  manager.open(":memory:");
  assert.deepEqual(manager.query("SELECT 1 AS id, 2 AS id"), { columns: ["id", "id"], rows: [[1, 2]], rowCount: 1 });
  assert.deepEqual(manager.query("SELECT 1 AS id, 'a' AS name WHERE 0"), { columns: ["id", "name"], rows: [], rowCount: 0 });
  manager.close();
});

test("describeTable marks every composite primary key column", () => {
  const manager = new SqliteManager();
  manager.open(":memory:");
  manager.execute("CREATE TABLE composite (a INTEGER, b INTEGER, c INTEGER, PRIMARY KEY (a, b))");
  assert.deepEqual(manager.describeTable("composite").columns.map((column) => column.pk), [true, true, false]);
  manager.close();
});

test("rejects a first row larger than the byte budget instead of retaining it", () => {
  const manager = new SqliteManager();
  manager.open(":memory:");
  assert.throws(() => manager.query("SELECT ? AS payload", ["x".repeat(MAX_QUERY_BYTES * 2)]), /larger than/);
  assert.equal(manager.query("SELECT substr(?, 1, 10) AS payload", ["x".repeat(MAX_QUERY_BYTES * 2)]).rowCount, 1);
  manager.close();
});

test("sqlite_execute rejects transaction-control statements in any case, spacing or comment form", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-sqlite-tools-"));
  const path = join(directory, "tx.db");
  const manager = new SqliteManager();
  manager.open(path);
  manager.execute("CREATE TABLE t (x)");
  for (const sql of ["BEGIN", "begin immediate", "  \n\tBeGiN TRANSACTION", "/* c */ BEGIN", "-- c\nBEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT a", "RELEASE a"]) {
    assert.throws(() => manager.execute(sql), /transaction/i, sql);
  }
  // The connection must not be left holding a write lock.
  manager.execute("INSERT INTO t VALUES (1)");
  const other = new DatabaseSync(path, { timeout: 0 });
  other.exec("INSERT INTO t VALUES (2)");
  other.close();
  manager.close();
});

test("rolls back and reports a transaction left open by a statement", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-sqlite-tools-"));
  const path = join(directory, "tx2.db");
  const manager = new SqliteManager();
  manager.open(path);
  manager.execute("CREATE TABLE t (x)");
  // Simulate any path that leaves a transaction open behind the statement filter.
  (manager as unknown as { database: DatabaseSync }).database.exec("BEGIN");
  assert.throws(() => manager.execute("INSERT INTO t VALUES (1)"), /rolled back/i);
  assert.deepEqual(manager.query("SELECT count(*) AS c FROM t").rows, [[0]]);
  (manager as unknown as { database: DatabaseSync }).database.exec("BEGIN");
  assert.throws(() => manager.query("SELECT 1"), /rolled back/i);
  manager.close();
});

test("a locked database fails only after the bounded busy timeout, not immediately", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-sqlite-tools-"));
  const path = join(directory, "busy.db");
  const holder = new DatabaseSync(path);
  holder.exec("CREATE TABLE t (x)");
  holder.exec("BEGIN IMMEDIATE");
  const manager = new SqliteManager();
  manager.open(path);
  const started = performance.now();
  assert.throws(() => manager.execute("INSERT INTO t VALUES (1)"), /locked/i);
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= BUSY_TIMEOUT_MS * 0.8, `waited only ${elapsed}ms`);
  assert.ok(elapsed < BUSY_TIMEOUT_MS * 5, `waited ${elapsed}ms`);
  holder.exec("ROLLBACK");
  holder.close();
  manager.close();
});
