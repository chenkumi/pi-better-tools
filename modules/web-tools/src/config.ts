import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** Providers that call a REST API (the others use the model's own search). */
export const REST_PROVIDERS = ['brave', 'exa', 'deepseek'] as const;
export type RestProvider = (typeof REST_PROVIDERS)[number];
export const PROVIDERS = ['openai', 'native', ...REST_PROVIDERS] as const;
export type Provider = (typeof PROVIDERS)[number];
export const PROVIDER_LABELS: Record<RestProvider, string> = { brave: 'Brave', exa: 'Exa', deepseek: 'DeepSeek' };
/** Inclusive integer ranges shared by parseConfig and the settings panel. */
export const NUM_RESULTS_RANGE = { min: 1, max: 10 } as const;
export const TIMEOUT_MS_RANGE = { min: 1000, max: 120000 } as const;
export const MAX_CONCURRENCY_RANGE = { min: 1, max: 4 } as const;
export interface Credential { apiKey?: string; apiKeyEnv?: string }
export interface Config {
  version: 1;
  provider: Provider;
  enabled: boolean;
  numResults: number;
  searchTimeoutMs: number;
  providers: { openai: { captureSources: boolean }; google: { captureSources: boolean }; brave: Credential; exa: Credential; deepseek: Credential };
  fetch: { timeoutMs: number; maxConcurrency: number };
}
// Explicit override only; changing pi's agentDir must not silently migrate secrets.
export const CONFIG_PATH = process.env.PI_WEB_TOOLS_CONFIG ?? join(homedir(), '.pi', 'agent', 'web-search.json');
export const defaults = (): Config => ({
  version: 1, provider: 'openai', enabled: true, numResults: 5, searchTimeoutMs: 60000,
  // An empty DeepSeek credential means "use Pi's stored `deepseek` credential"; brave/exa have no Pi login provider.
  providers: { openai: { captureSources: false }, google: { captureSources: false }, brave: { apiKeyEnv: 'BRAVE_API_KEY' }, exa: { apiKeyEnv: 'EXA_API_KEY' }, deepseek: {} },
  fetch: { timeoutMs: 30000, maxConcurrency: 2 },
});
/** `path` names the field; `rule` states what is allowed. Received values are never echoed (they may be credentials). */
function invalid(path: string, rule: string): never { throw new Error(`CONFIG_INVALID: ${path}: ${rule}`); }
function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'must be a JSON object');
  return value as Record<string, unknown>;
}
function keys(o: Record<string, unknown>, allowed: string[], path: string) {
  for (const key of Object.keys(o)) if (!allowed.includes(key)) invalid(path, `unknown field; allowed fields: ${allowed.join(', ')}`);
}
function integer(v: unknown, min: number, max: number, path: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) invalid(path, `must be an integer from ${min} to ${max}`);
  return v;
}
function boolean(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') invalid(path, 'must be true or false');
  return v;
}
function credential(v: unknown, path: string): Credential {
  const o = object(v, path);
  keys(o, ['apiKey', 'apiKeyEnv'], path);
  if (o.apiKey !== undefined && o.apiKeyEnv !== undefined) invalid(path, 'apiKey and apiKeyEnv are mutually exclusive; set only one of them');
  for (const key of ['apiKey', 'apiKeyEnv']) {
    if (o[key] !== undefined && (typeof o[key] !== 'string' || !(o[key] as string).trim())) invalid(`${path}.${key}`, 'must be a non-empty string');
  }
  if (o.apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(o.apiKeyEnv as string)) invalid(`${path}.apiKeyEnv`, 'must be an environment variable name (letters, digits and underscore, not starting with a digit), not the key itself');
  return o as Credential;
}
export function parseConfig(value: unknown): Config {
  const o = object(value, 'root'), c = defaults();
  keys(o, ['version', 'provider', 'enabled', 'numResults', 'searchTimeoutMs', 'providers', 'fetch'], 'root');
  if (o.version !== undefined && o.version !== 1) invalid('version', 'must be 1');
  if (o.provider !== undefined) {
    if (!(PROVIDERS as readonly string[]).includes(o.provider as string)) invalid('provider', `must be one of ${PROVIDERS.join(', ')}`);
    c.provider = o.provider as Provider;
  }
  if (o.enabled !== undefined) c.enabled = boolean(o.enabled, 'enabled');
  if (o.numResults !== undefined) c.numResults = integer(o.numResults, NUM_RESULTS_RANGE.min, NUM_RESULTS_RANGE.max, 'numResults');
  if (o.searchTimeoutMs !== undefined) c.searchTimeoutMs = integer(o.searchTimeoutMs, TIMEOUT_MS_RANGE.min, TIMEOUT_MS_RANGE.max, 'searchTimeoutMs');
  if (o.providers !== undefined) {
    const p = object(o.providers, 'providers');
    keys(p, ['openai', 'google', ...REST_PROVIDERS], 'providers');
    for (const name of REST_PROVIDERS) if (p[name] !== undefined) c.providers[name] = credential(p[name], `providers.${name}`);
    for (const name of ['openai', 'google'] as const) {
      if (p[name] === undefined) continue;
      const a = object(p[name], `providers.${name}`);
      keys(a, ['captureSources'], `providers.${name}`);
      if (a.captureSources !== undefined) c.providers[name].captureSources = boolean(a.captureSources, `providers.${name}.captureSources`);
    }
  }
  if (o.fetch !== undefined) {
    const f = object(o.fetch, 'fetch');
    keys(f, ['timeoutMs', 'maxConcurrency'], 'fetch');
    if (f.timeoutMs !== undefined) c.fetch.timeoutMs = integer(f.timeoutMs, TIMEOUT_MS_RANGE.min, TIMEOUT_MS_RANGE.max, 'fetch.timeoutMs');
    if (f.maxConcurrency !== undefined) c.fetch.maxConcurrency = integer(f.maxConcurrency, MAX_CONCURRENCY_RANGE.min, MAX_CONCURRENCY_RANGE.max, 'fetch.maxConcurrency');
  }
  return c;
}
export function loadConfig(path = CONFIG_PATH): Config {
  if (!isAbsolute(path)) throw new Error('CONFIG_INVALID: configuration path must be absolute');
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return defaults();
    throw new Error('CONFIG_INVALID: cannot read configuration file');
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('CONFIG_INVALID: invalid JSON (values omitted for security)'); }
  return parseConfig(value);
}
/** Agent-facing: names no configuration keys, environment variables or paths. */
function authMessage(provider?: string): string {
  const name = provider ?? 'the selected search provider';
  return `AUTH_REQUIRED: No API key available for ${name}; ask the user to set a valid ${provider ? `${provider} ` : ''}search service API key in the web tools configuration, then run /reload.`;
}
/** Agent-facing wording for a configuration failure: keeps the error code and a generic cause, never setting names or values. */
export function agentConfigError(message: string): string {
  const generic = /^CONFIG_INVALID: (invalid JSON|cannot read configuration file)/.exec(message);
  return generic ? `CONFIG_INVALID: ${generic[1]}` : 'CONFIG_INVALID: a value in the web tools configuration is invalid';
}
export function resolveKey(c: Credential, env: NodeJS.ProcessEnv = process.env, provider?: string): string {
  const value = c.apiKey ?? (c.apiKeyEnv ? env[c.apiKeyEnv] : undefined);
  if (!value?.trim()) throw new Error(authMessage(provider));
  return value.trim();
}
