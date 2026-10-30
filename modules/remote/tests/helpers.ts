import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import WebSocket from 'ws';
import { RemoteClient, type ClientState } from '../src/client.js';
import { RemoteHub, certificateFingerprint, type Inbound } from '../src/hub.js';
import { REMOTE_PATH, authProof, type PeerInfo, type RosterEntry } from '../src/protocol.js';

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
export const tlsFixture = { cert: fixture('test-cert.pem'), key: fixture('test-key.pem') };
export const otherTlsFixture = { cert: fixture('other-cert.pem'), key: fixture('other-key.pem') };
export const fingerprintOf = certificateFingerprint;

export const peer = (name: string, instanceId = `I-${name}`): PeerInfo => ({ name, platform: 'linux', arch: 'x64', hostname: 'host', project: 'repo', instanceId });

/** Resolves when `condition` holds after any change; fails loudly instead of hanging when it never does. */
export class Changes {
  private listeners = new Set<() => void>();
  notify = (): void => { for (const listener of [...this.listeners]) listener(); };
  until(condition: () => boolean, label: string, ms = 10000): Promise<void> {
    if (condition()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners.delete(check); reject(new Error(`Timed out waiting for: ${label}`)); }, ms);
      const check = () => { if (condition()) { clearTimeout(timer); this.listeners.delete(check); resolve(); } };
      this.listeners.add(check);
    });
  }
}

export interface HubFixture { hub: RemoteHub; port: number; inbox: Inbound[]; rosters: RosterEntry[][]; changes: Changes }
export async function startHub(t: TestContext, options: { code: string; name?: string; tls?: boolean | typeof otherTlsFixture; port?: number; now?: () => number }): Promise<HubFixture> {
  const inbox: Inbound[] = [], rosters: RosterEntry[][] = [], changes = new Changes();
  const tls = options.tls === true ? tlsFixture : options.tls || undefined;
  const hub = new RemoteHub({
    self: peer(options.name ?? 'srv'), code: options.code, port: options.port ?? 0, bind: '127.0.0.1', ...(tls ? { tls } : {}), ...(options.now ? { now: options.now } : {}),
    onMessage: message => { inbox.push(message); changes.notify(); }, onRoster: peers => { rosters.push(peers); changes.notify(); },
  });
  const { port } = await hub.start();
  t.after(() => hub.stop());
  return { hub, port, inbox, rosters, changes };
}

export interface ClientFixture { client: RemoteClient; inbox: Inbound[]; states: ClientState[]; peers: () => string[]; changes: Changes; connected: () => Promise<void> }
export function startClient(t: TestContext, options: { port: number; code: string; name: string; instanceId?: string; tls?: boolean; backoff?: (attempt: number) => number }): ClientFixture {
  const inbox: Inbound[] = [], states: ClientState[] = [], changes = new Changes();
  let roster: RosterEntry[] = [];
  const client = new RemoteClient({
    host: '127.0.0.1', port: options.port, tls: options.tls ?? false, code: options.code, self: peer(options.name, options.instanceId),
    backoff: options.backoff ?? (() => 5),
    onMessage: message => { inbox.push(message); changes.notify(); },
    onRoster: peers => { roster = peers; changes.notify(); },
    onState: state => { states.push(state); changes.notify(); },
  });
  client.start();
  t.after(() => client.stop());
  return { client, inbox, states, peers: () => roster.map(entry => entry.name), changes, connected: () => changes.until(() => client.state === 'connected', `${options.name} connected`) };
}

/** A bare protocol-level connection, for handshake and abuse cases the real client never produces. */
export class RawPeer {
  readonly frames: Array<Record<string, unknown>> = [];
  private changes = new Changes();
  closed = false;
  constructor(readonly socket: WebSocket) {
    socket.on('message', data => { this.frames.push(JSON.parse(data.toString())); this.changes.notify(); });
    socket.on('close', () => { this.closed = true; this.changes.notify(); });
    socket.on('error', () => { this.closed = true; this.changes.notify(); });
  }
  static open(t: TestContext, port: number, tls = false): RawPeer {
    const socket = new WebSocket(`${tls ? 'wss' : 'ws'}://127.0.0.1:${port}${REMOTE_PATH}`, { rejectUnauthorized: false });
    t.after(() => socket.terminate());
    return new RawPeer(socket);
  }
  async frame(type: string): Promise<Record<string, unknown>> {
    await this.changes.until(() => this.frames.some(f => f.t === type) || this.closed, `frame ${type}`);
    const found = this.frames.find(f => f.t === type);
    if (!found) throw new Error(`Closed before a ${type} frame; saw ${JSON.stringify(this.frames)}`);
    return found;
  }
  until(condition: () => boolean, label: string): Promise<void> { return this.changes.until(condition, label); }
  send(value: unknown): void { this.socket.send(typeof value === 'string' ? value : JSON.stringify(value)); }
  /** Completes the handshake with an explicit proof recipe and returns the resulting frame (welcome or error). */
  async hello(options: { name: string; instanceId?: string; code: string; fingerprint?: string; proof?: string }): Promise<Record<string, unknown>> {
    const challenge = await this.frame('challenge');
    const proof = options.proof ?? authProof(options.code, challenge.nonce as string, options.name, options.fingerprint ?? '');
    this.send({ t: 'hello', v: 1, proof, info: peer(options.name, options.instanceId) });
    await this.until(() => this.frames.some(f => f.t === 'welcome' || f.t === 'error') || this.closed, 'welcome or error');
    return this.frames.find(f => f.t === 'welcome' || f.t === 'error') ?? { t: 'closed' };
  }
}
