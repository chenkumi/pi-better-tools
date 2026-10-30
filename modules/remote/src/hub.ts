import { randomBytes, X509Certificate } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import {
  LIMITS, PROTOCOL_VERSION, REMOTE_PATH, authProof, cleanBody, frame, normalizeName, parseClientFrame, proofMatches,
  type AckStatus, type ClientFrame, type GitInfo, type Kind, type PeerInfo, type RosterEntry, type ServerFrame,
} from './protocol.js';

export interface Inbound { id: string; from: string; kind: Kind; body: string; git?: GitInfo; replyTo?: string }
export type SendFrame = Extract<ClientFrame, { t: 'send' }>;
export type Ack = Extract<ServerFrame, { t: 'ack' }>;
export interface HubOptions {
  /** This session's own peer: the server is also a client of its network. */
  self: PeerInfo;
  /** Pairing code; only keyed proofs derived from it cross the wire. */
  code: string;
  port: number;
  bind: string;
  tls?: { cert: string | Buffer; key: string | Buffer };
  onMessage: (message: Inbound) => void;
  onRoster: (peers: RosterEntry[]) => void;
  now?: () => number;
}

/** Failed handshakes per remote address: five in a minute blocks that address for a minute; thirty overall pause everyone. */
const FAIL_LIMIT = 5, FAIL_WINDOW_MS = 60000, BLOCK_MS = 60000, GLOBAL_LIMIT = 30, GLOBAL_BLOCK_MS = 30000, TRACKED_ADDRESSES = 1024;
const HEARTBEAT_MS = 15000;

interface Member { info: PeerInfo; sent: number[]; alive: boolean; socket?: WebSocket; deliver(message: ServerFrame): boolean }

export const certificateFingerprint = (cert: string | Buffer): string => new X509Certificate(cert).fingerprint256.replace(/:/g, '').toLowerCase();

/** Star topology hub. Delivery is at-most-once: an `ack` means the target's socket accepted the frame, nothing more. */
export class RemoteHub {
  private members = new Map<string, Member>();
  private failures = new Map<string, { times: number[]; blockedUntil: number }>();
  private globalFailures: number[] = [];
  private globalBlockedUntil = 0;
  private pending = 0;
  private server?: http.Server | https.Server;
  private wss?: WebSocketServer;
  private heartbeat?: NodeJS.Timeout;
  private readonly fingerprint: string;
  private readonly now: () => number;
  private self!: Member;

  constructor(private readonly options: HubOptions) {
    this.now = options.now ?? Date.now;
    this.fingerprint = options.tls ? certificateFingerprint(options.tls.cert) : '';
  }

  async start(): Promise<{ port: number; bind: string; tls: boolean }> {
    this.self = { info: this.options.self, sent: [], alive: true, deliver: message => { if (message.t === 'deliver') this.options.onMessage({ id: message.id, from: message.from, kind: message.kind, body: message.body, ...(message.git ? { git: message.git } : {}), ...(message.replyTo ? { replyTo: message.replyTo } : {}) }); return true; } };
    this.members.set(this.self.info.name, this.self);
    const server = this.options.tls ? https.createServer({ cert: this.options.tls.cert, key: this.options.tls.key }) : http.createServer();
    server.on('request', (_request, response) => { response.writeHead(426, { Connection: 'close' }); response.end(); });
    server.headersTimeout = 10000;
    server.maxConnections = 64;
    const wss = new WebSocketServer({ server, path: REMOTE_PATH, maxPayload: LIMITS.frameBytes, perMessageDeflate: false });
    wss.on('connection', (socket, request) => this.accept(socket, request.socket.remoteAddress ?? 'unknown'));
    wss.on('error', () => undefined);
    this.server = server;
    this.wss = wss;
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.options.port, this.options.bind, () => { server.off('error', reject); resolve(); }); });
    } catch (error) {
      await this.stop();
      throw error;
    }
    server.on('error', () => undefined);
    this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS);
    this.heartbeat.unref();
    return { port: (server.address() as AddressInfo).port, bind: this.options.bind, tls: Boolean(this.options.tls) };
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    const { server, wss } = this;
    this.server = this.wss = undefined;
    this.members.clear();
    if (!server) return;
    for (const client of wss?.clients ?? []) client.terminate();
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    wss?.close();
    await closed;
  }

  roster(): RosterEntry[] {
    return [...this.members.values()].map(({ info: { instanceId: _ignored, ...entry } }) => entry);
  }

  /** The server's own session sends through the same routing as any peer. */
  send(message: SendFrame): Ack { return this.route(this.self, message); }

  // --- handshake -----------------------------------------------------------------------------------------------
  private blocked(address: string): boolean {
    const now = this.now();
    return now < this.globalBlockedUntil || now < (this.failures.get(address)?.blockedUntil ?? 0);
  }
  private fail(address: string): void {
    const now = this.now();
    const entry = this.failures.get(address) ?? { times: [], blockedUntil: 0 };
    entry.times = [...entry.times.filter(t => now - t < FAIL_WINDOW_MS), now];
    if (entry.times.length >= FAIL_LIMIT) { entry.blockedUntil = now + BLOCK_MS; entry.times = []; }
    this.failures.delete(address);
    this.failures.set(address, entry);
    if (this.failures.size > TRACKED_ADDRESSES) this.failures.delete(this.failures.keys().next().value!);
    this.globalFailures = [...this.globalFailures.filter(t => now - t < FAIL_WINDOW_MS), now];
    if (this.globalFailures.length >= GLOBAL_LIMIT) { this.globalBlockedUntil = now + GLOBAL_BLOCK_MS; this.globalFailures = []; }
  }

  private accept(socket: WebSocket, address: string): void {
    const refuse = (code: 'blocked' | 'full') => { socket.send(frame({ t: 'error', code }), () => socket.close(1008)); };
    if (this.blocked(address)) return refuse('blocked');
    if (this.pending >= LIMITS.maxPending) return refuse('full');
    this.pending += 1;
    const nonce = randomBytes(16).toString('hex');
    let released = false;
    let member: Member | undefined;
    const release = () => { if (!released) { released = true; this.pending -= 1; clearTimeout(timer); } };
    const timer = setTimeout(() => { this.fail(address); socket.terminate(); }, LIMITS.authTimeoutMs);
    const reject = (code: 'auth_failed' | 'protocol') => { this.fail(address); release(); socket.send(frame({ t: 'error', code }), () => socket.close(1008)); };
    socket.on('error', () => undefined);
    socket.on('pong', () => { if (member) member.alive = true; });
    socket.on('close', () => {
      release();
      if (member && this.members.get(member.info.name) === member) { this.members.delete(member.info.name); this.broadcastRoster(); }
    });
    socket.on('message', (data, isBinary) => {
      if (isBinary) { if (!member) return reject('protocol'); return socket.close(1003); }
      let message: ClientFrame;
      try { message = parseClientFrame(data.toString()); } catch { return member ? socket.close(1002) : reject('protocol'); }
      if (!member) {
        if (message.t !== 'hello') return reject('protocol');
        if (message.v !== PROTOCOL_VERSION) return reject('protocol');
        let expected: string;
        try { expected = authProof(this.options.code, nonce, message.info.name, this.fingerprint); } catch { return reject('auth_failed'); }
        if (!proofMatches(message.proof, expected)) return reject('auth_failed');
        const joined = this.admit(socket, message.info);
        if (!joined) { release(); socket.send(frame({ t: 'error', code: 'full' }), () => socket.close(1008)); return; }
        release();
        member = joined;
        socket.send(frame({ t: 'welcome', name: joined.info.name, peers: this.roster() }));
        this.broadcastRoster();
        return;
      }
      if (message.t !== 'send') return socket.close(1002);
      const ack = this.route(member, message);
      socket.send(frame(ack));
    });
    socket.send(frame({ t: 'challenge', v: PROTOCOL_VERSION, nonce }));
  }

  /** The name is the peer's request; a taken name gets a numeric suffix unless the same instance is reconnecting. */
  private admit(socket: WebSocket, info: PeerInfo): Member | undefined {
    let name = info.name;
    const existing = this.members.get(name);
    if (existing?.socket && existing.info.instanceId === info.instanceId) {
      // The same instance reconnecting before the hub noticed the old socket died: the new connection takes over.
      this.members.delete(name);
      existing.socket.terminate();
    } else if (existing) {
      name = '';
      for (let n = 2; n < 100 && !name; n += 1) {
        const suffix = `-${n}`;
        const candidate = `${info.name.slice(0, 24 - suffix.length)}${suffix}`;
        if (!this.members.has(candidate)) name = candidate;
      }
    }
    if (!name || this.members.size >= LIMITS.maxPeers) return undefined;
    const member: Member = {
      info: { ...info, name }, sent: [], alive: true, socket,
      deliver: message => {
        if (socket.readyState !== WebSocket.OPEN) return false;
        if (socket.bufferedAmount > LIMITS.bufferedBytes) { socket.terminate(); return false; }
        socket.send(frame(message));
        return true;
      },
    };
    this.members.set(name, member);
    return member;
  }

  private broadcastRoster(): void {
    const peers = this.roster();
    const message = frame({ t: 'roster', peers });
    for (const member of this.members.values()) {
      if (member.socket?.readyState === WebSocket.OPEN) member.socket.send(message);
    }
    this.options.onRoster(peers);
  }

  private beat(): void {
    for (const member of [...this.members.values()]) {
      if (!member.socket) continue;
      if (!member.alive) { member.socket.terminate(); continue; }
      member.alive = false;
      member.socket.ping();
    }
  }

  // --- routing -------------------------------------------------------------------------------------------------
  private route(from: Member, message: SendFrame): Ack {
    const ack = (status: AckStatus, count?: number): Ack => ({ t: 'ack', id: message.id, status, ...(count === undefined ? {} : { count }) });
    const now = this.now();
    from.sent = from.sent.filter(t => now - t < LIMITS.sendWindowMs);
    if (from.sent.length >= LIMITS.sendBurst) return ack('rate_limited');
    from.sent.push(now);
    if (message.body.length > LIMITS.bodyChars) return ack('too_large');
    const body = cleanBody(message.body);
    if (!body.trim()) return ack('rejected');
    const deliver: ServerFrame = { t: 'deliver', id: message.id, from: from.info.name, kind: message.kind, body, ...(message.git ? { git: message.git } : {}), ...(message.replyTo ? { replyTo: message.replyTo } : {}) };
    if (message.to === '*') {
      let count = 0;
      for (const member of [...this.members.values()]) if (member !== from && member.deliver(deliver)) count += 1;
      return count ? ack('delivered', count) : ack('offline', 0);
    }
    const target = normalizeName(message.to);
    const member = target ? this.members.get(target) : undefined;
    if (member === from) return ack('rejected');
    if (!member) return ack('offline');
    return member.deliver(deliver) ? ack('delivered', 1) : ack('offline');
  }
}
