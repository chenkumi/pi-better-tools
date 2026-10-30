import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR_NAME } from '@earendil-works/pi-coding-agent';
import { normalizeName } from './protocol.js';

export type WakeMode = 'on' | 'off' | 'allowlist';
export interface RemoteConfig {
  mode: 'server' | 'client';
  name?: string;
  wake: WakeMode;
  allowFrom: string[];
  /** Explicit opt-in for plain ws:// beyond the loopback interface. */
  insecure: boolean;
  server?: { port: number; bind: string; tls?: { cert: string; key: string } };
  client?: { host: string; port: number; tls: boolean };
}
export type LoadedConfig = { kind: 'off' } | { kind: 'ok'; config: RemoteConfig } | { kind: 'error'; message: string };

export const remoteConfigPath = (cwd: string) => join(cwd, CONFIG_DIR_NAME, 'agent', 'remote.json');
export const isLoopback = (host: string) => { const h = host.replace(/^\[|\]$/g, '').toLowerCase(); return h === 'localhost' || h === '::1' || h === '::ffff:127.0.0.1' || /^127\./.test(h); };

const invalid = (detail: string): never => { throw new Error(`CONFIG_INVALID: ${detail}`); };
function record(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${path}: expected an object`);
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter(key => !allowed.includes(key));
  if (unknown.length) invalid(`${path}: unknown key${unknown.length > 1 ? 's' : ''} ${unknown.map(k => JSON.stringify(k)).join(', ')} (allowed: ${allowed.join(', ')})`);
  return raw;
}
const text = (value: unknown, path: string): string => (typeof value === 'string' && value.trim() ? value.trim() : invalid(`${path}: expected a non-empty string`));
const port = (value: unknown, path: string): number => (Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535 ? value as number : invalid(`${path}: expected an integer 1-65535`));
const flag = (value: unknown, path: string, fallback: boolean): boolean => (value === undefined ? fallback : typeof value === 'boolean' ? value : invalid(`${path}: expected true or false`));

/** Strict: a typo such as a misspelled key fails loudly instead of silently running with defaults. */
export function parseRemoteConfig(raw: unknown): RemoteConfig | undefined {
  const top = record(raw, 'remote.json', ['mode', 'name', 'wake', 'allowFrom', 'insecure', 'server', 'client']);
  if (top.mode === 'off') return undefined;
  if (top.mode !== 'server' && top.mode !== 'client') invalid('mode: expected "server", "client" or "off"');
  const mode = top.mode as 'server' | 'client';
  let name: string | undefined;
  if (top.name !== undefined) name = normalizeName(top.name) ?? invalid('name: use 1-24 characters of a-z, 0-9 and "-", starting with a letter or digit');
  const wake = top.wake === undefined ? 'on' : (['on', 'off', 'allowlist'] as const).includes(top.wake as WakeMode) ? top.wake as WakeMode : invalid('wake: expected "on", "off" or "allowlist"');
  const allowFrom: string[] = [];
  if (top.allowFrom !== undefined) {
    if (!Array.isArray(top.allowFrom) || top.allowFrom.length > 64) invalid('allowFrom: expected an array of at most 64 peer names');
    for (const item of top.allowFrom as unknown[]) allowFrom.push(normalizeName(item) ?? invalid(`allowFrom: invalid peer name ${JSON.stringify(item)}`));
  }
  const insecure = flag(top.insecure, 'insecure', false);
  const config: RemoteConfig = { mode, wake, allowFrom, insecure, ...(name ? { name } : {}) };
  if (mode === 'server') {
    if (top.client !== undefined) invalid('client: not used when mode is "server"');
    const server = record(top.server ?? invalid('server: required when mode is "server" (set server.port)'), 'server', ['port', 'bind', 'tls']);
    const bind = server.bind === undefined ? '127.0.0.1' : text(server.bind, 'server.bind');
    let tls: { cert: string; key: string } | undefined;
    if (server.tls !== undefined) {
      const raw = record(server.tls, 'server.tls', ['cert', 'key']);
      tls = { cert: text(raw.cert, 'server.tls.cert'), key: text(raw.key, 'server.tls.key') };
    }
    if (!tls && !isLoopback(bind) && !insecure) invalid('server: binding beyond loopback needs server.tls (wss) or an explicit "insecure": true for plain ws');
    config.server = { port: port(server.port, 'server.port'), bind, ...(tls ? { tls } : {}) };
  } else {
    if (top.server !== undefined) invalid('server: not used when mode is "client"');
    const client = record(top.client ?? invalid('client: required when mode is "client" (set client.host and client.port)'), 'client', ['host', 'port', 'tls']);
    const host = text(client.host, 'client.host');
    if (/[\s/@]/.test(host)) invalid('client.host: expected a bare host name or address');
    const tls = flag(client.tls, 'client.tls', true);
    if (!tls && !isLoopback(host) && !insecure) invalid('client: plain ws beyond loopback needs client.tls true (wss) or an explicit "insecure": true');
    config.client = { host, port: port(client.port, 'client.port'), tls };
  }
  return config;
}

/** Project-authored, so only read when the project is trusted. A missing file means Remote is off. */
export async function loadRemoteConfig(cwd: string, trusted: boolean): Promise<LoadedConfig> {
  if (!trusted) return { kind: 'off' };
  const path = remoteConfigPath(cwd);
  let contents: string;
  try { contents = await readFile(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'off' };
    return { kind: 'error', message: `Cannot read ${path}: ${(error as Error).message}` };
  }
  try {
    const config = parseRemoteConfig(JSON.parse(contents.replace(/^﻿/, '')));
    return config ? { kind: 'ok', config } : { kind: 'off' };
  } catch (error) {
    return { kind: 'error', message: `Invalid ${path}: ${error instanceof SyntaxError ? `not valid JSON (${error.message})` : (error as Error).message}` };
  }
}
