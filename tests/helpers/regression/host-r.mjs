// Shared helper for the R03/R05 defect-repro tests: a REAL Pi 1.1.0 host (createAgentSession + DefaultResourceLoader)
// with isolated HOME/agentDir/workspace and an offline scripted fake provider (no network, no credentials).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from '../environment.mjs';

export const repoRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
export const emptyUsage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

export async function makeSandbox(prefix) {
  const home = await mkdtemp(join(tmpdir(), `${prefix}-`));
  Object.assign(process.env, isolatedEnv(home)); // HOME/USERPROFILE/APPDATA/PI_CODING_AGENT_DIR all point into the sandbox
  const agentDir = join(home, '.pi/agent'), cwd = join(home, 'workspace');
  await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true });
  await writeFile(join(agentDir, 'auth.json'), '{}');
  return { home, agentDir, cwd, cleanup: () => rm(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }) };
}

/**
 * opts: { sandbox, extensionPaths (repo-relative), factories: [(pi)=>void], settings, model, tools,
 *         providers: [{ name, api, models, script(nth, model, context) => content[] | undefined }],
 *         virtualModels: [(pi)=>definition] }
 * Every provider call runs options.onPayload (== before_provider_request hooks), like a real provider does.
 */
export async function startHost(opts) {
  const sdk = await import('@earendil-works/pi-coding-agent');
  const ai = await import('@earendil-works/pi-ai');
  const { agentDir, cwd } = opts.sandbox;
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off',
    enableInstallTelemetry: false, defaultProjectTrust: 'never', ...(opts.settings ?? {}) }));
  const settingsManager = await sdk.SettingsManager.create(cwd, agentDir);
  const calls = [];
  const providerFactory = (pi) => {
    for (const p of opts.providers ?? []) pi.registerProvider(p.name, { api: p.api, baseUrl: 'http://unused.invalid', apiKey: 'offline-non-secret', models: p.models,
      streamSimple(model, context, streamOptions) {
        const stream = ai.createAssistantMessageEventStream();
        const nth = calls.length + 1; calls.push({ nth, model: `${model.provider}/${model.id}` });
        setImmediate(async () => {
          const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [], stopReason: 'stop', timestamp: Date.now(), usage: emptyUsage };
          try {
            const sent = await streamOptions?.onPayload?.({ model: model.id, input: [], stream: true }, model);
            calls[nth - 1].payloadAfterHooks = sent;
            const content = p.script?.(nth, model, context) ?? [{ type: 'text', text: 'DONE' }];
            message.content = content;
            if (content.some((b) => b.type === 'toolCall')) message.stopReason = 'toolUse';
            stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason, message });
          } catch (error) { message.stopReason = 'error'; message.errorMessage = String(error); stream.push({ type: 'error', reason: 'error', error: message }); }
          finally { stream.end(); }
        });
        return stream;
      } });
    for (const make of opts.virtualModels ?? []) pi.registerVirtualModel(make(pi));
  };
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager,
    additionalExtensionPaths: (opts.extensionPaths ?? []).map((p) => join(repoRoot, p)),
    extensionFactories: [providerFactory, ...(opts.factories ?? [])], noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
  await loader.reload();
  const loadErrors = loader.getExtensions().errors;
  if (loadErrors.length) throw new Error(`extension load errors: ${JSON.stringify(loadErrors)}`);
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const { session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, sessionManager: sdk.SessionManager.inMemory(cwd), resourceLoader: loader, modelRuntime,
    model: opts.select ? physicalModel(opts, opts.select) : opts.model, ...(opts.tools ? { tools: opts.tools } : {}) });
  const errors = [];
  await session.bindExtensions({ mode: 'json', onError: (event) => errors.push(event.error) });
  return { session, calls, errors, sdk, loader,
    async close() { try { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); } finally { session.dispose(); } } };
}

export function physicalModel(opts, [provider, id]) {
  const p = opts.providers.find((x) => x.name === provider);
  return { ...p.models.find((m) => m.id === id), provider, api: p.api, baseUrl: 'http://unused.invalid' };
}

/** Condition poll (not a fixed sleep); returns false on timeout. */
export async function waitFor(predicate, timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}
