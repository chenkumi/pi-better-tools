import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sqlConnectorExtension from "../src/index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function configuredCwd(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sql-connector-extension-"));
  directories.push(cwd);
  await mkdir(join(cwd, ".pi", "agent"), { recursive: true });
  await writeFile(join(cwd, ".pi", "agent", "sql-connector.json"), JSON.stringify({
    mysql: { host: "localhost", username: "root", password: "secret", database: "app" },
    pgsql: { host: "localhost", username: "reader", password: "secret", database: "analytics" },
  }));
  return cwd;
}

describe("Pi extension lifecycle", () => {
  it("registers only configured deferred database tools with matching loaded-tool guidance", async () => {
    const handlers = new Map<string, (event: any, ctx: any) => any>();
    const tools: Array<{ name: string; exposure: string; namespace: { name: string }; promptGuidelines?: string[] }> = [];
    const statuses: Array<string | undefined> = [];
    const pi = {
      on: (name: string, handler: (event: any, ctx: any) => any) => handlers.set(name, handler),
      registerTool: (tool: (typeof tools)[number]) => tools.push(tool),
      registerCommand: () => undefined,
    } as any;
    sqlConnectorExtension(pi);

    const cwd = await configuredCwd();
    const ctx = {
      cwd,
      hasUI: false,
      isProjectTrusted: () => true,
      ui: { setStatus: (_key: string, value: string | undefined) => statuses.push(value), notify: () => undefined },
    };
    await handlers.get("session_start")!({}, ctx);

    expect(tools.map((tool) => tool.name)).toEqual([
      "mysql_state", "mysql_query", "mysql_update",
      "pgsql_state", "pgsql_query", "pgsql_update",
    ]);
    expect(statuses.at(-1)).toBe("SQL: mysql, pgsql");
    for (const tool of tools) {
      expect(tool.exposure).toBe("deferred");
      expect(tool.namespace.name).toBe(tool.name.split("_")[0]);
    }
    expect(handlers.has("before_agent_start")).toBe(false);
    const guidance = tools.flatMap(tool => tool.promptGuidelines ?? []).join("\n");
    expect(guidance).toContain("mysql_query/mysql_update use `?`");
    expect(guidance).toContain("pgsql_query/pgsql_update use `$1`");
    expect(guidance).not.toContain("mssql_query");
    await handlers.get("session_shutdown")!({}, ctx);
  });
});
