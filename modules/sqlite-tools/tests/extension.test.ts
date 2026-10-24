import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import sqliteExtension from "../src/index.js";

const commonTools = [
  "sqlite_status",
  "sqlite_query",
  "sqlite_execute",
  "sqlite_list_tables",
  "sqlite_describe_table",
  "sqlite_manual",
];
const manualTools = [...commonTools, "sqlite_open", "sqlite_close"];
/**
 * Agent-facing text may name tool arguments, tool names and slash commands, but never settings files or keys,
 * environment variable names or settings paths.
 */
const CONFIG_LEAK = /SQLITE_PATH|sqlite\.json|\.pi[\\/]agent|databasePath|\.json\b|\bconfig(?:uration)? file\b/i;
function assertNoConfigLeak(text: string) {
  assert.doesNotMatch(text, CONFIG_LEAK);
}
const closedStatus ={ isOpen: false, filePath: null, tables: null };
function omitDiagnostics(status: Record<string, unknown>) {
  const { hint: _hint, startupError: _startupError, ...rest } = status;
  return rest;
}

type Handler = (event: { type: string; reason: string }, ctx: ExtensionContext) => void | Promise<void>;

// Top-level tests run serially; isolate and restore SQLITE_PATH for every fixture.
function fixture(t: TestContext, options: { trusted?: boolean; hasUI?: boolean; envPath?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "pi-sqlite-extension-"));
  const oldPath = process.env.SQLITE_PATH;
  if (options.envPath === undefined) delete process.env.SQLITE_PATH;
  else process.env.SQLITE_PATH = options.envPath;

  const tools = new Map<string, ToolDefinition>();
  const registrations: string[] = [];
  const handlers = new Map<string, Handler>();
  const notifications: Array<{ message: string; type: string }> = [];
  const ctx = {
    cwd: directory,
    hasUI: options.hasUI ?? true,
    isProjectTrusted: () => options.trusted ?? true,
    ui: {
      notify: (message: string, type: string) => notifications.push({ message, type }),
    },
  } as unknown as ExtensionToolContext;
  const api = {
    registerTool: (tool: ToolDefinition) => {
      registrations.push(tool.name);
      tools.set(tool.name, tool);
    },
    on: (event: string, handler: Handler) => handlers.set(event, handler),
  } as unknown as ExtensionAPI;
  sqliteExtension(api);

  async function emit(type: string, reason: string) {
    const handler = handlers.get(type);
    assert.ok(handler, `Missing handler: ${type}`);
    await handler({ type, reason }, ctx);
  }
  const configPath = join(directory, ".pi", "agent", "sqlite.json");
  function config(contents: string) {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, contents, "utf8");
  }
  async function call(name: string, params: Record<string, unknown> = {}) {
    const tool = tools.get(name);
    assert.ok(tool, `Missing tool: ${name}`);
    return tool.execute("test", params, undefined, undefined, ctx);
  }
  async function json(name: string, params: Record<string, unknown> = {}) {
    const result = await call(name, params);
    const content = result.content[0];
    assert.equal(content.type, "text");
    if (content.type !== "text") throw new Error("Expected text");
    return JSON.parse(content.text);
  }

  t.after(async () => {
    try {
      await emit("session_shutdown", "quit");
    } finally {
      if (oldPath === undefined) delete process.env.SQLITE_PATH;
      else process.env.SQLITE_PATH = oldPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  return {
    directory, configPath, config, ctx, tools, registrations, notifications, call, json,
    start: (reason = "startup") => emit("session_start", reason),
    shutdown: () => emit("session_shutdown", "quit"),
  };
}

test("registers common tools at load and manual tools only after startup without configuration", async (t) => {
  const f = fixture(t);
  assert.deepEqual([...f.tools.keys()], commonTools);
  assert.deepEqual(omitDiagnostics(await f.json("sqlite_status")), closedStatus);
  await f.start();
  assert.deepEqual([...f.tools.keys()], manualTools);
  assert.deepEqual(f.notifications, []);
  for (const tool of f.tools.values()) {
    assert.equal(tool.exposure, "deferred", tool.name);
    assert.equal(tool.namespace?.name, "sqlite", tool.name);
    assert.match(tool.namespace?.description ?? "", /read SQLite.*tool_search/);
    assert.notEqual(tool.defaultActive, true, tool.name);
  }
});

for (const pathKind of ["relative", "absolute"] as const) {
  test(`opens the ${pathKind} configured path without registering manual tools`, async (t) => {
    const f = fixture(t);
    const databasePath = join(f.directory, "資料 app.sqlite");
    f.config(JSON.stringify({ databasePath: pathKind === "absolute" ? databasePath : "./資料 app.sqlite" }));
    assert.notEqual(f.ctx.cwd, process.cwd(), "Test must exercise the session cwd, not process.cwd()");
    await f.start();
    assert.deepEqual(f.registrations, commonTools);
    assert.deepEqual(await f.json("sqlite_status"), { isOpen: true, filePath: databasePath, tables: 0 });
    assert.deepEqual(await f.json("sqlite_query", { sql: "SELECT 42 AS value" }), {
      columns: ["value"], rows: [[42]], rowCount: 1,
    });
    assert.equal(existsSync(databasePath), true);
    assert.deepEqual(f.notifications, []);
  });
}

test("accepts a UTF-8 BOM and preserves a literal @ in a configured file name", async (t) => {
  const f = fixture(t);
  f.config('\uFEFF{"databasePath":"@app.sqlite"}');
  await f.start();
  assert.equal((await f.json("sqlite_status")).filePath, join(f.directory, "@app.sqlite"));
  assert.deepEqual(f.registrations, commonTools);
});

for (const trusted of [true, false]) {
  test(`SQLITE_PATH takes precedence over project configuration (trusted=${trusted})`, async (t) => {
    const f = fixture(t, { trusted, envPath: "  @./environment.sqlite  " });
    f.config("{invalid JSON");
    await f.start();
    assert.deepEqual(f.registrations, commonTools);
    assert.deepEqual(await f.json("sqlite_status"), {
      isOpen: true, filePath: join(f.directory, "environment.sqlite"), tables: 0,
    });
    assert.deepEqual(f.notifications, []);
  });
}

test("reads SQLITE_PATH at startup rather than module import", async (t) => {
  const f = fixture(t);
  process.env.SQLITE_PATH = join(f.directory, "late-env.sqlite");
  await f.start();
  assert.equal((await f.json("sqlite_status")).filePath, process.env.SQLITE_PATH);
  assert.deepEqual(f.registrations, commonTools);
});

test("a whitespace-only SQLITE_PATH allows the trusted project configuration", async (t) => {
  const f = fixture(t, { envPath: " \t " });
  f.config('{"databasePath":"project.sqlite"}');
  await f.start();
  assert.equal((await f.json("sqlite_status")).filePath, join(f.directory, "project.sqlite"));
  assert.deepEqual(f.registrations, commonTools);
});

test("ignores both valid and invalid project settings in an untrusted project", async (t) => {
  for (const contents of ['{"databasePath":"must-not-open.sqlite"}', "{broken JSON"]) {
    await t.test(contents, async (t) => {
      const f = fixture(t, { trusted: false });
      f.config(contents);
      await f.start();
      assert.deepEqual(f.registrations, manualTools);
      assert.deepEqual(omitDiagnostics(await f.json("sqlite_status")), closedStatus);
      assert.equal(existsSync(join(f.directory, "must-not-open.sqlite")), false);
      assert.deepEqual(f.notifications, []);
    });
  }
});

const invalidConfigs = [
  "{broken JSON", "null", "[]", "42", "true", '"path.sqlite"', "{}",
  '{"databasePath":null}', '{"databasePath":42}', '{"databasePath":[]}',
  '{"databasePath":""}', '{"databasePath":" \\t "}',
];
for (const contents of invalidConfigs) {
  test(`invalid configuration does not fall back to manual mode: ${contents}`, async (t) => {
    const f = fixture(t);
    f.config(contents);
    await f.start();
    assert.deepEqual(f.registrations, commonTools);
    assert.deepEqual(omitDiagnostics(await f.json("sqlite_status")), closedStatus);
    assert.equal(f.notifications.length, 1);
    assert.equal(f.notifications[0].type, "error");
    // The human-only UI notice keeps the exact settings file path.
    assert.ok(f.notifications[0].message.includes(f.configPath));
    await assert.rejects(f.call("sqlite_query", { sql: "SELECT 1" }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Invalid SQLite project settings/);
      assert.match(error.message, /ask the user/i);
      assertNoConfigLeak(error.message);
      assert.ok(!error.message.includes(f.configPath));
      return true;
    });
  });
}

test("manual tools retain the database workflow and shutdown is idempotent", async (t) => {
  const f = fixture(t);
  await f.start();
  assert.equal((await f.json("sqlite_open", { file_path: "@./manual.sqlite" })).success, true);
  assert.equal((await f.json("sqlite_status")).filePath, join(f.directory, "manual.sqlite"));
  await f.json("sqlite_execute", { sql: "CREATE TABLE users (name TEXT)" });
  await f.json("sqlite_execute", { sql: "INSERT INTO users VALUES (?)", bindings: ["Ada"] });
  assert.deepEqual(await f.json("sqlite_query", { sql: "SELECT name FROM users" }), {
    columns: ["name"], rows: [["Ada"]], rowCount: 1,
  });
  assert.equal((await f.json("sqlite_close")).success, true);
  assert.deepEqual(omitDiagnostics(await f.json("sqlite_status")), closedStatus);
  await f.json("sqlite_open", { file_path: "manual.sqlite" });
  await f.shutdown();
  await f.shutdown();
  assert.deepEqual(omitDiagnostics(await f.json("sqlite_status")), closedStatus);
  await assert.rejects(f.call("sqlite_open", { file_path: "after-shutdown.sqlite" }), /shut down/);
  assert.equal(existsSync(join(f.directory, "after-shutdown.sqlite")), false);
});

test("fixed mode supports bindings, schema tools and shutdown without switching tools", async (t) => {
  const f = fixture(t);
  f.config('{"databasePath":"fixed.sqlite"}');
  await f.start();
  await f.json("sqlite_execute", { sql: "CREATE TABLE users (id INTEGER, name TEXT)" });
  await f.json("sqlite_execute", {
    sql: "INSERT INTO users VALUES (?, ?)", bindings: [1, "Ada"],
  });
  await f.json("sqlite_execute", {
    sql: "INSERT INTO users VALUES (:id, :name)", params: { id: 2, name: "Grace" },
  });
  assert.deepEqual(await f.json("sqlite_list_tables"), { tables: ["users"] });
  assert.equal((await f.json("sqlite_describe_table", { table_name: "users" })).rowCount, 2);
  assert.deepEqual(await f.json("sqlite_query", {
    sql: "SELECT name FROM users WHERE id = :id", bindings: { id: 2 },
  }), { columns: ["name"], rows: [["Grace"]], rowCount: 1 });
  assert.deepEqual(f.registrations, commonTools);
  await f.shutdown();
  assert.deepEqual(omitDiagnostics(await f.json("sqlite_status")), closedStatus);
  await assert.rejects(f.call("sqlite_query", { sql: "SELECT 1" }), /shut down/);
});

for (const source of ["environment", "config"] as const) {
  test(`failed ${source} database opening blocks all data tools without UI or fallback`, async (t) => {
    const f = fixture(t, { hasUI: false });
    const path = join(f.directory, "missing-parent", "app.sqlite");
    if (source === "environment") {
      process.env.SQLITE_PATH = path;
      f.config('{"databasePath":"must-not-fallback.sqlite"}');
    } else {
      f.config(JSON.stringify({ databasePath: path }));
    }
    await f.start();
    assert.deepEqual(f.registrations, commonTools);
    assert.deepEqual(omitDiagnostics(await f.json("sqlite_status")), closedStatus);
    assert.deepEqual(f.notifications, []);
    for (const [name, params] of [
      ["sqlite_query", { sql: "SELECT 1" }],
      ["sqlite_execute", { sql: "CREATE TABLE unexpected (id INTEGER)" }],
      ["sqlite_list_tables", {}],
      ["sqlite_describe_table", { table_name: "unexpected" }],
    ] as const) {
      await assert.rejects(f.call(name, params), (error: unknown) => {
        assert.ok(error instanceof Error);
        assertNoConfigLeak(error.message);
        assert.ok(!error.message.includes(f.configPath));
        assert.ok(error.message.includes(path));
        assert.doesNotMatch(error.message, /Use sqlite_open/);
        return true;
      });
    }
    assert.equal(existsSync(join(f.directory, "must-not-fallback.sqlite")), false);
    const manual = await f.call("sqlite_manual");
    assert.equal(manual.content[0].type, "text");
    const hint = (await f.json("sqlite_status")).hint as string;
    assertNoConfigLeak(hint);
    assert.match(hint, /ask the user/i);
  });
}

test("config errors remain available through tools without a UI", async (t) => {
  const f = fixture(t, { hasUI: false });
  f.config("{broken JSON");
  await f.start();
  assert.deepEqual(f.notifications, []);
  assert.deepEqual(f.registrations, commonTools);
  await assert.rejects(f.call("sqlite_list_tables"), /Invalid SQLite project settings/);
});

test("the manual tool result and registered tool text never name settings files, keys or variables", async (t) => {
  const f = fixture(t);
  await f.start();
  const manual = await f.call("sqlite_manual");
  const content = manual.content[0];
  assert.equal(content.type, "text");
  if (content.type !== "text") return;
  assertNoConfigLeak(content.text);
  for (const tool of f.tools.values()) {
    assertNoConfigLeak([tool.description, tool.promptSnippet, ...(tool.promptGuidelines ?? [])].join("\n"));
  }
});

for (const fixed of [false, true]) {
  test(`duplicate startup pins mode and does not re-register tools (fixed=${fixed})`, async (t) => {
    const f = fixture(t);
    if (fixed) f.config('{"databasePath":"initial.sqlite"}');
    await Promise.all([f.start(), f.start()]);
    if (!fixed) await f.json("sqlite_open", { file_path: "initial.sqlite" });
    // A temporary table would disappear if duplicate startup reopened the connection.
    await f.json("sqlite_execute", { sql: "CREATE TEMP TABLE retained (id INTEGER)" });
    f.config('{"databasePath":"changed.sqlite"}');
    await f.start();
    assert.deepEqual(f.registrations, fixed ? commonTools : manualTools);
    assert.equal((await f.json("sqlite_status")).filePath, join(f.directory, "initial.sqlite"));
    assert.equal((await f.json("sqlite_query", { sql: "SELECT * FROM retained" })).rowCount, 0);
    assert.equal(existsSync(join(f.directory, "changed.sqlite")), false);
  });
}

test("shutdown during async startup prevents a late-opened connection", async (t) => {
  const f = fixture(t);
  f.config('{"databasePath":"must-not-open.sqlite"}');
  const starting = f.start();
  await f.shutdown();
  await starting;
  assert.deepEqual(omitDiagnostics(await f.json("sqlite_status")), closedStatus);
  assert.deepEqual(f.registrations, commonTools);
  assert.equal(existsSync(join(f.directory, "must-not-open.sqlite")), false);
  await assert.rejects(f.call("sqlite_query", { sql: "SELECT 1" }), /shut down/);
});

test("data tools reject calls before initialization has finished", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.call("sqlite_query", { sql: "SELECT 1" }), /not initialized/);
});

test("a config read failure other than ENOENT is not treated as missing configuration", async (t) => {
  const f = fixture(t);
  mkdirSync(f.configPath, { recursive: true }); // readFile on a directory fails on Windows/Linux.
  await f.start();
  assert.deepEqual(f.registrations, commonTools);
  assert.deepEqual(omitDiagnostics(await f.json("sqlite_status")), closedStatus);
  await assert.rejects(f.call("sqlite_query", { sql: "SELECT 1" }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Cannot read the SQLite project settings/);
    assertNoConfigLeak(error.message);
    assert.ok(!error.message.includes(f.configPath));
    return true;
  });
  assert.ok(f.notifications[0].message.includes(f.configPath));
});

test("sqlite_status explains why no database is open", async (t) => {
  const f = fixture(t);
  const before = await f.json("sqlite_status");
  assert.match(before.startupError, /not initialized/);
  await f.start();
  const manual = await f.json("sqlite_status");
  assert.equal(manual.startupError, undefined);
  assert.match(manual.hint, /sqlite_open/);
  assert.match(manual.hint, /ask the user/i);
  assertNoConfigLeak(manual.hint);
});

test("sqlite_status reports a fixed-mode startup error and tells the agent to ask the user", async (t) => {
  const f = fixture(t);
  f.config("{broken JSON");
  await f.start();
  const status = await f.json("sqlite_status");
  assert.equal(status.isOpen, false);
  assert.match(status.startupError, /Invalid SQLite project settings/);
  assertNoConfigLeak(status.startupError);
  assertNoConfigLeak(status.hint);
  assert.ok(!status.startupError.includes(f.configPath));
  assert.ok(f.notifications[0].message.includes(f.configPath));
  assert.match(status.hint, /ask the user/i);
  await assert.rejects(f.call("sqlite_query", { sql: "SELECT 1" }), /ask the user.*reload/is);
});

test("a shut-down session says the tool can no longer be used", async (t) => {
  const f = fixture(t);
  await f.start();
  await f.shutdown();
  await assert.rejects(f.call("sqlite_query", { sql: "SELECT 1" }), /session has ended.*new session/is);
});

test("a non-object bindings value names the received type", async (t) => {
  const f = fixture(t);
  await f.start();
  await f.call("sqlite_open", { file_path: "b.sqlite" });
  await assert.rejects(f.call("sqlite_query", { sql: "SELECT ?", bindings: "x" }), /received string/);
  await assert.rejects(f.call("sqlite_query", { sql: "SELECT ?", bindings: 5 }), /received number/);
});

test("both bindings and params are reported instead of silently ignoring params", async (t) => {
  const f = fixture(t);
  await f.start();
  await f.call("sqlite_open", { file_path: "b.sqlite" });
  await assert.rejects(f.call("sqlite_query", { sql: "SELECT ?", bindings: [1], params: [2] }), /both.*bindings.*params/is);
});

test("a failed manual open names the path and how to fix it", async (t) => {
  const f = fixture(t);
  await f.start();
  const result = await f.json("sqlite_open", { file_path: "missing-dir/x.sqlite" });
  assert.equal(result.success, false);
  assert.ok(result.message.includes(join(f.directory, "missing-dir", "x.sqlite")));
  assert.match(result.message, /file_path/);
});
