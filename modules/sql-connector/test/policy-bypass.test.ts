import { describe, expect, it } from "vitest";
import { assertReadOnlySql, assertUpdateSql } from "../src/security/sql-policy.js";
import type { Engine } from "../src/types.js";

const denied = (engine: Engine, sql: string) => expect(() => assertReadOnlySql(engine, sql), `${engine}: ${sql}`).toThrow();
const allowed = (engine: Engine, sql: string) => expect(() => assertReadOnlySql(engine, sql), `${engine}: ${sql}`).not.toThrow();

describe("read-only policy follows each engine's lexical rules", () => {
  it("does not let a PostgreSQL dollar quote hide a second statement", () => {
    denied("pgsql", "SELECT $$'$$ ; DELETE FROM t WHERE true; SELECT ' LIMIT 1 ' -- '");
    denied("pgsql", "SELECT $x$'$x$ ; DELETE FROM t WHERE true; SELECT ' LIMIT 1 ' -- '");
    denied("pgsql", "SELECT $$ unterminated LIMIT 1");
    allowed("pgsql", "SELECT $$it's; DELETE$$ AS note LIMIT 1");
    allowed("pgsql", "SELECT $tag$a $$ b$tag$ AS note FROM t WHERE id = $1 LIMIT 1");
    allowed("pgsql", "SELECT price$usd$ FROM t LIMIT 1");
  });

  it("tracks nested block comments where the engine nests them", () => {
    denied("pgsql", "SELECT 1 /* /* */ ' */ ; DELETE FROM t WHERE true; SELECT ' LIMIT 1 -- '");
    denied("mssql", "SELECT TOP 1 1 /* /* */ ' */ SHUTDOWN SELECT ' AS x -- '");
    denied("pgsql", "SELECT 1 /* /* */ LIMIT 1");
    allowed("pgsql", "SELECT 1 /* outer /* inner */ still comment */ LIMIT 1");
    allowed("mysql", "SELECT 1 /* /* */ LIMIT 1");
  });

  it("handles SQL Server bracket escapes", () => {
    denied("mssql", "SELECT TOP 1 [a]]'b] FROM t SHUTDOWN SELECT 'x'");
    allowed("mssql", "SELECT TOP 1 [a]]b], [set] FROM [t]");
  });

  it("rejects backslashes in MySQL and PostgreSQL literals", () => {
    denied("mysql", "SELECT '\\'' ; DELETE FROM t WHERE 1; SELECT ' LIMIT 1 ' -- '");
    denied("mysql", "SELECT \"\\\"\" LIMIT 1");
    denied("pgsql", "SELECT E'\\'' ; DELETE FROM t WHERE true; SELECT ' LIMIT 1 ' -- '");
    allowed("mssql", "SELECT TOP 1 'C:\\temp' AS path");
    allowed("pgsql", "SELECT \"odd\\name\" FROM t LIMIT 1");
  });

  it("handles MySQL backticks, # comments and the -- whitespace rule", () => {
    denied("mysql", "SELECT `'` FROM t; DROP TABLE x; SELECT '` LIMIT 1");
    allowed("mysql", "SELECT `we'ird``name` FROM t LIMIT 1");
    allowed("mysql", "SELECT 1 # trailing ' comment\nLIMIT 1");
    // "--1" is not a comment in MySQL: the quote after it opens a string, which stays unterminated.
    denied("mysql", "SELECT 1 --1 '\nLIMIT 1");
    allowed("mysql", "SELECT 1 -- comment '\nLIMIT 1");
  });

  it("denies SQL Server statements that need no separator", () => {
    for (const tail of ["SHUTDOWN WITH NOWAIT", "WAITFOR DELAY '00:05:00'", "BACKUP DATABASE d TO DISK='C:/x.bak'",
      "DECLARE @k int SET @k = 1 KILL 55", "DBCC CHECKDB", "RESTORE DATABASE d FROM DISK='x'", "USE master",
      "RECONFIGURE", "DENY SELECT ON t TO u", "BEGIN TRAN", "COMMIT"]) {
      denied("mssql", `SELECT TOP 1 1 AS x ${tail}`);
    }
    denied("mssql", "SELECT TOP 1 * FROM OPENQUERY(linked, 'DELETE FROM t')");
    denied("mssql", "SELECT TOP 1 * FROM OPENROWSET('SQLNCLI', 'x', 'EXEC p')");
    allowed("mssql", "SELECT TOP 10 name FROM users WHERE id = @id ORDER BY name OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY");
    allowed("mssql", "WITH x AS (SELECT id FROM t) SELECT TOP 5 CASE WHEN id > 1 THEN 1 END AS v FROM x");
  });

  it("keeps the second statement out of SQL Server updates", () => {
    expect(() => assertUpdateSql("mssql", "UPDATE t SET a = 1 WHERE id = @id SHUTDOWN")).toThrow(/one INSERT/);
    expect(() => assertUpdateSql("mssql", "DELETE FROM t WHERE id = 1 DROP TABLE x")).toThrow(/one INSERT/);
    expect(() => assertUpdateSql("mssql", "UPDATE t SET [a] = 1 WHERE id = @id")).not.toThrow();
    // A batch needs no separator, so a second DML or SELECT ... INTO must be rejected too.
    expect(() => assertUpdateSql("mssql", "UPDATE t SET a = 1 WHERE id = @id DELETE FROM t")).toThrow(/one INSERT/);
    expect(() => assertUpdateSql("mssql", "DELETE FROM t WHERE id = 1 INSERT INTO t (a) VALUES (1)")).toThrow(/one INSERT/);
    expect(() => assertUpdateSql("mssql", "INSERT INTO t (a) VALUES (1) UPDATE t SET a = 2")).toThrow(/one INSERT/);
    expect(() => assertUpdateSql("mssql", "UPDATE t SET a = 1 WHERE id = @id SELECT * INTO copy FROM t")).toThrow(/one INSERT/);
    expect(() => assertUpdateSql("mssql", "INSERT INTO t (a) VALUES (1)")).not.toThrow();
    expect(() => assertUpdateSql("mssql", "INSERT INTO t (a) SELECT a FROM u")).not.toThrow();
    expect(() => assertUpdateSql("mssql", "UPDATE t SET [delete] = 1 WHERE id = @id")).not.toThrow();
    expect(() => assertUpdateSql("mysql", "UPDATE t SET a = 1 WHERE id = ?")).not.toThrow();
  });

  it("rejects unterminated quoted identifiers and NUL characters", () => {
    denied("mssql", "SELECT TOP 1 [unterminated FROM t");
    denied("mysql", "SELECT `unterminated FROM t LIMIT 1");
    denied("pgsql", "SELECT 1\0 LIMIT 1");
  });
});

describe("MSSQL TOP must bound every returned row", () => {
  it("keeps the baseline behavior", () => {
    denied("mssql", "select * from t");
    allowed("mssql", "select top 100 a from t");
    denied("mssql", "select top 201 a from t");
  });

  it("rejects TOP ... PERCENT and WITH TIES, which do not cap the row count", () => {
    denied("mssql", "select top 100 percent * from huge");
    denied("mssql", "select top 1 percent a from huge");
    denied("mssql", "select top 10 with ties a from t order by a");
  });

  it("requires a compliant TOP in every set-operation branch", () => {
    denied("mssql", "select top 1 a from t union all select b from huge");
    denied("mssql", "select a from huge union all select top 1 b from t");
    denied("mssql", "select top 1 a from t intersect select b from huge");
    denied("mssql", "select top 1 a from t except select b from huge");
    denied("mssql", "select top 200 a from t union all select top 200 b from u");
    allowed("mssql", "select top 100 a from t union all select top 100 b from u");
    allowed("mssql", "select top 50 a from t union select top 50 b from u order by 1");
  });
});
