import { describe, expect, it } from "vitest";
import { buildSqlConnectorPrompt } from "../src/prompt.js";
import { assertReadOnlySql, assertUpdateSql } from "../src/security/sql-policy.js";

describe("SQL policy", () => {
  it("allows one parameterized read statement", () => {
    expect(() => assertReadOnlySql("mysql", "SELECT * FROM users WHERE id = ? LIMIT 10")).not.toThrow();
    expect(() => assertReadOnlySql("mssql", "SELECT TOP 10 * FROM users WHERE id = @id")).not.toThrow();
  });

  it("rejects multiple statements and mutating reads", () => {
    expect(() => assertReadOnlySql("mysql", "SELECT * FROM users")).toThrow(/LIMIT/i);
    expect(() => assertReadOnlySql("mysql", "SELECT 1; DELETE FROM users")).toThrow(/one SQL statement/i);
    expect(() => assertReadOnlySql("pgsql", "WITH changed AS (DELETE FROM users RETURNING id) SELECT * FROM changed LIMIT 1")).toThrow(/read-only/i);
  });

  it("requires WHERE for UPDATE and DELETE", () => {
    expect(() => assertUpdateSql("mysql", "UPDATE users SET enabled = 0")).toThrow(/WHERE/i);
    expect(() => assertUpdateSql("pgsql", "DELETE FROM users WHERE id = $1")).not.toThrow();
    expect(() => assertUpdateSql("pgsql", "UPDATE users SET enabled = (SELECT false WHERE true)")).toThrow(/top-level WHERE/i);
    expect(() => assertReadOnlySql("mysql", "SELECT * FROM users /*! FOR UPDATE */ LIMIT 1")).toThrow(/comments/i);
  });
});

describe("SQL Connector system prompt", () => {
  it("lists only loaded engines with their parameter syntax and no secrets", () => {
    const prompt = buildSqlConnectorPrompt({
      mysql: { host: "hidden", port: 3306, username: "hidden-user", password: "super-secret", database: "app", ssl: false, windowsAuth: false, trustServerCertificate: false },
      pgsql: { host: "hidden", port: 5432, username: "hidden-user", password: "another-secret", database: "analytics", ssl: false, windowsAuth: false, trustServerCertificate: false },
    });

    expect(prompt).toContain("mysql_query");
    expect(prompt).toContain("`?`");
    expect(prompt).toContain("LIMIT` from 1 to 200");
    expect(prompt).toContain("pgsql_query");
    expect(prompt).toContain("`$1`");
    expect(prompt).not.toContain("mssql_query");
    expect(prompt).not.toContain("super-secret");
    expect(prompt).not.toContain("hidden-user");
    expect(prompt).not.toContain("hidden");
  });
});
