import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

const driver = vi.hoisted(() => ({ mysqlError: undefined as unknown, mssqlRequests: 0 }));

vi.mock("mysql2/promise", () => {
  const createPool = () => ({
    getConnection: async () => ({
      query: async () => [[], []],
      execute: async () => { throw driver.mysqlError; },
      release: () => undefined,
      destroy: () => undefined,
    }),
    end: async () => undefined,
  });
  return { default: { createPool }, createPool };
});

vi.mock("mssql", () => {
  class ConnectionPool {
    connected = true;
    on() { return this; }
    request() {
      driver.mssqlRequests++;
      return { input: () => undefined, query: async () => ({ recordset: [], rowsAffected: [0] }), cancel: () => undefined };
    }
    async close() {}
  }
  return { default: { ConnectionPool }, ConnectionPool };
});

const { classifyDriverError, describeUnexpectedError, redactDriverText } = await import("../src/driver-errors.js");
const { SqlConnectorRuntime } = await import("../src/runtime.js");
const { registerEngineTools } = await import("../src/tools.js");
const { assertReadOnlySql, assertUpdateSql } = await import("../src/security/sql-policy.js");
const { loadSqlConnectorConfig } = await import("../src/config.js");
const { default: sqlConnectorExtension } = await import("../src/index.js");
const { SqlConnectorError } = await import("../src/types.js");

const SECRET = "Sup3r-S3cret-pw";
const config = { host: "db.internal.example", username: "svc_reader", password: SECRET, database: "app", ssl: false, windowsAuth: false, trustServerCertificate: false };

function expectNoSecrets(text: string) {
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain("svc_reader");
  expect(text).not.toContain("db.internal.example");
}

/**
 * Agent-facing text may name tool arguments, tool names, error codes and slash commands, but never settings fields,
 * settings/config files or paths, environment variable names or settings namespaces.
 */
const CONFIG_LEAK = /\.json\b|\.pi[\\/]agent|\$\{|\b[A-Z][A-Z0-9_]*PASSWORD[A-Z0-9_]*\b|password[A-Za-z]*Env|\b(?:username|databasePath|trustServerCertificate|windowsAuth|instanceName|odbcDriver)\b|\b(?:mysql|mssql|pgsql)\.[a-z]+\b|\bssl\b|host\/port/;

function expectNoConfigLeak(text: string) {
  expect(text).not.toMatch(CONFIG_LEAK);
}

beforeEach(() => { driver.mysqlError = undefined; driver.mssqlRequests = 0; });

describe("driver error classification", () => {
  it("surfaces PostgreSQL syntax errors with SQLSTATE, position and a hint", () => {
    const error = classifyDriverError("pgsql", Object.assign(new Error('syntax error at or near "FORM"'), { code: "42601", position: "10" }));
    expect(error.code).toBe("SQL_SYNTAX");
    expect(error.message).toContain("SQLSTATE 42601");
    expect(error.message).toContain("position 10");
    expect(error.message).toContain('syntax error at or near "FORM"');
    expect(error.message).toMatch(/information_schema/);
  });

  it("classifies unknown objects, constraints and permission errors per engine", () => {
    const mysqlTable = classifyDriverError("mysql", Object.assign(new Error("x"), { code: "ER_NO_SUCH_TABLE", errno: 1146, sqlState: "42S02", sqlMessage: "Table 'app.nope' doesn't exist" }));
    expect(mysqlTable.code).toBe("SQL_SYNTAX");
    expect(mysqlTable.message).toContain("ER_NO_SUCH_TABLE");
    expect(mysqlTable.message).toContain("Table 'app.nope' doesn't exist");
    const dup = classifyDriverError("mysql", Object.assign(new Error("x"), { code: "ER_DUP_ENTRY", errno: 1062, sqlState: "23000", sqlMessage: "Duplicate entry '1' for key 'PRIMARY'" }), { write: true });
    expect(dup.code).toBe("SQL_CONSTRAINT");
    expect(dup.message).toContain("not applied");
    const mssqlDup = classifyDriverError("mssql", Object.assign(new Error("Violation of PRIMARY KEY constraint"), { code: "EREQUEST", number: 2627, lineNumber: 1 }), { write: true });
    expect(mssqlDup.code).toBe("SQL_CONSTRAINT");
    expect(mssqlDup.message).toContain("error 2627");
    expect(mssqlDup.message).toContain("line 1");
    const pgDup = classifyDriverError("pgsql", Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }));
    expect(pgDup.code).toBe("SQL_CONSTRAINT");
    const denied = classifyDriverError("mysql", Object.assign(new Error("x"), { code: "ER_TABLEACCESS_DENIED_ERROR", errno: 1142, sqlMessage: "SELECT command denied" }));
    expect(denied.message).toMatch(/permission denied/);
    expect(denied.message).toMatch(/do not retry/i);
    expect(denied.code).not.toBe("AUTH_OR_TLS");
    expect(classifyDriverError("mssql", Object.assign(new Error("Invalid object name 'x'."), { code: "EREQUEST", number: 208 })).code).toBe("SQL_SYNTAX");
  });

  it("states that a timed-out write may or may not have been applied, and a read may be retried", () => {
    const timeout = Object.assign(new Error("Query inactivity timeout"), { code: "PROTOCOL_SEQUENCE_TIMEOUT" });
    const write = classifyDriverError("mysql", timeout, { write: true });
    expect(write.code).toBe("TIMEOUT");
    expect(write.message).toMatch(/may or may not have been applied/);
    expect(write.message).toMatch(/verify with a SELECT/);
    expect(write.message).toContain("30000 ms");
    const read = classifyDriverError("mysql", timeout);
    expect(read.message).not.toMatch(/may or may not/);
    expect(read.message).toMatch(/narrow/i);
  });

  it("gives connection failures a cause category and neutral guidance, without host, port, driver text or settings names", () => {
    const refused = classifyDriverError("pgsql", Object.assign(new Error("connect ECONNREFUSED 10.1.2.3:5432"), { code: "ECONNREFUSED" }), { config });
    expect(refused.code).toBe("CONNECTIVITY");
    expect(refused.message).toContain("ECONNREFUSED");
    expect(refused.message).toMatch(/database host and port/);
    expect(refused.message).not.toContain("10.1.2.3");
    expectNoConfigLeak(refused.message);
    const auth = classifyDriverError("mysql", Object.assign(new Error(`Access denied for user 'svc_reader'@'h' (using password: YES)`), { code: "ER_ACCESS_DENIED_ERROR", errno: 1045 }), { config });
    expect(auth.code).toBe("AUTH_OR_TLS");
    expectNoSecrets(auth.message);
    expectNoConfigLeak(auth.message);
    expect(auth.message).toMatch(/user account[\s\S]*user password[\s\S]*TLS/);
    expect(auth.message).toMatch(/ask the user/i);
  });

  it("redacts credentials, connection strings and identities from surfaced driver text and caps its length", () => {
    const leaky = new Error(`syntax error in Server=db.internal.example;User Id=svc_reader;Password=${SECRET}; also postgres://svc_reader:${SECRET}@db.internal.example/app and ${SECRET}${"x".repeat(1000)}`);
    const error = classifyDriverError("mssql", Object.assign(leaky, { code: "EREQUEST", number: 102 }), { config });
    expectNoSecrets(error.message);
    expect(error.message.length).toBeLessThan(900);
    expect(redactDriverText("pwd=abc; token: xyz")).not.toMatch(/abc|xyz/);
  });

  it("describes non-database failures such as a missing optional driver module", () => {
    const error = describeUnexpectedError(Object.assign(new Error("Cannot find module 'mssql/msnodesqlv8'"), { code: "MODULE_NOT_FOUND" }));
    expect(error.message).toContain("MODULE_NOT_FOUND");
    expect(error.message).toContain("msnodesqlv8");
    expect(error.message).not.toBe("SQL connector request failed.");
  });
});

describe("tool-level messages", () => {
  function tools(engine: "mysql" | "mssql" | "pgsql", runtimeOverride?: object) {
    const registered = new Map<string, ToolDefinition>();
    const runtime = runtimeOverride ?? new SqlConnectorRuntime({ [engine]: config });
    registerEngineTools({ registerTool: (tool: ToolDefinition) => registered.set(tool.name, tool) } as unknown as ExtensionAPI, runtime as never, engine);
    const call = (action: string, params: Record<string, unknown>, hasUI = true) =>
      registered.get(`${engine}_${action}`)!.execute("t", params, undefined, undefined, { hasUI, ui: { confirm: async () => true } } as unknown as ExtensionToolContext);
    return { call, registered };
  }

  it("passes a classified driver error from a failing read to the agent", async () => {
    driver.mysqlError = Object.assign(new Error("x"), { code: "ER_BAD_FIELD_ERROR", errno: 1054, sqlState: "42S22", sqlMessage: "Unknown column 'nme' in 'field list'" });
    const t = tools("mysql");
    await expect(t.call("query", { sql: "SELECT nme FROM users LIMIT 1" })).rejects.toThrow(/Unknown column 'nme'.*ER_BAD_FIELD_ERROR|ER_BAD_FIELD_ERROR.*Unknown column 'nme'/);
  });

  it("marks a failed write as not applied for a constraint error", async () => {
    driver.mysqlError = Object.assign(new Error("x"), { code: "ER_DUP_ENTRY", errno: 1062, sqlMessage: "Duplicate entry" });
    const t = tools("mysql");
    await expect(t.call("update", { sql: "INSERT INTO t (a) VALUES (1)", reason: "r" })).rejects.toThrow(/not applied/);
  });

  it("no longer reports unexpected errors as the generic request failure", async () => {
    const t = tools("pgsql", { query: async () => { throw Object.assign(new Error("boom"), { name: "TypeError" }); } });
    await expect(t.call("query", { sql: "SELECT 1 LIMIT 1" })).rejects.toThrow(/internal error: TypeError: boom/);
  });

  it("tells the agent a non-interactive session cannot run updates and not to retry", async () => {
    const t = tools("mysql", {});
    const failure = t.call("update", { sql: "DELETE FROM t WHERE id = 1", reason: "r" }, false);
    await expect(failure).rejects.toThrow(/interactive confirmation/);
    await expect(failure).rejects.toThrow(/do not retry/i);
    await expect(failure).rejects.toThrow(/ask the user/i);
  });

  it("names the bad MSSQL parameter key and says to omit the @", async () => {
    const t = tools("mssql");
    const failure = t.call("query", { sql: "SELECT TOP 1 * FROM t WHERE id = @id", params: { "@id": 1 } });
    await expect(failure).rejects.toThrow(/"@id"/);
    await expect(failure).rejects.toThrow(/omit the (leading )?'?@/i);
    const array = t.call("query", { sql: "SELECT TOP 1 * FROM t WHERE id = @id", params: [1] });
    await expect(array).rejects.toThrow(/\{"id": 1\}/);
  });

  it("explains an unconfigured engine", async () => {
    const t = tools("mysql", new SqlConnectorRuntime({}));
    const failure = await t.call("state", {}).catch((e: Error) => e) as Error;
    expect(failure.message).toMatch(/no database connection configured[\s\S]*Ask the user[\s\S]*\/sql-connector-reload/);
    expectNoConfigLeak(failure.message);
  });

  it("keeps parameter guidance on the argument names only", async () => {
    const t = tools("mysql");
    const failure = await t.call("query", { sql: "SELECT 1 LIMIT 1", params: { id: 1 } }).catch((e: Error) => e) as Error;
    expect(failure.message).toMatch(/params must be a JSON array/);
    expectNoConfigLeak(failure.message);
  });
});

describe("SQL policy messages", () => {
  const message = (run: () => void): string => {
    try { run(); } catch (error) { return (error as Error).message; }
    throw new Error("expected a policy error");
  };

  it("lists allowed read kinds, the received statement kind and the update tool", () => {
    const text = message(() => assertReadOnlySql("mysql", "INSERT INTO t VALUES (1)"));
    expect(text).toMatch(/SELECT, WITH, SHOW, DESCRIBE, EXPLAIN/);
    expect(text).toContain("INSERT");
    expect(text).toContain("mysql_update");
  });

  it("names the forbidden construct and how to quote a colliding column in every engine", () => {
    const mysql = message(() => assertReadOnlySql("mysql", "SELECT update FROM t LIMIT 1"));
    expect(mysql).toMatch(/"update"/i);
    expect(mysql).toContain("`");
    const pg = message(() => assertReadOnlySql("pgsql", "SELECT call FROM t LIMIT 1"));
    expect(pg).toMatch(/"call"/i);
    expect(pg).toContain('double quotes');
    const mssql = message(() => assertReadOnlySql("mssql", "SELECT TOP 1 print FROM t"));
    expect(mssql).toMatch(/"print"/i);
    expect(mssql).toContain("[name]");
    expect(message(() => assertReadOnlySql("mysql", "SELECT * FROM t LIMIT 1 FOR UPDATE"))).toMatch(/FOR UPDATE/i);
    expect(message(() => assertReadOnlySql("pgsql", "SELECT * INTO x FROM t LIMIT 1"))).toMatch(/SELECT \.\.\. INTO/);
    // The policy itself is unchanged: quoted identifiers still pass.
    expect(() => assertReadOnlySql("mysql", "SELECT `update` FROM t LIMIT 1")).not.toThrow();
  });

  it("gives positions and fixes for lexical and statement-count errors", () => {
    expect(message(() => assertReadOnlySql("mysql", "SELECT 'abc FROM t LIMIT 1"))).toMatch(/position 8|line 1, column 8/);
    expect(message(() => assertReadOnlySql("mysql", "SELECT 1 LIMIT 1; SELECT 2 LIMIT 1"))).toMatch(/one SQL statement[\s\S]*first ';'/);
  });

  it("echoes the received limit", () => {
    expect(message(() => assertReadOnlySql("mysql", "SELECT 1 LIMIT 500"))).toContain("500");
    expect(message(() => assertReadOnlySql("mssql", "SELECT TOP 900 1"))).toContain("900");
  });

  it("explains update rejections with the received keyword", () => {
    const text = message(() => assertUpdateSql("pgsql", "DROP TABLE t"));
    expect(text).toContain("DROP");
    expect(text).toMatch(/CREATE\/ALTER\/DROP\/TRUNCATE/);
    expect(text).toContain("pgsql_query");
    const mssql = message(() => assertUpdateSql("mssql", "DELETE FROM t WHERE id = 1 WAITFOR DELAY '00:00:01'"));
    expect(mssql).toMatch(/one INSERT/);
    expect(mssql).toMatch(/waitfor/i);
  });
});

describe("configuration messages", () => {
  async function cwdWith(contents: string): Promise<string> {
    const cwd = await mkdtemp(join(tmpdir(), "pi-sql-config-msg-"));
    await mkdir(join(cwd, ".pi", "agent"), { recursive: true });
    await writeFile(join(cwd, ".pi", "agent", "sql-connector.json"), contents);
    return cwd;
  }

  it("never names the password variable to the agent, only to the human, and says what to ask the user", async () => {
    const cwd = await cwdWith(JSON.stringify({ pgsql: { host: "h", username: "u", password: "${MY_PG_PASSWORD}", database: "d" } }));
    try {
      const error = await loadSqlConnectorConfig(cwd, {}).catch((e) => e) as InstanceType<typeof SqlConnectorError>;
      expect(error.code).toBe("SECRET_MISSING");
      expect(error.message).toMatch(/user password[\s\S]*not set in the environment[\s\S]*Ask the user[\s\S]*\/sql-connector-reload/);
      expect(error.message).not.toContain("MY_PG_PASSWORD");
      expectNoConfigLeak(error.message);
      expect(error.humanMessage).toContain("MY_PG_PASSWORD");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("tells the agent about an invalid configuration through the system prompt without registering any tool", async () => {
    const cwd = await cwdWith(JSON.stringify({ pgsql: { host: "h", username: "u", password: SECRET, database: "d", sll: true } }));
    try {
      const handlers = new Map<string, (event: any, ctx: any) => any>();
      const registered: string[] = [];
      const pi = { on: (name: string, handler: (event: any, ctx: any) => any) => handlers.set(name, handler), registerTool: (tool: { name: string }) => registered.push(tool.name), registerCommand: () => undefined } as any;
      sqlConnectorExtension(pi);
      const notices: string[] = [];
      const ctx = { cwd, hasUI: true, isProjectTrusted: () => true, ui: { setStatus: () => undefined, notify: (message: string) => notices.push(message) } };
      await handlers.get("session_start")!({}, ctx);
      expect(registered).toEqual([]);
      const sections: Record<string, string> = {};
      const result = handlers.get("before_agent_start")!({ systemPrompt: "Base", systemPromptOptions: { sections } }, ctx);
      expect(result).toBeUndefined();
      const notice = Object.values(sections).join("\n");
      expect(notice).toContain("CONFIG_INVALID");
      expect(notice).not.toContain("sll");
      expectNoConfigLeak(notice);
      expect(notice).toMatch(/mysql_\*/);
      expect(notice).toMatch(/ask the user/i);
      expect(notice).toMatch(/sql-connector-reload/);
      expect(notice).not.toContain(SECRET);
      const legacy = handlers.get("before_agent_start")!({ systemPrompt: "Base", systemPromptOptions: {} }, ctx);
      expect(legacy.systemPrompt).toContain("Base");
      expect(legacy.systemPrompt).toContain("CONFIG_INVALID");
      expectNoConfigLeak(legacy.systemPrompt);
      // The human-only UI notice keeps the detailed field and file names.
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("pgsql.sll");
      expect(notices[0]).not.toContain(SECRET);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("reports the JSON error position without echoing file content", async () => {
    const cwd = await cwdWith(`{"pgsql": {"password": "${SECRET}", oops}}`);
    try {
      const error = await loadSqlConnectorConfig(cwd, {}).catch((e: Error) => e);
      expect((error as Error).message).toMatch(/not valid JSON/);
      expect((error as Error).message).toMatch(/position \d+/);
      expect((error as Error).message).not.toContain(SECRET);
      expectNoConfigLeak((error as Error).message);
      expect((error as Error).message).toMatch(/\/sql-connector-reload/);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("names only the errno, not the settings file, when the file cannot be read", async () => {
    const cwd = await cwdWith("{}");
    await rm(join(cwd, ".pi", "agent", "sql-connector.json"));
    await mkdir(join(cwd, ".pi", "agent", "sql-connector.json"));
    try {
      const error = await loadSqlConnectorConfig(cwd, {}).catch((e) => e) as Error;
      expect(error.message).toContain("EISDIR");
      expectNoConfigLeak(error.message);
      expect((error as InstanceType<typeof SqlConnectorError>).humanMessage).toContain("sql-connector.json");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});
