import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerEngineTools } from "../src/tools.js";
import type { SqlConnectorRuntime } from "../src/runtime.js";
import { ENGINES } from "../src/types.js";

for (const engine of ENGINES) {
  describe(`${engine} deferred tools`, () => {
    function fixture(hasUI: boolean, confirmed = false) {
      const tools = new Map<string, ToolDefinition>();
      const runtime = {
        state: vi.fn(async () => ({ engine, database: "fixture", version: "test" })),
        query: vi.fn(async () => ({ rows: [{ id: 1, password: "synthetic-only" }], rowCount: 1 })),
        update: vi.fn(async () => ({ affectedRows: 1 })),
      };
      registerEngineTools({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as unknown as ExtensionAPI, runtime as unknown as SqlConnectorRuntime, engine);
      const ctx = { hasUI, ui: { confirm: vi.fn(async () => confirmed) } } as unknown as ExtensionToolContext;
      const call = (action: string, params: Record<string, unknown>) => tools.get(`${engine}_${action}`)!.execute("test", params, undefined, undefined, ctx);
      return { runtime, ctx, call, tools };
    }
    it("defers all three tools and preserves parameter binding and redaction", async () => {
      const f = fixture(false);
      for (const tool of f.tools.values()) {
        expect(tool.exposure).toBe("deferred");
        expect(tool.namespace?.name).toBe(engine);
      }
      const params = engine === "mssql" ? { id: 1 } : [1];
      const sql = engine === "mssql" ? "SELECT TOP 1 id FROM users WHERE id = @id" : engine === "pgsql" ? "SELECT id FROM users WHERE id = $1 LIMIT 1" : "SELECT id FROM users WHERE id = ? LIMIT 1";
      const result = await f.call("query", { sql, params });
      expect(f.runtime.query).toHaveBeenCalledWith(engine, sql, params, undefined);
      expect(JSON.stringify(result.content)).toContain("[REDACTED]");
      expect(JSON.stringify(result.content)).not.toContain("synthetic-only");
    });
    it("rejects unattended or denied writes without reaching the runtime", async () => {
      for (const hasUI of [false, true]) {
        const f = fixture(hasUI);
        await expect(f.call("update", { sql: "DELETE FROM users WHERE id = 1", reason: "fixture" })).rejects.toThrow(hasUI ? /not confirmed/ : /interactive confirmation/);
        expect(f.runtime.update).not.toHaveBeenCalled();
      }
    });
    it("requires valid SQL and confirmation before executing an allowed write", async () => {
      const f = fixture(true, true);
      await expect(f.call("update", { sql: "DELETE FROM users", reason: "fixture" })).rejects.toThrow(/WHERE/);
      expect(f.runtime.update).not.toHaveBeenCalled();
      const sql = "DELETE FROM users WHERE id = 1";
      await f.call("update", { sql, reason: "fixture" });
      expect(f.runtime.update).toHaveBeenCalledWith(engine, sql, undefined, undefined);
    });
  });
}
