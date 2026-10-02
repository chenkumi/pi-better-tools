import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export type Provider = 'openai' | 'brave' | 'exa';
export interface Credential { apiKey?: string; apiKeyEnv?: string }
export interface Config {
  version: 1;
  provider: Provider;
  enabled: boolean;
  numResults: number;
  searchTimeoutMs: number;
  providers: { openai: { experimentalCodex: boolean; captureSources: boolean }; brave: Credential; exa: Credential };
  fetch: { channel: 'chromium' | 'chrome'; timeoutMs: number; maxConcurrency: number; idleTimeoutMs: number };
}
// Explicit override only; changing pi's agentDir must not silently migrate secrets.
export const CONFIG_PATH = process.env.PI_WEB_TOOLS_CONFIG ?? join(homedir(), '.pi', 'agent', 'web-search.json');
export const defaults = (): Config => ({
  version: 1, provider: 'openai', enabled: true, numResults: 5, searchTimeoutMs: 60000,
  providers: { openai: { experimentalCodex: false, captureSources: false }, brave: { apiKeyEnv: 'BRAVE_API_KEY' }, exa: { apiKeyEnv: 'EXA_API_KEY' } },
  fetch: { channel: 'chromium', timeoutMs: 30000, maxConcurrency: 2, idleTimeoutMs: 60000 },
});
function invalid(path: string): never { throw new Error(`CONFIG_INVALID: ${path}`); }
function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path);
  return value as Record<string, unknown>;
}
function keys(o: Record<string, unknown>, allowed: string[], path: string) {
  for (const key of Object.keys(o)) if (!allowed.includes(key)) invalid(`${path}: unknown field`);
}
function integer(v: unknown, min: number, max: number, path: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) invalid(path);
  return v;
}
function boolean(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') invalid(path);
  return v;
}
function credential(v: unknown, path: string): Credential {
  const o = object(v, path);
  keys(o, ['apiKey', 'apiKeyEnv'], path);
  if (o.apiKey !== undefined && o.apiKeyEnv !== undefined) invalid(`${path}: apiKey and apiKeyEnv are mutually exclusive`);
  for (const key of ['apiKey', 'apiKeyEnv']) {
    if (o[key] !== undefined && (typeof o[key] !== 'string' || !(o[key] as string).trim())) invalid(`${path}.${key}`);
  }
  if (o.apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(o.apiKeyEnv as string)) invalid(`${path}.apiKeyEnv`);
  return o as Credential;
}
export function parseConfig(value: unknown): Config {
  const o = object(value, 'root'), c = defaults();
  keys(o, ['version', 'provider', 'enabled', 'numResults', 'searchTimeoutMs', 'providers', 'fetch'], 'root');
  if (o.version !== undefined && o.version !== 1) invalid('version');
  if (o.provider !== undefined) {
    if (!['openai', 'brave', 'exa'].includes(o.provider as string)) invalid('provider');
    c.provider = o.provider as Provider;
  }
  if (o.enabled !== undefined) c.enabled = boolean(o.enabled, 'enabled');
  if (o.numResults !== undefined) c.numResults = integer(o.numResults, 1, 10, 'numResults');
  if (o.searchTimeoutMs !== undefined) c.searchTimeoutMs = integer(o.searchTimeoutMs, 1000, 120000, 'searchTimeoutMs');
  if (o.providers !== undefined) {
    const p = object(o.providers, 'providers');
    keys(p, ['openai', 'brave', 'exa'], 'providers');
    for (const name of ['brave', 'exa'] as const) if (p[name] !== undefined) c.providers[name] = credential(p[name], `providers.${name}`);
    if (p.openai !== undefined) {
      const a = object(p.openai, 'providers.openai');
      keys(a, ['experimentalCodex', 'captureSources'], 'providers.openai');
      if (a.captureSources !== undefined) c.providers.openai.captureSources = boolean(a.captureSources, 'providers.openai.captureSources');
      if (a.experimentalCodex !== undefined) c.providers.openai.experimentalCodex = boolean(a.experimentalCodex, 'providers.openai.experimentalCodex');
    }
  }
  if (o.fetch !== undefined) {
    const f = object(o.fetch, 'fetch');
    keys(f, ['channel', 'timeoutMs', 'maxConcurrency', 'idleTimeoutMs'], 'fetch');
    if (f.channel !== undefined) {
      if (f.channel !== 'chromium' && f.channel !== 'chrome') invalid('fetch.channel');
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
export function resolveKey(c: Credential, env: NodeJS.ProcessEnv = process.env): string {
  const value = c.apiKey ?? (c.apiKeyEnv ? env[c.apiKeyEnv] : undefined);
  if (!value?.trim()) throw new Error('AUTH_REQUIRED: configure apiKey or apiKeyEnv for the selected search provider');
  return value.trim();
}
