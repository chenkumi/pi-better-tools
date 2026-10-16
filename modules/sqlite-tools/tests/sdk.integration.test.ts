import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type AgentSession,
  createAgentSession,
  createToolSearchExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { registerDeferredTools } from "../../pi-runtime/src/deferred-tools.js";

for (const mode of ["search", "fallback", "read-only", "no-tools", "exclude"] as const) {
test(`Pi SQLite deferred discovery and lifecycle: ${mode}`, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-sqlite-sdk-"));
  const cwd = join(directory, "project");
  const agentDir = join(directory, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  const oldPath = process.env.SQLITE_PATH;
  const oldOffline = process.env.PI_OFFLINE;
  delete process.env.SQLITE_PATH;
  process.env.PI_OFFLINE = "1";
  // This test exercises the real SDK registry, never an LLM or remote catalog.
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network request in SQLite SDK test");
  });
  let session: AgentSession | undefined;
  t.after(async () => {
    try {
      if (session) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session?.dispose();
      if (oldPath === undefined) delete process.env.SQLITE_PATH;
      else process.env.SQLITE_PATH = oldPath;
      if (oldOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = oldOffline;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  const settingsManager = SettingsManager.inMemory({ packages: [] }, { projectTrusted: true });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    additionalExtensionPaths: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
    extensionFactories: [...(mode === "fallback" ? [] : [createToolSearchExtension()]), registerDeferredTools],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  // Supply a static catalog model to avoid auth/model selection; never call prompt().
  const model = modelRuntime.getModels()[0];
  assert.ok(model);
  ({ session } = await createAgentSession({
    cwd, agentDir, settingsManager, resourceLoader, modelRuntime, model,
    sessionManager: SessionManager.inMemory(cwd),
    ...(mode === "read-only" ? { tools: ["read"] } : {}),
    ...(mode === "no-tools" ? { noTools: "all" as const } : {}),
    ...(mode === "exclude" ? { excludeTools: ["sqlite_*"] } : {}),
  }));
  const agent = session.agent;
  const errors: unknown[] = [];
  const current = session;
  function assertManualTools(present: boolean, active = present) {
    for (const name of ["sqlite_open", "sqlite_close"]) {
      assert.equal(current.getAllTools().some((tool) => tool.name === name), present, `${name} registered`);
      assert.equal(current.getActiveToolNames().includes(name), active, `${name} active`);
    }
  }
  async function json(name: string, params: Record<string, unknown> = {}) {
    const tool = agent.state.tools.find((tool) => tool.name === name);
    assert.ok(tool, `Missing active tool ${name}`);
    const result = await tool.execute("test", params, undefined);
    const content = result.content[0];
    assert.equal(content.type, "text");
    if (content.type !== "text") throw new Error("Expected text");
    return JSON.parse(content.text);
  }

  assertManualTools(false); // Factory has not exposed switching tools.
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  const hint = async () => {
    const result = await current.extensionRunner.emitBeforeAgentStart(
      { messageType: "user", prompt: "Read SQLite" },
      { cwd, selectedTools: [], skills: [], contextFiles: [], sections: {} },
    );
    return result.systemPromptOptions.sections.pi_better_tools_deferred_tools;
  };
  if (mode !== "search") {
    assert.equal(await hint(), undefined);
    if (mode === "fallback") {
      assertManualTools(true);
      assert.equal((await json("sqlite_open", { file_path: "fallback.sqlite" })).success, true);
      assert.deepEqual((await json("sqlite_query", { sql: "SELECT 1 AS value" })).rows, [[1]]);
    } else {
      assert.ok(!current.getAllTools().some(tool => tool.name.startsWith("sqlite_")));
      assert.ok(!current.getActiveToolNames().some(name => name.startsWith("sqlite_")));
      const search = agent.state.tools.find(tool => tool.name === "tool_search");
      if (search) {
        const result = await search.execute("excluded-sqlite", { query: "sqlite" }, undefined);
        assert.match(JSON.stringify(result.content), /No matching tools/);
      }
    }
    assert.deepEqual(errors, []);
    assert.equal(fetchMock.mock.callCount(), 0);
    return;
  }
  assertManualTools(true, false);
  assert.match((await hint()) ?? "", /read SQLite.*tool_search.*query "sqlite"/);
  async function loadSqlite() {
    const search = agent.state.tools.find(tool => tool.name === "tool_search");
    assert.ok(search, "Pi Runtime activates tool_search");
    const result = await search.execute("search-sqlite", { query: "sqlite" }, undefined);
    assert.notEqual(result.isError, true);
    for (const tool of current.getAllTools().filter(tool => tool.name.startsWith("sqlite_"))) {
      assert.equal(tool.exposure, "deferred", tool.name);
      assert.equal(tool.namespace?.name, "sqlite", tool.name);
      assert.ok(current.getActiveToolNames().includes(tool.name), tool.name);
    }
    assert.equal(await hint(), undefined, "loaded namespace no longer needs a hint");
  }
  await loadSqlite();
  assertManualTools(true);
  assert.equal((await json("sqlite_open", { file_path: "manual.sqlite" })).success, true);
  assert.equal((await json("sqlite_status")).filePath, join(cwd, "manual.sqlite"));

  const configDirectory = join(cwd, ".pi", "agent");
  const configPath = join(configDirectory, "sqlite.json");
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(configPath, '{"databasePath":"fixed.sqlite"}');
  const oldManualStatus = session.getToolDefinition("sqlite_status")!;
  const oldManualContext = session.extensionRunner.createToolContext("cleanup-probe", undefined);
  await session.reload();
  assertManualTools(false);
  await loadSqlite();
  assert.equal((await json("sqlite_status")).filePath, join(cwd, "fixed.sqlite"));
  assert.deepEqual((await json("sqlite_query", { sql: "SELECT 7 AS value" })).rows, [[7]]);
  // Call the raw old status closure (not its invalidated runner wrapper) to inspect cleanup.
  const oldManualResult = await oldManualStatus.execute("test", {}, undefined, undefined, oldManualContext);
  assert.ok(oldManualResult.content[0].type === "text");
  assert.equal(JSON.parse(oldManualResult.content[0].text).isOpen, false);

  const oldFixedStatus = session.getToolDefinition("sqlite_status")!;
  const oldFixedContext = session.extensionRunner.createToolContext("cleanup-probe", undefined);
  rmSync(configPath);
  await session.reload();
  await loadSqlite();
  assertManualTools(true);
  assert.equal((await json("sqlite_status")).isOpen, false);
  const oldFixedResult = await oldFixedStatus.execute("test", {}, undefined, undefined, oldFixedContext);
  assert.ok(oldFixedResult.content[0].type === "text");
  assert.equal(JSON.parse(oldFixedResult.content[0].text).isOpen, false);
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  assert.deepEqual(errors, []);
  assert.equal(fetchMock.mock.callCount(), 0);
});
}
