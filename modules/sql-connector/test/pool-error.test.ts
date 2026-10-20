import { describe, expect, it } from "vitest";
import { SqlConnectorRuntime } from "../src/runtime.js";
import type { Engine } from "../src/types.js";

/** Real pg / mssql pools (no mocks): constructing a pool does not connect, so these stay offline. */
async function poolOf(engine: Engine): Promise<{ emit(event: string, ...args: unknown[]): boolean }> {
  const runtime = new SqlConnectorRuntime({ [engine]: { host: "127.0.0.1", port: 1, username: "u", password: "p", database: "d" } } as never);
  // Creating the adapter is what builds the pool; state() would connect, so reach the adapter directly.
  const adapter = await (runtime as unknown as { adapter(engine: Engine): Promise<{ pool: { emit(event: string, ...args: unknown[]): boolean } }> }).adapter(engine);
  return adapter.pool;
}

describe("idle pool errors", () => {
  // pg-pool emits 'error' on the pool when an idle client is terminated (for example 57P01);
  // an EventEmitter without an 'error' listener throws, which would take down the whole Pi process.
  it.each(["pgsql", "mssql"] as const)("%s pool tolerates an 'error' event", async (engine) => {
    const pool = await poolOf(engine);
    expect(() => pool.emit("error", new Error("terminating connection due to administrator command"))).not.toThrow();
  });
});
