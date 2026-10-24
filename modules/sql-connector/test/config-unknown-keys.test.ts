import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSqlConnectorConfig } from "../src/config.js";

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

  it("a misspelled ssl is refused for every engine, naming the key but never a value", async () => {
    for (const engine of ["mysql", "mssql", "pgsql"] as const) {
      const error = await load({ [engine]: { ...base, sll: true } }).catch((e) => e);
      expect(error).toMatchObject({ code: "CONFIG_INVALID" });
      expect(error.message).toContain(`${engine}.sll`);
      expect(error.message).not.toContain("s3cret-value");
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
