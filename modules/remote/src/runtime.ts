import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, resolve } from 'node:path';
import { ulid } from 'ulid';
import { RemoteClient, type ClientState } from './client.js';
import type { RemoteConfig } from './config.js';
import type { CredentialStore } from './credentials.js';
import { RemoteHub, type Inbound, type SendFrame } from './hub.js';
import { LIMITS, cleanText, normalizeName, type AckStatus, type GitInfo, type Kind, type PeerInfo, type RosterEntry } from './protocol.js';

export type RemoteState = 'starting' | 'listening' | 'connecting' | 'connected' | 'reconnecting' | 'auth_failed' | 'needs_code' | 'fault' | 'stopped';
export interface RemoteStatus { role: 'server' | 'client'; state: RemoteState; name: string; address?: string; peers: number; secure: boolean; detail?: string }
export interface Receipt { id: string; to: string; kind: Kind; status: AckStatus; count?: number; at: string }
export interface RuntimeDeps {
  cwd: string;
  credentials: CredentialStore;
  /** Stable for the life of the extension instance, so a reload keeps the same peer name and instance. */
  identity: { name: string; instanceId: string };
  onMessage: (message: Inbound) => void;
  onChange?: () => void;
  backoff?: (attempt: number) => number;
}
export interface SendInput { to: string; message: string; kind?: Kind; git?: GitInfo; replyTo?: string }

/** One session's membership: a server (hub plus its own peer) or a client of someone else's hub. */
export class RemoteRuntime {
  private state: RemoteState = 'starting';
  private detail?: string;
  private address?: string;
  private secure = false;
  private roster: RosterEntry[] = [];
  private hub?: RemoteHub;
  private client?: RemoteClient;
  private readonly sent = new Map<string, Receipt>();
  private readonly self: PeerInfo;

  constructor(private readonly config: RemoteConfig, private readonly deps: RuntimeDeps) {
    this.self = {
      name: config.name ?? deps.identity.name, platform: process.platform, arch: process.arch,
      hostname: cleanText(hostname(), 63), project: cleanText(basename(deps.cwd), 64), instanceId: deps.identity.instanceId,
    };
  }

  private set(state: RemoteState, detail?: string): void {
    this.state = state;
    this.detail = detail;
    this.deps.onChange?.();
  }

  /** Never throws: a failure becomes the `fault` state with a reason, and Remote does not fall back to another role. */
  async start(): Promise<void> {
    try {
      if (this.config.mode === 'server') await this.startServer();
      else await this.startClient();
    } catch (error) {
      await this.stop();
      this.set('fault', (error as Error).message);
    }
  }

  private async startServer(): Promise<void> {
    const { server } = this.config;
    if (!server) throw new Error('server settings are missing');
    const code = await this.deps.credentials.serverCode();
    const tls = server.tls ? { cert: await readFile(resolve(this.deps.cwd, server.tls.cert)), key: await readFile(resolve(this.deps.cwd, server.tls.key)) } : undefined;
    const hub = new RemoteHub({
      self: this.self, code, port: server.port, bind: server.bind, ...(tls ? { tls } : {}),
      onMessage: message => this.deps.onMessage(message),
      onRoster: peers => { this.roster = peers; this.deps.onChange?.(); },
    });
    const listening = await hub.start();
    this.hub = hub;
    this.roster = hub.roster();
    this.secure = listening.tls;
    this.address = `${listening.tls ? 'wss' : 'ws'}://${listening.bind}:${listening.port}`;
    this.set('listening');
  }

  private async startClient(): Promise<void> {
    const { client } = this.config;
    if (!client) throw new Error('client settings are missing');
    const code = await this.deps.credentials.clientCode(`${client.host}:${client.port}`);
    this.secure = client.tls;
    this.address = `${client.tls ? 'wss' : 'ws'}://${client.host}:${client.port}`;
    if (!code) { this.set('needs_code', 'No pairing code for this server yet. Enter the code shown on the server.'); return; }
    this.client = new RemoteClient({
      host: client.host, port: client.port, tls: client.tls, code, self: this.self,
      onMessage: message => this.deps.onMessage(message),
      onRoster: peers => { this.roster = peers; this.deps.onChange?.(); },
      onState: (state: ClientState, detail) => { if (state !== 'stopped') this.set(state, detail); },
      ...(this.deps.backoff ? { backoff: this.deps.backoff } : {}),
    });
    this.client.start();
  }

  async stop(): Promise<void> {
    const { hub, client } = this;
    this.hub = this.client = undefined;
    client?.stop();
    await hub?.stop();
    this.roster = [];
    this.state = 'stopped';
    this.deps.onChange?.();
  }

  get name(): string { return this.client?.name ?? this.self.name; }

  status(): RemoteStatus {
    return { role: this.config.mode, state: this.state, name: this.name, ...(this.address ? { address: this.address } : {}), peers: this.roster.length, secure: this.secure, ...(this.detail ? { detail: this.detail } : {}) };
  }
  /** Whether messages can be exchanged right now. */
  get online(): boolean { return this.state === 'listening' || this.state === 'connected'; }

  peers(): Array<RosterEntry & { self?: true }> {
    return this.roster.map(peer => (peer.name === this.name ? { ...peer, self: true as const } : peer));
  }

  async send(input: SendInput): Promise<Receipt> {
    if (!this.online) throw new Error(`Remote is not connected (${this.state}). Ask the user to check the Remote status.`);
    const to = input.to === '*' ? '*' : normalizeName(input.to);
    if (!to) throw new Error('"name" must be a peer name from remote_list (lower-case letters, digits and "-"), or "*" for everyone.');
    const message: SendFrame = {
      t: 'send', id: ulid().toUpperCase(), to, kind: input.kind ?? 'message', body: input.message,
      ...(input.git ? { git: input.git } : {}), ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    };
    const ack = this.hub ? this.hub.send(message) : await this.client!.send(message);
    const receipt: Receipt = { id: message.id, to, kind: message.kind, status: ack.status, ...(ack.count === undefined ? {} : { count: ack.count }), at: new Date().toISOString() };
    this.sent.set(receipt.id, receipt);
    if (this.sent.size > LIMITS.receipts) this.sent.delete(this.sent.keys().next().value!);
    return receipt;
  }

  receipts(id?: string): Receipt[] {
    if (id) { const receipt = this.sent.get(id); return receipt ? [receipt] : []; }
    return [...this.sent.values()].reverse();
  }
}
