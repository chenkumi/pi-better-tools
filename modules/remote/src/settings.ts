import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerSettingsCommand } from '../../pi-runtime/src/settings-panel/index.js';
import type { Field, Patch, SettingsSchema, Values } from '../../pi-runtime/src/settings-panel/index.js';
import { loadRemoteConfig, parseRemoteConfig, remoteConfigPath, type WakeMode } from './config.js';
import type { CredentialStore } from './credentials.js';
import { generateCode, normalizeCode, normalizeName } from './protocol.js';

/** The panel's flat view of `remote.json`; every key is also the key in the panel `Values`. */
export interface PanelConfig {
  mode: 'off' | 'server' | 'client';
  name: string; wake: WakeMode; allowFrom: string; insecure: boolean;
  serverPort: number; bind: string; tlsCert: string; tlsKey: string;
  host: string; clientPort: number; clientTls: boolean;
}
const DEFAULT_PORT = 7821, DEFAULT_BIND = '127.0.0.1';
const DEFAULTS: PanelConfig = { mode: 'off', name: '', wake: 'on', allowFrom: '', insecure: false, serverPort: DEFAULT_PORT, bind: DEFAULT_BIND, tlsCert: '', tlsKey: '', host: '', clientPort: DEFAULT_PORT, clientTls: true };

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

/** What the panel shows for a document the loader would not accept (mode off, or no mode yet): whatever is readable. */
function lenient(top: Record<string, unknown>): PanelConfig {
  const server = record(top.server), tls = record(server.tls), client = record(top.client);
  const text = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback);
  const port = (value: unknown) => (Number.isInteger(value) ? value as number : DEFAULT_PORT);
  return {
    mode: 'off', name: text(top.name, ''), wake: top.wake === 'off' || top.wake === 'allowlist' ? top.wake : 'on',
    allowFrom: Array.isArray(top.allowFrom) ? top.allowFrom.filter((n): n is string => typeof n === 'string').join(', ') : '', insecure: top.insecure === true,
    serverPort: port(server.port), bind: text(server.bind, DEFAULT_BIND), tlsCert: text(tls.cert, ''), tlsKey: text(tls.key, ''),
    host: text(client.host, ''), clientPort: port(client.port), clientTls: client.tls !== false,
  };
}

/** Same rules as the extension's own loader: it stays the only source of validity. */
export function parsePanelConfig(raw: unknown): PanelConfig {
  const top = record(raw);
  if (top.mode === undefined && !Object.keys(top).length) return { ...DEFAULTS };
  if (top.mode === undefined) return lenient(top);
  const config = parseRemoteConfig(raw); // throws CONFIG_INVALID for anything the loader would reject
  if (!config) return lenient(top);
  return {
    ...DEFAULTS, mode: config.mode, name: config.name ?? '', wake: config.wake, allowFrom: config.allowFrom.join(', '), insecure: config.insecure,
    ...(config.server ? { serverPort: config.server.port, bind: config.server.bind, tlsCert: config.server.tls?.cert ?? '', tlsKey: config.server.tls?.key ?? '' } : {}),
    ...(config.client ? { host: config.client.host, clientPort: config.client.port, clientTls: config.client.tls } : {}),
  };
}

const on = (...modes: Array<PanelConfig['mode']>) => (v: Values) => modes.includes(v.mode as PanelConfig['mode']);
const FIELDS: readonly Field[] = [
  { key: 'mode', type: 'enum', group: 'Role', tab: 'Connection', label: 'Mode', options: ['off', 'server', 'client'],
    help: 'server: this session hosts the network and joins it. client: join a server. off: Remote disabled.' },
  { key: 'name', type: 'string', group: 'Role', tab: 'Connection', label: 'Name', placeholder: 'random per session', visibleWhen: on('server', 'client'),
    help: '1-24 characters: a-z, 0-9 and "-". Empty picks a random name.' },
  { key: 'wake', type: 'enum', group: 'Messages', tab: 'Connection', label: 'Wake on message', options: ['on', 'off', 'allowlist'], visibleWhen: on('server', 'client'),
    help: 'Whether a message from another session starts an agent turn. Messages are always delivered.' },
  { key: 'allowFrom', type: 'string', group: 'Messages', tab: 'Connection', label: 'Wake only for', placeholder: 'mac-test, linux-1', visibleWhen: v => on('server', 'client')(v) && v.wake === 'allowlist',
    help: 'Comma-separated peer names.' },
  { key: 'insecure', type: 'boolean', group: 'Messages', tab: 'Connection', label: 'Allow plain ws beyond loopback', visibleWhen: on('server', 'client'),
    help: 'Off: a LAN server needs TLS (wss). Turn on only for a network you trust.' },
  { key: 'serverPort', type: 'int', group: 'Listen', tab: 'Server', label: 'Port', min: 1, max: 65535, visibleWhen: on('server') },
  { key: 'bind', type: 'string', group: 'Listen', tab: 'Server', label: 'Bind address', placeholder: DEFAULT_BIND, visibleWhen: on('server'),
    help: '0.0.0.0 accepts LAN clients; it needs the TLS files below unless plain ws is allowed.' },
  { key: 'tlsCert', type: 'string', group: 'TLS', tab: 'Server', label: 'Certificate (PEM)', placeholder: 'certs/cert.pem', visibleWhen: on('server'), help: 'Relative to the project. You provide the files; wss needs both.' },
  { key: 'tlsKey', type: 'string', group: 'TLS', tab: 'Server', label: 'Private key (PEM)', placeholder: 'certs/key.pem', visibleWhen: on('server') },
  { key: 'serverCode', type: 'code', group: 'Pairing', tab: 'Server', label: 'Pairing code', visibleWhen: on('server'), generate: generateCode,
    help: 'Give this code to each client. Enter makes a new one; saving it revokes every client paired with the old one.' },
  { key: 'host', type: 'string', group: 'Server', tab: 'Client', label: 'Host', placeholder: '192.168.1.10', visibleWhen: on('client') },
  { key: 'clientPort', type: 'int', group: 'Server', tab: 'Client', label: 'Port', min: 1, max: 65535, visibleWhen: on('client') },
  { key: 'clientTls', type: 'boolean', group: 'Server', tab: 'Client', label: 'Encrypted (wss)', visibleWhen: on('client') },
  { key: 'clientCode', type: 'secret', group: 'Pairing', tab: 'Client', label: 'Pairing code', visibleWhen: on('client'), configured: v => v.clientCodeSet === true,
    help: 'The code shown on the server. Kept in your Pi agent directory, never in this project.' },
];

export interface PanelFacts {
  /** The code shown on the Server page: the stored one, or a fresh candidate that Save will store. */
  serverCode: string;
  /** Whether `serverCode` is already stored; if not, the panel treats it as changed so Save writes it. */
  serverCodeStored: boolean;
  /** Whether a pairing code is already stored for the configured server. */
  clientCodeSet: boolean;
}

export function remoteSettings(path: string, credentials: CredentialStore, facts: PanelFacts): SettingsSchema<PanelConfig> {
  return {
    id: 'remote', title: 'Remote', path, fields: FIELDS, parse: parsePanelConfig,
    afterSave: 'Pairing codes stay in your Pi agent directory, not in the project.',
    unsaved: facts.serverCodeStored ? [] : ['serverCode'],
    toValues: (c): Values => ({ ...c, serverCode: facts.serverCode, clientCodeSet: facts.clientCodeSet }),
    toPatch(v, dirty): Patch[] {
      const mode = v.mode as PanelConfig['mode'];
      if (mode === 'client') {
        if (!String(v.host ?? '').trim()) throw new Error('Enter the server host (an IP address or a name).');
        if (dirty.has('clientCode') && !normalizeCode(String(v.clientCode ?? ''))) throw new Error('Enter a 12-character pairing code, for example ABCD-EFGH-JKLM.');
      }
      // Pairing codes live outside this file: when only they changed, the file stays as it is.
      if (![...dirty].some(key => key !== 'clientCode' && key !== 'serverCode')) return [];
      const patches: Patch[] = [{ path: ['mode'], value: mode }];
      if (mode === 'off') return patches;
      if (dirty.has('name')) {
        const name = String(v.name ?? '').trim();
        if (name && !normalizeName(name)) throw new Error('Enter a name of 1-24 characters: a-z, 0-9 and "-".');
        patches.push({ path: ['name'], value: name ? normalizeName(name) : undefined });
      }
      if (dirty.has('wake')) patches.push({ path: ['wake'], value: v.wake === 'on' ? undefined : v.wake });
      if (dirty.has('allowFrom')) {
        const names = String(v.allowFrom ?? '').split(/[,\s]+/).filter(Boolean).map(entry => normalizeName(entry) ?? (() => { throw new Error(`Enter valid peer names (a-z, 0-9 and "-"), separated by commas; "${entry.slice(0, 24)}" is not one.`); })());
        patches.push({ path: ['allowFrom'], value: names.length ? names : undefined });
      }
      if (dirty.has('insecure')) patches.push({ path: ['insecure'], value: v.insecure === true ? true : undefined });
      if (mode === 'server') {
        const cert = String(v.tlsCert ?? '').trim(), key = String(v.tlsKey ?? '').trim();
        if (!cert !== !key) throw new Error('Enter both the certificate and the private key path, or leave both empty.');
        const bind = String(v.bind ?? '').trim() || DEFAULT_BIND;
        patches.push(
          { path: ['client'], value: undefined },
          { path: ['server', 'port'], value: Number(v.serverPort) },
          { path: ['server', 'bind'], value: bind === DEFAULT_BIND ? undefined : bind },
          { path: ['server', 'tls'], value: cert ? { cert, key } : undefined },
        );
      } else {
        const host = String(v.host ?? '').trim();
        patches.push(
          { path: ['server'], value: undefined },
          { path: ['client', 'host'], value: host },
          { path: ['client', 'port'], value: Number(v.clientPort) },
          { path: ['client', 'tls'], value: v.clientTls === false ? false : undefined },
        );
      }
      return patches;
    },
    async afterWrite(v, dirty) {
      try {
        if (v.mode === 'server') {
          // Store what the panel showed (a fresh candidate or a regenerated code), so the code the user read is the one in force.
          const shown = normalizeCode(String(v.serverCode ?? ''));
          if (shown && shown !== normalizeCode(await credentials.peekServerCode() ?? '')) await credentials.saveServerCode(shown);
          else if (!shown) await credentials.serverCode();
        } else if (v.mode === 'client' && dirty.has('clientCode')) {
          await credentials.saveClientCode(`${String(v.host).trim()}:${Number(v.clientPort)}`, String(v.clientCode));
        }
      } catch (error) {
        return `The settings were saved, but the pairing code could not be stored (${(error as Error).message}).`;
      }
      return undefined;
    },
  };
}

/** `/settings:remote`: trusted projects only, like the file it edits. The command only reads state; the file and the code are written on Save. */
export function registerRemoteSettings(pi: ExtensionAPI, credentials: () => CredentialStore): void {
  registerSettingsCommand(pi, async ctx => {
    if (!ctx.isProjectTrusted()) return 'Remote settings are only available in trusted projects.';
    const store = credentials();
    const loaded = await loadRemoteConfig(ctx.cwd, true);
    const facts: PanelFacts = { serverCode: generateCode(), serverCodeStored: false, clientCodeSet: false };
    try {
      const stored = await store.peekServerCode();
      if (stored) { facts.serverCode = stored; facts.serverCodeStored = true; }
      if (loaded.kind === 'ok' && loaded.config.mode === 'client' && loaded.config.client) facts.clientCodeSet = Boolean(await store.clientCode(`${loaded.config.client.host}:${loaded.config.client.port}`));
    } catch { /* an unreadable credentials file keeps the candidate; saving reports the problem */ }
    return remoteSettings(remoteConfigPath(ctx.cwd), store, facts);
  }, { id: 'remote', title: 'Remote' });
}
