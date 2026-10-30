import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyPatches, readRaw, removeFile, writeJsonAtomic } from "../../pi-runtime/src/settings-panel/index.js";
import { loadSqlConnectorConfig } from "../src/config.js";
import { sqlConnectorSettings } from "../src/settings.js";

function withFile<T>(fn: (file: string, cwd: string) => Promise<T> | T) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-sql-settings-"));
  const file = join(cwd, ".pi", "agent", "sql-connector.json");
  return Promise.resolve(fn(file, cwd)).finally(() => rmSync(cwd, { recursive: true, force: true }));
}
/** What the command does on Save, against a real file. */
function save(file: string, edits: Record<string, string | number | boolean>) {
  const schema = sqlConnectorSettings(file);
  const state = readRaw(file), raw = state.state === "ok" ? state.raw : {};
  const current = schema.parse(raw), values = { ...schema.toValues(current), ...edits };
  const next = applyPatches(raw, schema.toPatch(values, new Set(Object.keys(edits)), current));
  schema.parse(next);
  if (schema.deleteWhenEmpty && !Object.keys(next).length) removeFile(file); else writeJsonAtomic(file, next);
}
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));

describe("/settings:sql-connector schema", () => {
  it("enabling PostgreSQL with an env password writes a block the extension's own loader accepts", () => withFile(async (file, cwd) => {
    save(file, { "pgsql.enabled": true, "pgsql.host": " 127.0.0.1 ", "pgsql.database": "analytics", "pgsql.username": "pi_reader", "pgsql.passSource": "env", "pgsql.passEnv": "PGPASSWORD", "pgsql.ssl": true });
    expect(read(file)).toEqual({ pgsql: { host: "127.0.0.1", database: "analytics", username: "pi_reader", password: "${PGPASSWORD}", ssl: true } });
    const loaded = await loadSqlConnectorConfig(cwd, { PGPASSWORD: "secret" });
    expect(loaded?.pgsql).toMatchObject({ host: "127.0.0.1", port: 5432, password: "secret", ssl: true });
  }));

  it("a typed password is written directly; leaving it empty later keeps the stored one", () => withFile((file) => {
    save(file, { "mysql.enabled": true, "mysql.host": "db", "mysql.passSource": "key", "mysql.password": " pw " });
    expect(read(file).mysql.password).toBe("pw");
    save(file, { "mysql.port": 3307 });
    expect(read(file).mysql).toMatchObject({ host: "db", port: 3307, password: "pw" });
  }));

  it("never loads the stored password into panel values, only its presence", () => withFile((file) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ pgsql: { host: "h", username: "u", password: "TOPSECRET", database: "d" } }));
    const schema = sqlConnectorSettings(file);
    const values = schema.toValues(schema.parse(read(file)));
    expect(JSON.stringify(values)).not.toContain("TOPSECRET");
    expect(values["pgsql.passSet"]).toBe(true);
    expect(values["pgsql.passSource"]).toBe("key");
  }));

  it("refuses missing pieces with readable messages and never echoes values", () => withFile((file) => {
    expect(() => save(file, { "pgsql.enabled": true, "pgsql.host": "h", "pgsql.passSource": "env", "pgsql.passEnv": " " })).toThrow(/Enter the environment variable name/);
    expect(() => save(file, { "pgsql.enabled": true, "pgsql.host": "h", "pgsql.passSource": "key" })).toThrow(/Enter the PostgreSQL password/);
    expect(() => save(file, { "pgsql.enabled": true, "pgsql.host": "", "pgsql.passSource": "env", "pgsql.passEnv": "X", "pgsql.username": "u", "pgsql.database": "d" })).toThrow(/CONFIG_INVALID.*pgsql\.host/);
    expect(existsSync(file)).toBe(false);
  }));

  it("MSSQL Windows authentication drops credentials; named instance drops the port; trust stays explicit", () => withFile((file) => {
    save(file, { "mssql.enabled": true, "mssql.host": "srv", "mssql.database": "d", "mssql.windowsAuth": true, "mssql.instanceName": "SQLEXPRESS", "mssql.username": "ignored", "mssql.port": 1500 });
    expect(read(file).mssql).toEqual({ host: "srv", database: "d", windowsAuth: true, instanceName: "SQLEXPRESS" });
  }));

  it("turning a database off removes only its block, and the file when it was the last one", () => withFile((file) => {
    save(file, { "mysql.enabled": true, "mysql.host": "a", "mysql.passSource": "none" });
    save(file, { "pgsql.enabled": true, "pgsql.host": "b", "pgsql.username": "u", "pgsql.database": "d", "pgsql.passSource": "env", "pgsql.passEnv": "P" });
    save(file, { "mysql.enabled": false });
    expect(Object.keys(read(file))).toEqual(["pgsql"]);
    save(file, { "pgsql.enabled": false });
    expect(existsSync(file)).toBe(false);
  }));

  it("an unchanged database is left byte-for-byte as the user wrote it", () => withFile((file) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ mysql: { host: "keep", ssl: false } }));
    save(file, { "pgsql.enabled": true, "pgsql.host": "b", "pgsql.username": "u", "pgsql.database": "d", "pgsql.passSource": "env", "pgsql.passEnv": "P" });
    expect(read(file).mysql).toEqual({ host: "keep", ssl: false });
  }));
});
