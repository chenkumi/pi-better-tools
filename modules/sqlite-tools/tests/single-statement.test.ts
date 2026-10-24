import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteManager } from "../src/sqlite-manager.js";

// node:sqlite compiles only the first statement and drops the rest, so a trailing statement used to be ignored without
// any signal. The tools run one statement per call; a second one must be refused, not silently skipped.
function open() {
  const manager = new SqliteManager();
  manager.open(join(mkdtempSync(join(tmpdir(), "pi-sqlite-single-")), "app.db"));
  manager.execute("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
  return manager;
}
const count = (manager: SqliteManager) => (manager.query("SELECT COUNT(*) AS c FROM users").rows[0] as number[])[0];

test("sqlite_execute refuses a trailing second statement and runs neither", () => {
  const manager = open();
  assert.throws(() => manager.execute("INSERT INTO users (name) VALUES ('a'); INSERT INTO users (name) VALUES ('b')"), /one SQL statement/i);
  assert.equal(count(manager), 0);
  manager.close();
});

test("sqlite_query refuses a trailing second statement", () => {
  const manager = open();
  assert.throws(() => manager.query("SELECT 1 AS a; SELECT 2 AS b"), /one SQL statement/i);
  assert.throws(() => manager.query("SELECT 1 AS a; DELETE FROM users"), /one SQL statement/i);
  manager.close();
});

test("a single statement with a trailing semicolon, whitespace or comments is still one statement", () => {
  const manager = open();
  assert.equal(manager.execute("INSERT INTO users (name) VALUES ('a');").changes, 1);
  assert.equal(manager.execute("INSERT INTO users (name) VALUES ('b');  \n -- done\n /* end */").changes, 1);
  assert.deepEqual(manager.query("SELECT 1 AS a; -- nothing follows").rows, [[1]]);
  assert.equal(count(manager), 2);
  manager.close();
});

test("semicolons inside strings, identifiers and comments do not split a statement", () => {
  const manager = open();
  assert.equal(manager.execute("INSERT INTO users (name) VALUES ('x; DROP TABLE users; --')").changes, 1);
  assert.deepEqual(manager.query("SELECT name AS \"a;b\" FROM users WHERE name = 'x; DROP TABLE users; --' /* ; */").rows, [["x; DROP TABLE users; --"]]);
  assert.deepEqual(manager.query("SELECT 1 AS [a;b], 2 AS `c;d`").rows, [[1, 2]]);
  manager.close();
});

test("a CREATE TRIGGER body is one statement even though it contains semicolons", () => {
  const manager = open();
  manager.execute("CREATE TABLE log (msg TEXT)");
  assert.doesNotThrow(() => manager.execute("CREATE TRIGGER t AFTER INSERT ON users BEGIN INSERT INTO log VALUES ('one'); INSERT INTO log VALUES ('two'); END"));
  manager.execute("INSERT INTO users (name) VALUES ('a')");
  assert.deepEqual(manager.query("SELECT msg FROM log ORDER BY rowid").rows, [["one"], ["two"]]);
  manager.close();
});
