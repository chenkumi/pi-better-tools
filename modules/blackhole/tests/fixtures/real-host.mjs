// Shared offline real-Pi-1.1.0 host for Blackhole defect reproductions. No provider/network calls.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from '../../../../tests/helpers/environment.mjs';

export const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
export const blackholeEntry = join(root, 'modules/blackhole/src/index.ts');
export const log = message => console.error(`[defect-repro] ${message}`);

/** Reject if the promise does not settle within ms (barrier-based hang detection, not a sleep). */
export function withLimit(promise, ms, label) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`HANG: ${label} did not settle within ${ms}ms`)), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

export async function makeHost({ globalSettings = {}, projectTrusted = true, extensionFactories = [], withBlackhole = true,
  globalBlackholeConfig, files = {}, summarize, streamSimple, env = {} } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'bh-defect-'));
  const saved = { ...process.env };
  Object.assign(process.env, isolatedEnv(home), env);
  const agentDir = join(home, '.pi/agent'), cwd = join(home, 'workspace');
  await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true });
  await writeFile(join(agentDir, 'auth.json'), '{}');
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ retry: { enabled: false }, cacheWarming: 'off', enableInstallTelemetry: false, ...globalSettings }));
  if (globalBlackholeConfig !== undefined) {
    await mkdir(join(agentDir, 'pi-blackhole'), { recursive: true });
    await writeFile(join(agentDir, 'pi-blackhole/pi-blackhole-config.json'), typeof globalBlackholeConfig === 'string' ? globalBlackholeConfig : JSON.stringify(globalBlackholeConfig));
  }
  for (const [rel, content] of Object.entries(files)) { const p = join(cwd, rel); await mkdir(join(p, '..'), { recursive: true }); await writeFile(p, content); }
  // Import after env isolation (Blackhole computes its global dir at module load).
  const sdk = await import('@earendil-works/pi-coding-agent');
  const { Agent } = await import('@earendil-works/pi-agent-core');
  const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');
  sdk.initTheme('dark', false);
  const settings = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted });
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, extensionFactories,
    additionalExtensionPaths: withBlackhole ? [blackholeEntry] : [], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const runtime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  runtime.registerProvider('offline', { api: 'openai-responses', apiKey: 'synthetic', baseUrl: 'https://offline.invalid', ...(streamSimple ? { streamSimple } : {}),
    models: [{ id: 'm', name: 'M', api: 'openai-responses', reasoning: false, input: ['text'], contextWindow: 1048576, maxTokens: 256, cost }] });
  const model = runtime.getModels().find(m => m.provider === 'offline');
  const usage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...cost, total: 0 } });
  const assistant = text => ({ role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider, model: model.id,
    usage: usage(), stopReason: 'stop', timestamp: Date.now() });
  const providerCalls = [];
  const streamFn = (m, context) => {
    providerCalls.push(context);
    const message = assistant(summarize ? summarize(context) : 'OFFLINE_OK');
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'start', partial: { ...message, stopReason: 'pending' } }); stream.push({ type: 'done', reason: 'stop', message }); stream.end(message);
    return stream;
  };
  const sm = sdk.SessionManager.create(cwd, join(agentDir, 'sessions'));
  const agent = new Agent({ initialState: { model }, convertToLlm: sdk.convertToLlm, streamFn });
  const session = new sdk.AgentSession({ agent, sessionManager: sm, settingsManager: settings, cwd, modelRuntime: runtime, resourceLoader: loader });
  const user = text => sm.appendMessage({ role: 'user', content: text, timestamp: Date.now() });
  const reply = text => sm.appendMessage(assistant(text));
  const cleanup = async () => {
    try { session.dispose(); } catch {}
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  return { sdk, session, sm, settings, loader, home, agentDir, cwd, model, providerCalls, user, reply, assistant, cleanup,
    loadErrors: () => loader.getExtensions().errors };
}
