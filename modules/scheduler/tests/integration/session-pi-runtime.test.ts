import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RegistryStore } from "../../src/registry-store.js";
import { RunStore } from "../../src/run-store.js";
import { SessionScheduler } from "../../src/session-scheduler.js";

// Expected version comes from the integration baseline, not the SDK under test.
const expectedPiVersion = JSON.parse(await readFile(new URL("../../../../package.json", import.meta.url), "utf8")).devDependencies["@earendil-works/pi-coding-agent"] as string;
// Load Pi only after isolating its global configuration. No real credentials or network.
let root: string;
let ca: typeof import("@earendil-works/pi-coding-agent");
let ai: typeof import("@earendil-works/pi-ai");
const cleanups: Array<() => Promise<void>> = [];
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-scheduler-real-sdk-"));
  for (const key of Object.keys(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|^PI_/i.test(key)) vi.stubEnv(key, "");
  for (const key of ["HOME", "USERPROFILE", "APPDATA"]) vi.stubEnv(key, root);
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubEnv("PI_SKIP_VERSION_CHECK", "1");
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  vi.stubEnv("PI_AGENT_DIR", root);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Network forbidden in scheduler regression tests"); }));
  ca = await import("@earendil-works/pi-coding-agent");
  ai = await import("@earendil-works/pi-ai");
  expect(ca.VERSION).toBe(expectedPiVersion);
}, 30_000);
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
afterAll(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

interface Options { error?: boolean; handled?: boolean; noAuth?: boolean; preflightGate?: boolean; inputGate?: boolean; admissionTimeoutMs?: number; modelOnly?: boolean; clamp?: boolean; transform?: boolean; modelGate?: boolean }
function model(id: string, reasoning = true, provider = "scheduler-offline", api = "scheduler-test") {
  return { id, name: id, api, provider, baseUrl: "http://unused.invalid", reasoning,
    input: ["text"], contextWindow: 128_000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}
let caseNumber = 0;
async function fixture(options: Options = {}) {
  // Provider API registrations are process-wide; never reuse another case's binding.
  const provider = `scheduler-offline-${++caseNumber}`, api = `scheduler-test-${caseNumber}`;
  const makeModel = (id: string, reasoning = true) => model(id, reasoning, provider, api);
  const directory = await mkdtemp(join(root, "case-"));
  const registry = new RegistryStore({ registryPath: join(directory, "registry.json"), lockPath: join(directory, "lock") });
  const runs = new RunStore({ runsPath: join(directory, "runs.jsonl"), lockPath: join(directory, "lock"), logsDir: join(directory, "logs") });
  let scheduler!: SessionScheduler;
  let ctx!: import("@earendil-works/pi-coding-agent").ExtensionContext;
  let calls = 0, settles = 0;
  let release: (() => void) | undefined;
  const errors: string[] = [];
  const settings = ca.SettingsManager.inMemory({ defaultThinkingLevel: "medium", retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off", enableInstallTelemetry: false });
  const loader = new ca.DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    systemPrompt: "Deterministic offline scheduler regression fixture.", extensionFactories: [(pi) => {
      pi.registerProvider(provider, { api, baseUrl: "http://unused.invalid",
        ...(!options.noAuth ? { apiKey: "offline-non-secret" } : {}), models: [makeModel("old"), makeModel("target", !options.clamp)] as never,
        streamSimple(m) {
          calls++;
          const stream = ai.createAssistantMessageEventStream();
          queueMicrotask(() => {
            const message = { role: "assistant", api: m.api, provider: m.provider, model: m.id, timestamp: Date.now(),
              content: options.error ? [] : [{ type: "text", text: "OFFLINE_OK" }], stopReason: options.error ? "error" : "stop",
              ...(options.error ? { errorMessage: "deterministic provider failure" } : {}),
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as import("@earendil-works/pi-ai").AssistantMessage;
            if (options.error) stream.push({ type: "error", reason: "error", error: message });
            else { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); }
            stream.end();
          });
          return stream;
        },
      });
      if (options.handled) pi.on("input", (event) => event.source === "extension" ? { action: "handled" } : undefined);
      if (options.inputGate) pi.on("input", (event) => event.source === "extension" ? new Promise<void>((resolve) => { release = resolve; }) : undefined);
      if (options.preflightGate) pi.on("before_agent_start", () => new Promise<void>((resolve) => { release = resolve; }));
      pi.on("session_start", async (_event, context) => {
        ctx = context;
        scheduler = new SessionScheduler({ registry, runs, pi, admissionTimeoutMs: options.admissionTimeoutMs ?? 10_000 } as never);
        await scheduler.start(ctx);
      });
      // Optional calls let the original implementation run these same defect assertions.
      pi.on("input", (event, context) => scheduler.handleInput(event, context));
      pi.on("before_agent_start", (event, context) => scheduler.beforeAgentStart?.(event, context));
      pi.on("message_start", (event, context) => scheduler.messageStarted?.(event, context));
      pi.on("message_end", (event) => scheduler.messageEnded?.(event));
      pi.on("agent_end", (event) => scheduler.agentEnded?.(event));
      pi.on("agent_settled", async () => { await scheduler.settled(); settles++; });
      pi.on("model_select", (event) => scheduler.onModelChanged(event.model));
      pi.on("thinking_level_select", (event) => scheduler.onThinkingChanged(event.level));
      pi.on("session_shutdown", () => scheduler.shutdown());
      if (options.transform) pi.on("input", (event) => ({ action: "transform", text: `Wrapper\n${event.text}\nEnd wrapper` }));
      if (options.modelGate) pi.on("model_select", (event) => event.model.id === "target" ? new Promise<void>((resolve) => { release = resolve; }) : undefined);
    }] });
  await loader.reload();
  const { session } = await ca.createAgentSession({ cwd: directory, agentDir: directory, model: makeModel("old") as never,
    thinkingLevel: "high", resourceLoader: loader, settingsManager: settings, sessionManager: ca.SessionManager.inMemory(directory), tools: [] });
  await session.bindExtensions({ mode: "json", onError: (event) => errors.push(event.error) });
  cleanups.push(async () => { release?.(); await session.abort(); await scheduler.shutdown(); session.dispose(); });
  const schedule = await registry.create({ mode: "session", targetSessionId: ctx.sessionManager.getSessionId(), cwd: directory, prompt: "OFFLINE_WORK",
    timing: { kind: "once", expression: "2030-01-01T00:00:00Z", timezone: "UTC" },
    ...(options.modelOnly || options.clamp ? { execution: { provider, model: "target", ...(options.clamp ? { thinkingLevel: "high" as const } : {}) } } : {}) });
  return { get scheduler() { return scheduler; }, runs, registry, schedule, session, errors, calls: () => calls, settles: () => settles, release: () => release?.(), gated: () => !!release };
}
async function terminal(f: Awaited<ReturnType<typeof fixture>>) {
  try {
    await vi.waitFor(async () => {
      expect((await f.runs.list())[0]?.endedAt).toBeTruthy();
      // A committed history row can become visible before post-commit log cleanup
      // and release of in-memory ownership. Require both completion boundaries.
      expect(f.scheduler.profileOwnershipActive).toBe(false);
    }, { timeout: 10_000, interval: 10 });
  }
  catch (error) {
    throw new Error(`Terminal wait failed: ${JSON.stringify({ runs: await f.runs.list(), errors: f.errors, calls: f.calls(), settles: f.settles(), streaming: f.session.isStreaming, schedulerError: f.scheduler.lastError })}`, { cause: error });
  }
  return (await f.runs.list())[0]!;
}

describe(`real Pi ${expectedPiVersion} offline SDK regression`, () => {
  it("fences a retired instance's preflight after a real SDK reload", async () => {
    const f = await fixture({ preflightGate: true }); await f.scheduler.dispatch(f.schedule);
    await vi.waitFor(() => expect(f.gated()).toBe(true)); const old = f.scheduler;
    await f.session.reload(); expect(f.scheduler).not.toBe(old); f.release();
    await vi.waitFor(() => expect(f.settles()).toBeGreaterThan(0), { timeout: 10_000 });
    expect((await terminal(f)).status).toBe("cancelled"); expect(f.calls()).toBe(0);
  });
  it("keeps correlation through an input transformer registered after the guard", async () => {
    const f = await fixture({ transform: true, modelOnly: true }); await f.scheduler.dispatch(f.schedule);
    expect((await terminal(f)).status).toBe("succeeded"); expect(f.calls()).toBe(1);
    expect(f.session.model?.id).toBe("old"); expect(f.session.thinkingLevel).toBe("high");
  });
  it("cancels a wrapped prompt's preflight without invoking the provider", async () => {
    const f = await fixture({ transform: true, preflightGate: true }); const run = await f.scheduler.dispatch(f.schedule);
    await vi.waitFor(() => expect(f.gated()).toBe(true)); await f.scheduler.cancelActiveRun(run.runId); f.release();
    await vi.waitFor(() => expect(f.settles()).toBeGreaterThan(0), { timeout: 10_000 }); expect(f.calls()).toBe(0);
  });
  it("preserves a real thinking change during an asynchronous model-select gate", async () => {
    const f = await fixture({ modelOnly: true, modelGate: true }); const dispatched = f.scheduler.dispatch(f.schedule);
    await vi.waitFor(() => expect(f.gated()).toBe(true)); f.session.setThinkingLevel("low"); f.release();
    expect((await dispatched).status).toBe("skipped_busy"); expect(f.session.thinkingLevel).toBe("low"); expect(f.calls()).toBe(0);
    expect((await terminal(f)).events.some((event) => event.type === "restore_skipped_user_change")).toBe(true);
  });
  it("aborts before provider dispatch if recording the running boundary fails", async () => {
    const f = await fixture(); vi.spyOn(f.runs, "startQueued").mockRejectedValueOnce(new Error("injected running IO failure"));
    await f.scheduler.dispatch(f.schedule); const run = await terminal(f);
    expect(run.status).toBe("failed"); expect(run.error).toMatch(/running IO failure/); expect(f.calls()).toBe(0);
  });
  it("records terminal assistant errors as failed, not succeeded (BUG-001)", async () => {
    const f = await fixture({ error: true }); await f.scheduler.dispatch(f.schedule);
    expect((await terminal(f)).status).toBe("failed"); expect(f.calls()).toBe(1);
  });
  it("releases an input handled by another extension without claiming it ran (BUG-002)", async () => {
    const f = await fixture({ handled: true, admissionTimeoutMs: 80 }); await f.scheduler.dispatch(f.schedule);
    const run = await terminal(f);
    expect(run.status).toBe("failed_preflight"); expect(run.startedAt).toBeUndefined();
    expect(f.calls()).toBe(0); expect(f.scheduler.profileOwnershipActive).toBe(false);
    expect(run.error).toMatch(/admission/i);
  });
  it("releases an asynchronous authentication rejection (BUG-002)", async () => {
    const f = await fixture({ noAuth: true, admissionTimeoutMs: 80 }); await f.scheduler.dispatch(f.schedule);
    expect((await terminal(f)).status).toBe("failed_preflight"); expect(f.calls()).toBe(0);
    expect(f.scheduler.profileOwnershipActive).toBe(false); expect(f.errors.length).toBeGreaterThan(0);
  });
  it("restores implicit thinking changes after a model-only profile (BUG-003)", async () => {
    const f = await fixture({ modelOnly: true }); await f.scheduler.dispatch(f.schedule);
    expect((await terminal(f)).status).toBe("succeeded");
    expect(f.session.model?.id).toBe("old"); expect(f.session.thinkingLevel).toBe("high");
  });
  it("does not invoke the provider after cancellation in Pi before_agent_start (BUG-004)", async () => {
    const f = await fixture({ preflightGate: true }); const submitted = await f.scheduler.dispatch(f.schedule);
    await vi.waitFor(() => expect(f.gated()).toBe(true)); expect(f.calls()).toBe(0);
    await f.scheduler.cancelActiveRun(submitted.runId); f.release();
    await vi.waitFor(() => expect(f.settles()).toBeGreaterThan(0), { timeout: 10_000 });
    expect((await terminal(f)).status).toBe("cancelled"); expect(f.calls()).toBe(0);
  });
  it("rejects a prompt returning late from an input handler after cancellation", async () => {
    const f = await fixture({ inputGate: true }); const submitted = await f.scheduler.dispatch(f.schedule);
    await vi.waitFor(() => expect(f.gated()).toBe(true));
    await f.scheduler.cancelActiveRun(submitted.runId); f.release();
    expect((await terminal(f)).status).toBe("cancelled");
    await new Promise((resolve) => setTimeout(resolve, 100)); expect(f.calls()).toBe(0);
  });
  it("fences a late preflight after the admission deadline instead of replaying it", async () => {
    const f = await fixture({ preflightGate: true, admissionTimeoutMs: 80 }); await f.scheduler.dispatch(f.schedule);
    await vi.waitFor(() => expect(f.gated()).toBe(true)); expect((await terminal(f)).status).toBe("failed_preflight");
    f.release(); await vi.waitFor(() => expect(f.settles()).toBeGreaterThan(0), { timeout: 10_000 });
    expect(f.calls()).toBe(0); expect(f.scheduler.profileOwnershipActive).toBe(false);
  });
  it("captures clamped effective thinking without mistaking its self-event for a user change (RISK-003)", async () => {
    const f = await fixture({ clamp: true }); await f.scheduler.dispatch(f.schedule); const run = await terminal(f);
    expect(run.status).toBe("succeeded"); expect(run.effectiveProfile?.thinkingLevel).toBe("off");
    expect(run.events.some((event) => event.type === "restore_skipped_user_change")).toBe(false);
    expect(f.session.thinkingLevel).toBe("high"); expect(f.session.model?.id).toBe("old");
  });
});
