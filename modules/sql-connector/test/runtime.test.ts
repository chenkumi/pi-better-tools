import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => ({ calls: [] as unknown[], fail: undefined as string | undefined, released: [] as unknown[] }));
const mysql = vi.hoisted(() => ({ calls: [] as unknown[], fail: false, destroyed: 0, releasedCount: 0, poolOptions: undefined as unknown }));

vi.mock("pg", async (importOriginal) => {
  const actual = await importOriginal<typeof import("pg")>();
  class Pool {
    async connect() {
      return {
        query: async (config: unknown) => {
          pg.calls.push(config);
          if (pg.fail && JSON.stringify(config).includes(pg.fail)) throw Object.assign(new Error("synthetic"), { code: "57014" });
          return { rows: [{ id: 1 }], rowCount: 1 };
        },
        release: (error?: unknown) => { pg.released.push(error); },
      };
    }
    async end() {}
  }
  return { ...actual, Pool, default: { ...actual, Pool } };
});

vi.mock("mysql2/promise", () => {
  const createPool = (options: unknown) => {
    mysql.poolOptions = options;
    return {
      getConnection: async () => ({
        query: async (sql: unknown) => { mysql.calls.push(["query", sql]); return [[], []]; },
        execute: async (options: unknown, values: unknown) => {
          mysql.calls.push(["execute", options, values]);
          if (mysql.fail) throw Object.assign(new Error("Query inactivity timeout"), { code: "PROTOCOL_SEQUENCE_TIMEOUT" });
          return [[{ id: 1 }], []];
        },
        release: () => { mysql.releasedCount++; },
        destroy: () => { mysql.destroyed++; },
      }),
      end: async () => {},
    };
  };
  return { default: { createPool }, createPool };
});

const { SqlConnectorRuntime, pgQueryConfig } = await import("../src/runtime.js");
// The installed driver's real Query class decides between the simple and extended protocol.
const Query = createRequire(import.meta.url)("pg/lib/query.js") as new (config: object) => { requiresPreparation(): boolean };

const base = { host: "127.0.0.1", username: "u", password: "p", database: "d", ssl: false, windowsAuth: false, trustServerCertificate: false };

beforeEach(() => {
  pg.calls = []; pg.fail = undefined; pg.released = [];
  mysql.calls = []; mysql.fail = false; mysql.destroyed = 0; mysql.releasedCount = 0;
});

describe("PostgreSQL runtime", () => {
  it("never uses the multi-statement simple protocol, even without params", () => {
    const config = pgQueryConfig("SELECT 1 LIMIT 1", undefined);
    expect(config).toEqual({ text: "SELECT 1 LIMIT 1", values: [], queryMode: "extended" });
    expect(new Query(config).requiresPreparation()).toBe(true);
    // Control: the previous shape was sent as a simple (multi-statement) query.
    expect(new Query({ text: "SELECT 1", values: [] }).requiresPreparation()).toBe(false);
  });

  it("runs reads inside a read-only transaction that is rolled back", async () => {
    const runtime = new SqlConnectorRuntime({ pgsql: { ...base, port: 5432 } });
    const result = await runtime.query("pgsql", "SELECT id FROM t LIMIT 1", undefined);
    expect(result.rows).toEqual([{ id: 1 }]);
    expect(pg.calls).toEqual(["BEGIN READ ONLY", { text: "SELECT id FROM t LIMIT 1", values: [], queryMode: "extended" }, "ROLLBACK"]);
    expect(pg.released).toEqual([undefined]);
  });

  it("discards a client whose read failed inside the transaction", async () => {
    pg.fail = "SELECT";
    const runtime = new SqlConnectorRuntime({ pgsql: { ...base, port: 5432 } });
    await expect(runtime.query("pgsql", "SELECT id FROM t LIMIT 1", undefined)).rejects.toThrow();
    expect(pg.calls).not.toContain("ROLLBACK");
    expect(pg.released).toHaveLength(1);
    expect(pg.released[0]).toBeInstanceOf(Error);
  });

  it("sends updates through the extended protocol", async () => {
    const runtime = new SqlConnectorRuntime({ pgsql: { ...base, port: 5432 } });
    await runtime.update("pgsql", "DELETE FROM t WHERE id = 1", undefined);
    expect(pg.calls).toEqual([{ text: "DELETE FROM t WHERE id = 1", values: [], queryMode: "extended" }]);
  });
});

describe("MySQL runtime", () => {
  it("bounds the connection queue", async () => {
    await new SqlConnectorRuntime({ mysql: { ...base, port: 3306 } }).state("mysql");
    expect((mysql.poolOptions as { queueLimit: number }).queueLimit).toBe(32);
  });

  it("runs reads with a timeout inside a read-only transaction", async () => {
    const runtime = new SqlConnectorRuntime({ mysql: { ...base, port: 3306 } });
    await runtime.query("mysql", "SELECT id FROM t WHERE id = ? LIMIT 1", [1]);
    expect(mysql.calls).toEqual([
      ["query", "START TRANSACTION READ ONLY"],
      ["execute", { sql: "SELECT id FROM t WHERE id = ? LIMIT 1", timeout: 30_000 }, [1]],
      ["query", "ROLLBACK"],
    ]);
    expect(mysql.releasedCount).toBe(1);
    expect(mysql.destroyed).toBe(0);
  });

  it("destroys a timed-out connection instead of pooling it", async () => {
    mysql.fail = true;
    const runtime = new SqlConnectorRuntime({ mysql: { ...base, port: 3306 } });
    await expect(runtime.query("mysql", "SELECT id FROM t LIMIT 1", undefined)).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(mysql.destroyed).toBe(1);
    expect(mysql.releasedCount).toBe(0);
  });
});
