import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = fileURLToPath(new URL("../../", import.meta.url));
const envKeys = [
  "PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_TELEMETRY",
  "PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL",
  "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE",
];

// Real loader + session + shell backend; no prompts or external model requests.
// Callers must run serially because Pi reads process-wide environment variables.
export async function createPiFixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shell-test-"));
  const agentDir = path.join(temp, "agent");
  const outputDir = path.join(temp, "outputs");
  const homeDir = path.join(temp, "home");
  fs.mkdirSync(agentDir);
  fs.mkdirSync(outputDir);
  fs.mkdirSync(homeDir);
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  // The logger intentionally uses ~/.pi, not the SDK's agentDir. Isolate home
  // too, so existing failure tests never read/write the real user's settings/logs.
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  process.env.PI_TELEMETRY = "0";
  // Capture even output files created immediately before an executor throws,
  // when no final result (and possibly no update) exposes their paths.
  for (const key of ["TEMP", "TMP", "TMPDIR"]) process.env[key] = outputDir;
  const sessions = new Set();
  const outputFiles = new Set();
  let sequence = 0;
  let sdk;
  let modelRuntime;
  let model;

  function disposeSessions() {
    const errors = [];
    for (const session of sessions) {
      try { session.dispose(); } catch (error) { errors.push(error); }
    }
    sessions.clear();
    if (errors.length) throw new AggregateError(errors, "Session cleanup failed");
  }

  function cleanup() {
    const errors = [];
    try { disposeSessions(); } catch (error) { errors.push(error); }
    for (const outputFile of outputFiles) {
      try { fs.rmSync(outputFile, { force: true }); } catch (error) { errors.push(error); }
    }
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Fixture cleanup failed");
    assert.equal(fs.existsSync(temp), false, "isolated settings/workspaces must be removed");
    for (const outputFile of outputFiles) assert.equal(fs.existsSync(outputFile), false);
    for (const [key, value] of previousEnv) assert.equal(process.env[key], value);
  }

  function writeGlobalSettings(settings = {}, targetAgentDir = agentDir) {
    fs.mkdirSync(targetAgentDir, { recursive: true });
    fs.writeFileSync(path.join(targetAgentDir, "settings.json"), JSON.stringify(settings));
  }

  function writeDebugSettings(settings = {}) {
    const directory = path.join(homeDir, ".pi", "agent");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "settings.json"), JSON.stringify(settings));
  }

  async function createSession({
    loadOverride = true, defaultTools, tools, excludeTools, noTools,
    settings = {}, disk = false, globalSettings = {}, projectSettings,
    trusted = false, codemode = false, persistentSession = false, agentDir: sessionAgentDir = agentDir,
  } = {}) {
    const cwd = path.join(temp, `workspace-${++sequence}`);
    fs.mkdirSync(cwd);
    writeGlobalSettings(globalSettings, sessionAgentDir);
    if (projectSettings !== undefined) {
      fs.mkdirSync(path.join(cwd, ".pi"));
      fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify(projectSettings));
    }
    const overrides = {
      compaction: { enabled: false }, retry: { enabled: false }, ...settings,
      ...(defaultTools === undefined ? {} : { defaultTools }),
    };
    const settingsManager = disk
      ? sdk.SettingsManager.create(cwd, sessionAgentDir, { projectTrusted: trusted })
      : sdk.SettingsManager.inMemory(overrides, { projectTrusted: trusted });
    if (disk) settingsManager.applyOverrides(overrides);
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd, agentDir: sessionAgentDir, settingsManager,
      additionalExtensionPaths: loadOverride ? [projectDir] : [],
      extensionFactories: codemode ? [sdk.createCodemodeExtension({ models: false })] : [],
      noExtensions: true, noSkills: true, noPromptTemplates: true,
      noThemes: true, noContextFiles: true,
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, [], "Pi package loader errors");
    const { session } = await sdk.createAgentSession({
      cwd, agentDir: sessionAgentDir, settingsManager, resourceLoader, modelRuntime, model,
      sessionManager: persistentSession ? sdk.SessionManager.create(cwd, path.join(temp, "sessions")) : sdk.SessionManager.inMemory(cwd), thinkingLevel: "off",
      ...(tools === undefined ? {} : { tools }),
      ...(excludeTools === undefined ? {} : { excludeTools }),
      ...(noTools === undefined ? {} : { noTools }),
    });
    sessions.add(session);
    await session.bindExtensions({});
    return { session, settingsManager, resourceLoader, cwd };
  }

  function trackOutputFiles(result) {
    for (const outputFile of [result.details?.fullOutputPath, result.structuredContent?.full_output_path]) {
      if (outputFile) outputFiles.add(outputFile);
    }
  }

  async function execute(session, name, input, { signal, onUpdate } = {}) {
    const tool = session.agent.state.tools.find((tool) => tool.name === name);
    assert.ok(tool, `active tool ${name}`);
    // A bounded watchdog prevents a timeout/abort regression from hanging CI.
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const watchdog = setTimeout(abort, 15_000);
    try {
      const toolCallId = `test-${++sequence}`;
      if (name === "codemode") {
        // Real nested calls need an issuing assistant message. This canonical
        // synthetic message is not a provider request or a private-state edit.
        session.sessionManager.appendMessage({
          role: "assistant", api: "test-api", provider: "test-provider", model: "test-model",
          content: [{ type: "toolCall", id: toolCallId, name, arguments: input }],
          usage: {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse", timestamp: Date.now(),
        });
        session.refreshContext();
      }
      const result = await tool.execute(toolCallId, input, controller.signal, (update) => {
        trackOutputFiles(update);
        onUpdate?.(update);
      });
      trackOutputFiles(result);
      return result;
    } finally {
      clearTimeout(watchdog);
      signal?.removeEventListener("abort", abort);
    }
  }

  try {
    assert.equal(path.resolve(os.homedir()), path.resolve(homeDir), "home must be isolated before any tool loads");
    console.log("Loading Pi SDK with isolated settings and network-disabled model discovery...");
    sdk = await import("@earendil-works/pi-coding-agent");
    sdk.initTheme("dark", false);
    modelRuntime = await sdk.ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"), modelsPath: null,
      allowModelNetwork: false, refreshOnCreate: false,
    });
    const template = modelRuntime.getModels()[0];
    assert.ok(template, "offline model catalog");
    model = { ...template, id: "test-model", provider: "test-provider", name: "Offline Test Model" };
    writeGlobalSettings();
    return { sdk, temp, agentDir, outputDir, homeDir, createSession, execute, writeGlobalSettings, writeDebugSettings, disposeSessions, cleanup };
  } catch (error) {
    try { cleanup(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Fixture initialization and cleanup failed");
    }
    throw error;
  }
}

export function text(result) {
  return result.content.filter((part) => part.type === "text")
    .map((part) => part.text).join("\n").replace(/\r/g, "");
}

export function render(definition, args, cwd = process.cwd()) {
  const component = definition.renderCall(args, undefined, {
    args, toolCallId: "render-test", invalidate() {}, lastComponent: undefined,
    state: {}, cwd, executionStarted: false, argsComplete: false,
    isPartial: true, expanded: false, showImages: false, isError: false,
  });
  return component.render(200).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}
