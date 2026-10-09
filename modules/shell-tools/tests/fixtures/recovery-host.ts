import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as sdk from "@earendil-works/pi-coding-agent";
import { BackgroundRecovery, RECOVERY_NOTICE, recoveryCwd } from "../../src/recovery.ts";
import { ShellJobs } from "../../src/background-jobs.ts";
import { BackgroundJobs } from "../../../subagents/extensions/subagent/background.ts";

const mode = process.argv[2], file = process.argv[3];
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const home = homedir(), agentDir = join(home, ".pi/agent"), cwd = join(home, "workspace");
await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true });
assert.equal(resolve(process.env.PI_CODING_AGENT_DIR!), resolve(agentDir)); assert.equal(sdk.VERSION, "1.1.0");
await writeFile(join(agentDir, "auth.json"), "{}");
globalThis.fetch = async () => { throw new Error("Network forbidden in recovery fixture"); };
let api!: sdk.ExtensionAPI, ctx!: sdk.ExtensionContext, calls = 0;
const errors: string[] = [], starts: string[] = [];
const model: any = { id: "offline-recovery", name: "Offline", provider: "recovery-fixture", api: "openai-completions", baseUrl: "https://unused.invalid",
  reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 32, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const settingsManager = sdk.SettingsManager.inMemory({ defaultTools: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off", enableInstallTelemetry: false, defaultProjectTrust: "never" });
const resourceLoaderOptions: any = { noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
  additionalExtensionPaths: [join(root, "modules/shell-tools/src/index.ts"), join(root, "modules/subagents/src/index.ts")],
  extensionFactories: [(pi: sdk.ExtensionAPI) => {
    api = pi;
    pi.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: "offline-not-secret", models: [model], streamSimple() { calls++; throw new Error("Provider must never be called"); } });
    pi.on("session_start", (e, context) => { ctx = context; starts.push(e.reason); });
  }] };
const manager = file ? sdk.SessionManager.open(file) : mode === "no-session" ? sdk.SessionManager.inMemory(cwd) : sdk.SessionManager.create(cwd, join(home, "sessions"));
if (!file && mode !== "empty") manager.appendMessage({ role: "user", content: "Isolated recovery fixture", timestamp: Date.now() });
const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
const runtime = await sdk.createAgentSessionRuntime(async options => {
  const services = await sdk.createAgentSessionServices({ cwd: options.cwd, agentDir, settingsManager, modelRuntime, resourceLoaderOptions });
  assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
  return { ...(await sdk.createAgentSessionFromServices({ services, sessionManager: options.sessionManager, sessionStartEvent: options.sessionStartEvent, model, noTools: "all" })), services, diagnostics: services.diagnostics };
}, { cwd, agentDir, sessionManager: manager });
const session = runtime.session;
let shell: ShellJobs | undefined, jobs: BackgroundJobs | undefined, recovery: BackgroundRecovery | undefined;
const heartbeat = setInterval(() => console.error("[recovery-host] Isolated lifecycle verification still running..."), 10000);
try {
  await session.bindExtensions({ mode: "json", onError: event => errors.push(event.error) });
  assert.deepEqual(session.getActiveToolNames(), [], "recovery must not activate tools");
  if (mode === "crash" || mode === "quit") {
    // Deterministic held runners have no external child/process tree to orphan when the fixture is killed.
    // Real shell/child abort remains covered by each module's existing integration tests.
    shell = new ShellJobs(api); shell.start(ctx);
    recovery = new BackgroundRecovery(api, "subagent"); recovery.bind(ctx);
    jobs = new BackgroundJobs(kind => { if (kind === "task_result") throw new Error("shutdown must suppress completion"); }, undefined, undefined, undefined, (owner, c, snapshot) => recovery!.accept(snapshot, { owner, cwd: c }));
    let resolveShell!: () => void, resolveSub!: () => void;
    const shellStarted = new Promise<void>(r => resolveShell = r), subStarted = new Promise<void>(r => resolveSub = r);
    shell.submit(ctx, "bash", "FIXTURE_SHELL", undefined, async signal => {
      resolveShell(); await new Promise<void>(r => signal.addEventListener("abort", () => r(), { once: true })); throw new Error("Command aborted");
    });
    await jobs.submitManaged(manager.getSessionId(), recoveryCwd(cwd), jobs.epoch, ["worker"], async () => ["FIXTURE_CHILD"], async (signal, _ids, live, finish) => {
      live(0, "FIXTURE_CHILD", "/fixture/log.partial"); resolveSub();
      await new Promise<void>(r => signal.addEventListener("abort", () => r(), { once: true })); finish(0, { exitCode: 1 }, "aborted");
    });
    await Promise.all([shellStarted, subStarted]);
    if (mode === "crash") {
      process.send?.({ phase: "ready", file: manager.getSessionFile() });
      // Keep this isolated host alive until the parent sends SIGKILL; no fixed sleep assertion.
      await new Promise<void>(() => {});
    } else {
      api.on("session_shutdown", async event => {
        await shell!.shutdown(event.reason); recovery!.shutdown(event.reason);
        try { await jobs!.shutdown(); } finally { recovery!.close(); }
      });
      await runtime.dispose();
      console.log(JSON.stringify({ status: "passed", phase: "quit", file: manager.getSessionFile(), providerCalls: calls }));
    }
  } else if (mode === "empty" || mode === "no-session") {
    shell = new ShellJobs(api); shell.start(ctx);
    recovery = new BackgroundRecovery(api, "subagent"); recovery.bind(ctx);
    jobs = new BackgroundJobs(() => {}, undefined, undefined, undefined, (owner, c, s) => recovery!.accept(s, { owner, cwd: c }));
    let runs = 0, prepares = 0;
    assert.throws(() => shell!.submit(ctx, "bash", "FIXTURE", undefined, async () => { runs++; return {} as any; }), /BACKGROUND_JOURNAL_FAILED/);
    await assert.rejects(jobs.submitManaged(manager.getSessionId(), recoveryCwd(cwd), jobs.epoch, ["worker"], async () => { prepares++; return ["CHILD"]; }, async () => { runs++; }), /BACKGROUND_JOURNAL_FAILED/);
    assert.equal(runs, 0); assert.equal(prepares, 0); assert.equal(calls, 0); assert.deepEqual(errors, []);
    assert.equal(manager.getEntries().some((e: any) => e.customType === "pi-better-tools-background-state"), false);
    console.log(JSON.stringify({ status: "passed", phase: mode, providerCalls: calls, runs, prepares }));
  } else if (mode === "load") {
    const noticeTypes = [`${RECOVERY_NOTICE}-shell`, `${RECOVERY_NOTICE}-subagent`];
    const notices = () => manager.buildContextEntries().filter((e: any) => e.type === "custom_message" && noticeTypes.includes(e.customType)) as any[];
    assert.equal(notices().length, 2); assert.equal(starts[0], "startup");
    const findings = notices().map(n => n.details.jobs[0]);
    assert.ok(findings.every(f => f.processTreeState === "unknown"));
    assert.equal(session.messages.filter((m: any) => m.role === "custom" && noticeTypes.includes(m.customType)).length, 2);
    const before = notices().length;
    await session.reload(); assert.equal(notices().length, before, "reload must not duplicate same branch evidence");
    const kept = manager.appendMessage({ role: "user", content: "Keep after isolated compaction", timestamp: Date.now() });
    manager.appendCompaction("Isolated compaction; no lifecycle conclusions inferred from this summary", kept, 100);
    assert.equal(notices().length, 0, "old notices are outside model context after compaction");
    await session.reload(); assert.equal(notices().length, 2, "compaction requires fresh model-visible recovery evidence");
    assert.equal(session.messages.filter((m: any) => m.role === "custom" && noticeTypes.includes(m.customType)).length, 2);
    await session.reload(); assert.equal(notices().length, 2, "fresh compaction notices dedup on reload");
    // Actual runtime session replacement also emits resume; rebind services only in isolated dirs.
    runtime.setRebindSession(async next => { await next.bindExtensions({ mode: "json", onError: e => errors.push(e.error) }); });
    await runtime.newSession(); assert.equal(runtime.session.messages.some((m: any) => m.customType?.startsWith(RECOVERY_NOTICE)), false);
    await runtime.switchSession(file); assert.equal(starts.at(-1), "resume");
    const rows = (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(rows.filter(e => e.type === "custom_message" && noticeTypes.includes(e.customType)).length, 4);
    assert.equal(calls, 0); assert.deepEqual(errors, []); assert.deepEqual(runtime.session.getActiveToolNames(), []);
    console.log(JSON.stringify({ status: "passed", phase: "load", providerCalls: calls, starts, findings, notices: 2, compaction: true, persistedNotices: 4, role: "custom" }));
  } else throw new Error("Unknown recovery fixture mode");
} finally {
  clearInterval(heartbeat);
  if (mode !== "crash") { await shell?.shutdown(); await jobs?.shutdown(); recovery?.close(); await runtime.dispose(); }
}
