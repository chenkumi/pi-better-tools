import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => ({ calls: [] as unknown[], fail: undefined as string | undefined, released: [] as unknown[] }));
const mysql = vi.hoisted(() => ({ calls: [] as unknown[], fail: false, failCreate: false, hangEnd: false, gate: undefined as Promise<void> | undefined, getFailure: undefined as Error | undefined, destroyed: 0, releasedCount: 0, poolOptions: undefined as unknown }));

vi.mock("pg", async (importOriginal) => {
  const actual = await importOriginal<typeof import("pg")>();
  class Pool {
    on() { return this; }
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
    if (mysql.failCreate) throw new Error("synthetic driver construction failure");
    mysql.poolOptions = options;
    return {
      getConnection: async () => {
        // A full pool: the request waits in the driver queue until the gate opens.
        if (mysql.gate) await mysql.gate;
        if (mysql.getFailure) throw mysql.getFailure;
        return {
        query: async (sql: unknown) => { mysql.calls.push(["query", sql]); return [[], []]; },
        execute: async (options: unknown, values: unknown) => {
          mysql.calls.push(["execute", options, values]);
          if (mysql.fail) throw Object.assign(new Error("Query inactivity timeout"), { code: "PROTOCOL_SEQUENCE_TIMEOUT" });
          return [[{ id: 1 }], []];
        },
        release: () => { mysql.releasedCount++; },
        destroy: () => { mysql.destroyed++; },
        };
      },
      end: async () => { if (mysql.hangEnd) await new Promise(() => undefined); },
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
  mysql.calls = []; mysql.fail = false; mysql.failCreate = false; mysql.hangEnd = false; mysql.gate = undefined; mysql.getFailure = undefined; mysql.destroyed = 0; mysql.releasedCount = 0;
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
  it("retries adapter construction after a failure instead of caching the rejection until reload", async () => {
    const runtime = new SqlConnectorRuntime({ mysql: { ...base, port: 3306 } });
    mysql.failCreate = true;
    await expect(runtime.state("mysql")).rejects.toThrow("synthetic driver construction failure");
    mysql.failCreate = false;
    await expect(runtime.state("mysql")).resolves.toMatchObject({ engine: "mysql" });
    await runtime.close();
  });

  it("stops waiting for a pool whose close hangs behind a stuck statement", async () => {
    vi.useFakeTimers();
    try {
      const runtime = new SqlConnectorRuntime({ mysql: { ...base, port: 3306 } });
      await runtime.state("mysql");
      mysql.hangEnd = true;
      let closed = false;
      const closing = runtime.close().then((unconfirmed) => { closed = true; return unconfirmed; });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await closing).toBe(1);
      expect(closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds the connection queue", async () => {
    await new SqlConnectorRuntime({ mysql: { ...base, port: 3306 } }).state("mysql");
    expect((mysql.poolOptions as { queueLimit: number }).queueLimit).toBe(32);
  });

  it("verifies the server certificate with ssl, and skips verification only when trusted explicitly", async () => {
    const tls = async (overrides: object) => {
      await new SqlConnectorRuntime({ mysql: { ...base, port: 3306, ...overrides } }).state("mysql");
      return (mysql.poolOptions as { ssl?: unknown }).ssl;
    };
    expect(await tls({})).toBeUndefined();
    expect(await tls({ trustServerCertificate: true })).toBeUndefined();
    expect(await tls({ ssl: true })).toEqual({});
    expect(await tls({ ssl: true, trustServerCertificate: true })).toEqual({ rejectUnauthorized: false });
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

  describe("cancelling while the pool is full", () => {
    const open = () => { let release!: () => void; mysql.gate = new Promise<void>((resolve) => { release = resolve; }); return release; };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    it("ends a queued read at once, runs nothing, and gives a late connection back unused", async () => {
      const release = open();
      const runtime = new SqlConnectorRuntime({ mysql: { ...base, port: 3306 } });
      const controller = new AbortController();
      const queued = runtime.query("mysql", "SELECT id FROM t LIMIT 1", undefined, controller.signal);
      const outcome = queued.then(() => "resolved", (error: unknown) => error);
      await settle();
      controller.abort();
      await expect(outcome).resolves.toMatchObject({ code: "TIMEOUT", message: "The database request was cancelled." });
      release(); // the pool finally has a connection for the abandoned request
      await settle();
      expect(mysql.releasedCount).toBe(1);
      expect(mysql.destroyed).toBe(0);
      expect(mysql.calls).toEqual([]);
    });

    it("a queued update is cancelled without claiming the statement may have been applied", async () => {
      const release = open();
      const runtime = new SqlConnectorRuntime({ mysql: { ...base, port: 3306 } });
      const controller = new AbortController();
      const outcome = runtime.update("mysql", "UPDATE t SET a = ? WHERE id = ?", [1, 2], controller.signal).then(() => "resolved", (error: Error) => error);
      await settle();
      controller.abort();
      const error = await outcome;
      expect(error).toMatchObject({ code: "TIMEOUT" });
      expect((error as Error).message).not.toMatch(/may or may not/);
      release();
      await settle();
      expect(mysql.calls).toEqual([]);
      expect(mysql.releasedCount).toBe(1);
    });

    it("without an abort the queued call still runs normally, and a pool failure is still reported", async () => {
      const release = open();
      const runtime = new SqlConnectorRuntime({ mysql: { ...base, port: 3306 } });
      const controller = new AbortController();
      const waiting = runtime.query("mysql", "SELECT id FROM t LIMIT 1", undefined, controller.signal);
      release();
      await expect(waiting).resolves.toMatchObject({ rowCount: 1 });
      expect(mysql.releasedCount).toBe(1);
      controller.abort(); // after completion: no effect
      mysql.getFailure = new Error("Queue limit reached.");
      await expect(runtime.query("mysql", "SELECT id FROM t LIMIT 1", undefined, new AbortController().signal)).rejects.toBeInstanceOf(Error);
    });

    it("an already aborted signal never reaches the pool", async () => {
      const runtime = new SqlConnectorRuntime({ mysql: { ...base, port: 3306 } });
      const controller = new AbortController();
      controller.abort();
      await expect(runtime.state("mysql", controller.signal)).rejects.toMatchObject({ code: "TIMEOUT" });
      expect(mysql.calls).toEqual([]);
    });
  });
});
