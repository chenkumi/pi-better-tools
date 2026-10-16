import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredEngines, loadSqlConnectorConfig } from "../src/config.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function writeConfig(content: unknown): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sql-connector-"));
  directories.push(cwd);
  await mkdir(join(cwd, ".pi", "agent"), { recursive: true });
  await writeFile(join(cwd, ".pi", "agent", "sql-connector.json"), JSON.stringify(content));
  return cwd;
}

describe("loadSqlConnectorConfig", () => {
  it("loads only configured engines and fills default ports", async () => {
    const cwd = await writeConfig({
      mysql: { host: "localhost", username: "root", password: "${MYSQL_PASSWORD}", database: "app" },
      pgsql: { host: "localhost", username: "reader", password: "plain-password", database: "analytics", ssl: true },
    });

    const config = await loadSqlConnectorConfig(cwd, { MYSQL_PASSWORD: "resolved-secret" });

    expect(config?.mysql).toMatchObject({ port: 3306, password: "resolved-secret", ssl: false });
    expect(config?.pgsql).toMatchObject({ port: 5432, password: "plain-password", ssl: true });
    expect(configuredEngines(config!)).toEqual(["mysql", "pgsql"]);
  });

  it("allows an empty MySQL username, password, and database to use driver defaults", async () => {
    const cwd = await writeConfig({
      mysql: { host: "localhost", username: "", password: "", database: "" },
    });

    await expect(loadSqlConnectorConfig(cwd, {})).resolves.toMatchObject({
      mysql: { host: "localhost", port: 3306, username: undefined, password: undefined, database: undefined },
    });
  });

  it("supports MSSQL Windows Authentication and a named instance without port 1433", async () => {
    const cwd = await writeConfig({
      mssql: {
        host: "localhost",
        instanceName: "SQLEXPRESS01",
        database: "master",
        windowsAuth: true,
        trustServerCertificate: true,
      },
    });

    await expect(loadSqlConnectorConfig(cwd, {})).resolves.toMatchObject({
      mssql: {
        host: "localhost",
        port: undefined,
        database: "master",
        windowsAuth: true,
        instanceName: "SQLEXPRESS01",
        odbcDriver: "ODBC Driver 18 for SQL Server",
        trustServerCertificate: true,
      },
    });
  });

  it("does not expose the environment variable name for a missing password", async () => {
    const cwd = await writeConfig({
      mysql: { host: "localhost", username: "root", password: "${DO_NOT_LEAK}", database: "app" },
    });

    await expect(loadSqlConnectorConfig(cwd, {})).rejects.toMatchObject({
      code: "SECRET_MISSING",
      message: "A database password environment variable is not set.",
    });
  });

  it("returns undefined when configuration is absent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-sql-connector-"));
    directories.push(cwd);
    await expect(loadSqlConnectorConfig(cwd, {})).resolves.toBeUndefined();
  });
});
