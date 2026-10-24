import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSqlConnectorConfig } from "../src/config.js";

/** Agent-facing text must not name settings fields, files or namespaces (see error-messages.test.ts). */
const LEAK = /\.json\b|\.pi[\\/]agent|\$\{|\b[A-Z][A-Z0-9_]*PASSWORD[A-Z0-9_]*\b|\b(?:host|port|username|password|database|databasePath|trustServerCertificate|windowsAuth|instanceName|odbcDriver|ssl)\b(?=["'`.]|\sfield)|\b(?:mysql|mssql|pgsql)\.[a-zA-Z]+\b|"(?:mysql|mssql|pgsql)"/;

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function load(content: unknown) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sql-connector-keys-"));
  directories.push(cwd);
  await mkdir(join(cwd, ".pi", "agent"), { recursive: true });
  await writeFile(join(cwd, ".pi", "agent", "sql-connector.json"), JSON.stringify(content));
  return loadSqlConnectorConfig(cwd, {});
}

// A misspelled `ssl` (or `trustServerCertificate`) used to be ignored, silently falling back to a plaintext or
// differently-trusted connection. Every engine key must be a documented one.
describe("engine settings reject unknown keys", () => {
  const base = { host: "h", username: "u", password: "s3cret-value", database: "d" };

  it("a misspelled ssl is refused for every engine; only the human detail names the key, never a value", async () => {
    for (const engine of ["mysql", "mssql", "pgsql"] as const) {
      const error = await load({ [engine]: { ...base, sll: true } }).catch((e) => e);
      expect(error).toMatchObject({ code: "CONFIG_INVALID" });
      expect(error.message).not.toContain("sll");
      expect(error.message).not.toMatch(LEAK);
      expect(error.message).toContain("/sql-connector-reload");
      expect(error.humanMessage).toContain(`${engine}.sll`);
      expect(`${error.message} ${error.humanMessage}`).not.toContain("s3cret-value");
    }
  });

  it("every other invalid setting is refused with neutral agent-facing wording", async () => {
    const invalid: unknown[] = [
      { mysql: { ...base, port: 0 } },
      { pgsql: { ...base, ssl: "yes" } },
      { pgsql: { ...base, host: "" } },
      { pgsql: { ...base, username: undefined } },
      { pgsql: { ...base, password: undefined } },
      { pgsql: { ...base, database: "" } },
      { mssql: { ...base, windowsAuth: "true" } },
      { mssql: { ...base, trustServerCertificate: "no" } },
      { mssql: { ...base, instanceName: 5 } },
      { mysql: { ...base, odbcDriver: "x" } },
      { mysql: "not an object" },
      { oracle: base },
      [],
    ];
    for (const content of invalid) {
      const error = await load(content).catch((e) => e);
      expect(error, JSON.stringify(content)).toMatchObject({ code: "CONFIG_INVALID" });
      expect(error.message, JSON.stringify(content)).not.toMatch(LEAK);
      expect(error.message).not.toContain("s3cret-value");
      expect(error.message).toContain("/sql-connector-reload");
    }
  });

  it("a misspelled trustServerCertificate is refused", async () => {
    await expect(load({ mssql: { ...base, trustServerCertficate: true } })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("every documented key still loads", async () => {
    await expect(load({ mssql: { ...base, port: 1433, ssl: true, windowsAuth: false, instanceName: "SQLEXPRESS", odbcDriver: "ODBC Driver 18 for SQL Server", trustServerCertificate: true } })).resolves.toBeDefined();
    await expect(load({ pgsql: { ...base, port: 5432, ssl: true } })).resolves.toBeDefined();
  });
});
