import { describe, expect, it } from "vitest";
import { assertReadOnlySql, assertUpdateSql } from "../src/security/sql-policy.js";

// SQL Server runs `SELECT ... SELECT ...` as two statements with no separator, so a second SELECT must not slip past the
// TOP cap (reads) or ride along after a write (updates).
const readDenied = (sql: string) => expect(() => assertReadOnlySql("mssql", sql), sql).toThrow(/single|TOP/i);
const readAllowed = (sql: string) => expect(() => assertReadOnlySql("mssql", sql), sql).not.toThrow();
const updateDenied = (sql: string) => expect(() => assertUpdateSql("mssql", sql), sql).toThrow(/one INSERT/);
const updateAllowed = (sql: string) => expect(() => assertUpdateSql("mssql", sql), sql).not.toThrow();

describe("mssql reads: one query, whatever follows the first SELECT", () => {
  it("rejects a second top-level SELECT, with or without TOP", () => {
    readDenied("SELECT TOP 10 a FROM t SELECT TOP 100000 b FROM huge");
    readDenied("SELECT TOP 10 a FROM t SELECT b FROM huge");
    readDenied("SELECT a FROM t SELECT TOP 10 b FROM huge");
    readDenied("WITH x AS (SELECT 1 AS a) SELECT TOP 5 a FROM x SELECT TOP 5 a FROM x");
  });

  it("keeps single queries: set operations, CTEs, subqueries and EXISTS", () => {
    readAllowed("SELECT TOP 10 a FROM t UNION ALL SELECT TOP 10 b FROM u");
    readAllowed("SELECT TOP 5 a FROM t INTERSECT SELECT TOP 5 b FROM u");
    readAllowed("WITH x AS (SELECT id FROM t) SELECT TOP 5 id FROM x");
    readAllowed("SELECT TOP 5 (SELECT TOP 1 id FROM t) AS v FROM u");
    readAllowed("SELECT TOP 5 a FROM t WHERE EXISTS (SELECT 1 FROM u WHERE u.id = t.id)");
    readAllowed("SELECT TOP 5 a FROM (SELECT a FROM t) q");
  });
});

describe("mssql updates: no SELECT riding along after a write", () => {
  it("rejects a top-level SELECT after UPDATE, DELETE or INSERT ... VALUES", () => {
    updateDenied("UPDATE t SET a = 1 WHERE id = 2 SELECT TOP 900000 * FROM huge");
    updateDenied("DELETE FROM t WHERE id = 1 SELECT TOP 900000 * FROM huge");
    updateDenied("INSERT INTO t (a) VALUES (1) SELECT TOP 900000 * FROM huge");
    updateDenied("INSERT INTO t (a) SELECT TOP 5 b FROM u SELECT TOP 900000 * FROM huge");
  });

  it("keeps single writes: subqueries and INSERT ... SELECT", () => {
    updateAllowed("INSERT INTO t (a) SELECT TOP 5 b FROM u");
    updateAllowed("INSERT INTO t (a) SELECT TOP 5 b FROM u UNION ALL SELECT TOP 5 c FROM v");
    updateAllowed("UPDATE t SET a = (SELECT TOP 1 b FROM u WHERE u.id = t.id) WHERE id = 2");
    updateAllowed("DELETE FROM t WHERE id IN (SELECT id FROM u)");
    updateAllowed("INSERT INTO t (a) VALUES ((SELECT TOP 1 b FROM u))");
  });
});
