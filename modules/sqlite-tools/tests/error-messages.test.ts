import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_QUERY_ROWS, SqliteManager } from "../src/sqlite-manager.js";

function open(): SqliteManager {
  const manager = new SqliteManager();
  manager.open(join(mkdtempSync(join(tmpdir(), "pi-sqlite-errors-")), "e.db"));
  manager.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)");
  return manager;
}

test("syntax errors are wrapped with operation, sqlite code, sql excerpt and a hint", () => {
  const manager = open();
  assert.throws(() => manager.query("SELCT 1"), (error: Error) => {
    assert.match(error.message, /sqlite_query failed/);
    assert.match(error.message, /syntax error/);
    assert.match(error.message, /SQLite code 1/);
    assert.match(error.message, /SELCT 1/);
    assert.match(error.message, /sqlite_list_tables|sqlite_describe_table/);
    return true;
  });
});

test("unknown table points to the discovery tools", () => {
  assert.throws(() => open().query("SELECT * FROM nope"), /no such table: nope[\s\S]*sqlite_list_tables/);
});

test("constraint failures say the statement was not applied", () => {
  const manager = open();
  manager.execute("INSERT INTO t (name) VALUES ('a')");
  assert.throws(() => manager.execute("INSERT INTO t (name) VALUES ('a')"), (error: Error) => {
    assert.match(error.message, /sqlite_execute failed/);
    assert.match(error.message, /UNIQUE constraint failed/);
    assert.match(error.message, /not applied/i);
    return true;
  });
});

test("binding mismatches explain the binding rules", () => {
  const manager = open();
  assert.throws(() => manager.query("SELECT :a AS v", { b: 1 }), /Unknown named parameter 'b'[\s\S]*bindings must match/i);
  assert.throws(() => manager.query("SELECT ? AS v", [[1]]), /Unknown named parameter '0'[\s\S]*bindings must match/i);
});

test("long SQL is cut in the excerpt", () => {
  const sql = `SELECT ${"x".repeat(1000)} FROM`;
  assert.throws(() => open().query(sql), (error: Error) => error.message.length < 900);
});

test("guard errors raised by the manager itself are not double wrapped", () => {
  const manager = open();
  assert.throws(() => manager.query("CREATE TABLE z (a)"), (error: Error) => {
    assert.match(error.message, /^sqlite_query accepts only statements that return rows\./);
    return true;
  });
  assert.throws(() => manager.execute("SELECT 1"), /including .*RETURNING/);
});

test("truncation carries a hint on how to narrow the query", () => {
  const manager = open();
  manager.execute(`INSERT INTO t (name) WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${MAX_QUERY_ROWS + 5}) SELECT 'n' || x FROM c`);
  const result = manager.query("SELECT id FROM t ORDER BY id");
  assert.equal(result.truncated, true);
  assert.match(result.hint ?? "", /LIMIT/);
  assert.match(result.hint ?? "", /OFFSET/);
  assert.match(result.hint ?? "", /WHERE/);
});

test("describing a missing table says how to find valid names", () => {
  assert.throws(() => open().describeTable("nope"), /sqlite_list_tables[\s\S]*case-sensitive/i);
});

test("manager error messages name tools and arguments only, never settings files or variables", () => {
  const leak = /SQLITE_PATH|sqlite\.json|\.pi[\/]agent|databasePath|\bconfig(?:uration)? file\b/i;
  const manager = new SqliteManager();
  assert.throws(() => manager.query("SELECT 1"), (error: Error) => {
    assert.match(error.message, /sqlite_open/);
    assert.doesNotMatch(error.message, leak);
    return true;
  });
  const opened = open();
  for (const run of [
    () => opened.query("SELCT 1"),
    () => opened.query("SELECT * FROM nope"),
    () => opened.execute("SELECT 1"),
    () => opened.describeTable("nope"),
    () => opened.query("SELECT :a AS v", { b: 1 }),
  ]) {
    assert.throws(run, (error: Error) => {
      assert.doesNotMatch(error.message, leak);
      return true;
    });
  }
});
