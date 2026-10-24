import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export type Provider = 'openai' | 'native' | 'brave' | 'exa' | 'deepseek';
export interface Credential { apiKey?: string; apiKeyEnv?: string }
export interface Config {
  version: 1;
  provider: Provider;
  enabled: boolean;
  numResults: number;
  searchTimeoutMs: number;
  providers: { openai: { captureSources: boolean }; google: { captureSources: boolean }; brave: Credential; exa: Credential; deepseek: Credential };
  fetch: { channel: 'chromium' | 'chrome'; timeoutMs: number; maxConcurrency: number; idleTimeoutMs: number };
}
// Explicit override only; changing pi's agentDir must not silently migrate secrets.
export const CONFIG_PATH = process.env.PI_WEB_TOOLS_CONFIG ?? join(homedir(), '.pi', 'agent', 'web-search.json');
export const defaults = (): Config => ({
  version: 1, provider: 'openai', enabled: true, numResults: 5, searchTimeoutMs: 60000,
  // An empty DeepSeek credential means "use Pi's stored `deepseek` credential"; brave/exa have no Pi login provider.
  providers: { openai: { captureSources: false }, google: { captureSources: false }, brave: { apiKeyEnv: 'BRAVE_API_KEY' }, exa: { apiKeyEnv: 'EXA_API_KEY' }, deepseek: {} },
  fetch: { channel: 'chromium', timeoutMs: 30000, maxConcurrency: 2, idleTimeoutMs: 60000 },
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
    if (!['openai', 'native', 'brave', 'exa', 'deepseek'].includes(o.provider as string)) invalid('provider', 'must be one of openai, native, brave, exa, deepseek');
    c.provider = o.provider as Provider;
  }
  if (o.enabled !== undefined) c.enabled = boolean(o.enabled, 'enabled');
  if (o.numResults !== undefined) c.numResults = integer(o.numResults, 1, 10, 'numResults');
  if (o.searchTimeoutMs !== undefined) c.searchTimeoutMs = integer(o.searchTimeoutMs, 1000, 120000, 'searchTimeoutMs');
  if (o.providers !== undefined) {
    const p = object(o.providers, 'providers');
    keys(p, ['openai', 'google', 'brave', 'exa', 'deepseek'], 'providers');
    for (const name of ['brave', 'exa', 'deepseek'] as const) if (p[name] !== undefined) c.providers[name] = credential(p[name], `providers.${name}`);
    for (const name of ['openai', 'google'] as const) {
      if (p[name] === undefined) continue;
      const a = object(p[name], `providers.${name}`);
      keys(a, ['captureSources'], `providers.${name}`);
      if (a.captureSources !== undefined) c.providers[name].captureSources = boolean(a.captureSources, `providers.${name}.captureSources`);
    }
  }
  if (o.fetch !== undefined) {
    const f = object(o.fetch, 'fetch');
    keys(f, ['channel', 'timeoutMs', 'maxConcurrency', 'idleTimeoutMs'], 'fetch');
    if (f.channel !== undefined) {
      if (f.channel !== 'chromium' && f.channel !== 'chrome') invalid('fetch.channel', 'must be "chromium" or "chrome"');
      c.fetch.channel = f.channel;
    }
    if (f.timeoutMs !== undefined) c.fetch.timeoutMs = integer(f.timeoutMs, 1000, 120000, 'fetch.timeoutMs');
    if (f.maxConcurrency !== undefined) c.fetch.maxConcurrency = integer(f.maxConcurrency, 1, 4, 'fetch.maxConcurrency');
    if (f.idleTimeoutMs !== undefined) c.fetch.idleTimeoutMs = integer(f.idleTimeoutMs, 1000, 300000, 'fetch.idleTimeoutMs');
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
