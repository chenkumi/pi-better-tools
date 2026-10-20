import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SqliteManager } from "../src/sqlite-manager.js";

const holderSource = `
import { DatabaseSync } from "node:sqlite";
import { existsSync, writeFileSync } from "node:fs";
const [db, dir] = process.argv.slice(2);
const d = new DatabaseSync(db);
d.exec("BEGIN IMMEDIATE");
writeFileSync(dir + "/locked.flag", "1");
const poll = setInterval(() => {
  if (!existsSync(dir + "/go.flag")) return;
  clearInterval(poll);
  setTimeout(() => { d.exec("COMMIT"); d.close(); }, 200);
}, 5);
`;

test("a write waits for another process's short write lock instead of failing immediately", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-sqlite-busy-"));
  const db = join(dir, "t.db");
  const seed = new DatabaseSync(db);
  seed.exec("CREATE TABLE t (x)");
  seed.close();
  writeFileSync(join(dir, "holder.mjs"), holderSource);
  const holder = spawn(process.execPath, [join(dir, "holder.mjs"), db, dir], { stdio: "inherit" });
  const exited = new Promise<void>((resolve) => holder.on("exit", () => resolve()));
  const deadline = Date.now() + 20_000;
  while (!existsSync(join(dir, "locked.flag"))) {
    assert.ok(Date.now() < deadline, "holder never locked the database");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const manager = new SqliteManager();
  assert.equal(manager.open(db).success, true);
  writeFileSync(join(dir, "go.flag"), "1");
  assert.equal(manager.execute("INSERT INTO t VALUES (1)").changes, 1);
  manager.close();
  await exited;
});
