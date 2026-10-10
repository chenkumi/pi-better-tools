// Shared harness for defect reproduction tests: a real Pi 1.1.0 AgentSession with an offline scripted provider.
// It never contacts a real provider; credentials/home/agentDir/workspace are isolated temporary directories.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnv } from '../../helpers/environment.mjs';

export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const log = message => console.error(`[defect-repro] ${message}`);

/** Replaces process.env wholesale with the isolated environment (node --test runs each file in its own process). */
export async function isolate(prefix) {
  const home = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const saved = { ...process.env }, isolated = isolatedEnv(home);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, isolated);
  const agentDir = process.env.PI_CODING_AGENT_DIR, cwd = join(home, 'workspace');
  await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true });
  await writeFile(join(agentDir, 'auth.json'), '{}');
  return { home, agentDir, cwd,
    async cleanup() {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } };
}

export function heartbeat(label) {
  const timer = setInterval(() => log(`${label}: still running (progress heartbeat)...`), 10000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Resolves once predicate() is true; re-checked every time poke() is called (event driven, no sleeping). */
export function barrier() {
  const waiters = new Set();
  return {
    poke() { for (const check of [...waiters]) check(); },
    wait(predicate, label = 'condition', timeoutMs = 60000) {
      return new Promise((resolveWait, reject) => {
        const check = () => { if (predicate()) { waiters.delete(check); clearTimeout(timer); resolveWait(); } };
        const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`barrier timeout waiting for ${label}`)); }, timeoutMs);
        waiters.add(check); check();
      });
    },
  };
}
/** Lets already-queued I/O and timers-free continuations run; bounded event-loop turns, not wall-clock sleeping. */
export async function turns(count = 100) { for (let i = 0; i < count; i++) await new Promise(r => setImmediate(r)); }

const model = { id: 'offline', name: 'Offline', provider: 'openai', api: 'openai-responses', baseUrl: 'https://unused.invalid',
  reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

/**
 * options: { env: isolate() result, extensionPaths, extensionFactories, uiContext, mode }
 * Script: host.script.push({ toolCalls: [{ name, arguments }] }) -> next provider turn emits those tool calls (the real agent loop runs them).
 */
export async function createHost(options) {
  const { env } = options;
  const sdk = await import('@earendil-works/pi-coding-agent');
  const ai = await import('@earendil-works/pi-ai');
  sdk.initTheme('dark', false);
  await writeFile(join(env.agentDir, 'settings.json'), JSON.stringify({ defaultTools: ['read'], retry: { enabled: false }, compaction: { enabled: false },
    cacheWarming: 'off', enableInstallTelemetry: false, defaultProjectTrust: 'never' }));
  const settingsManager = await sdk.SettingsManager.create(env.cwd, env.agentDir, { projectTrusted: options.projectTrusted ?? false });
  const sessionManager = sdk.SessionManager.inMemory(env.cwd);
  const script = [], errors = [], state = { calls: 0 };
  const observer = pi => {
    pi.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: 'offline-non-secret', models: [model],
      streamSimple(m) {
        const stream = ai.createAssistantMessageEventStream();
        const invocation = ++state.calls;
        const next = script.shift();
        queueMicrotask(() => {
          const calls = next?.toolCalls?.map((call, i) => ({ type: 'toolCall', id: `call_${invocation}_${i}`, name: call.name, arguments: call.arguments ?? {} }));
          const message = { role: 'assistant', api: m.api, provider: m.provider, model: m.id, responseId: `resp_${invocation}`, timestamp: Date.now(),
            content: calls?.length ? calls : [{ type: 'text', text: 'OFFLINE_DONE' }], stopReason: calls?.length ? 'toolUse' : 'stop',
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason, message }); stream.end();
        });
        return stream;
      } });
  };
  const loader = new sdk.DefaultResourceLoader({ cwd: env.cwd, agentDir: env.agentDir, settingsManager, additionalExtensionPaths: options.extensionPaths ?? [],
    extensionFactories: [observer, ...(options.extensionFactories ?? [])], noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
  await loader.reload();
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(env.agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const { session } = await sdk.createAgentSession({ cwd: env.cwd, agentDir: env.agentDir, settingsManager, sessionManager, resourceLoader: loader, modelRuntime, model });
  const bindings = { mode: 'json', onError: event => errors.push(event.error ?? event), ...(options.uiContext ? { uiContext: options.uiContext } : {}) };
  const host = {
    sdk, session, loader, errors, script, state, loadErrors: () => loader.getExtensions().errors,
    bind: () => session.bindExtensions(bindings),
    toolResults: () => session.messages.filter(m => m.role === 'toolResult'),
    /** Runs one real agent turn in which the scripted model calls the given tools; returns the new toolResult messages. */
    async callTools(...calls) {
      const before = host.toolResults().length;
      script.push({ toolCalls: calls });
      await session.prompt('run scripted tool calls', { expandPromptTemplates: false });
      return host.toolResults().slice(before);
    },
    async close() {
      try { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); } catch { /* reported by the test */ }
      finally { session.dispose(); }
    },
  };
  return host;
}
export const text = result => (result.content ?? []).map(part => part.text ?? '').join('');
export const manifest = async () => JSON.parse(await (await import('node:fs/promises')).readFile(join(repoRoot, 'package.json'), 'utf8'));
export const entry = relative => resolve(repoRoot, relative);
