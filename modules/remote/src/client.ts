import type { TLSSocket } from 'node:tls';
import WebSocket from 'ws';
import type { Inbound, SendFrame } from './hub.js';
import {
  LIMITS, PROTOCOL_VERSION, REMOTE_PATH, authProof, frame, parseServerFrame,
  type AckStatus, type PeerInfo, type RosterEntry, type ServerFrame,
} from './protocol.js';

export type ClientState = 'connecting' | 'connected' | 'reconnecting' | 'auth_failed' | 'stopped';
export interface ClientOptions {
  host: string;
  port: number;
  tls: boolean;
  code: string;
  /** The peer this session wants to be; the hub may add a numeric suffix to the name. */
  self: PeerInfo;
  onMessage: (message: Inbound) => void;
  onRoster: (peers: RosterEntry[], name: string) => void;
  onState: (state: ClientState, detail?: string) => void;
  /** Reconnect delay in ms for attempt n (0-based); injectable so tests need no real waiting. */
  backoff?: (attempt: number) => number;
}
export const defaultBackoff = (attempt: number) => Math.min(30000, 1000 * 2 ** attempt) * (0.5 + Math.random() / 2);
/** No frame, ping or pong from the hub for this long means the link is dead. */
const SILENCE_MS = 45000;

const hostForUrl = (host: string) => (host.includes(':') && !host.startsWith('[') ? `[${host}]` : host);

export class RemoteClient {
  state: ClientState = 'connecting';
  name: string;
  private socket?: WebSocket;
  private attempt = 0;
  private retry?: NodeJS.Timeout;
  private silence?: NodeJS.Timeout;
  private stopped = false;
  private waiting = new Map<string, { resolve: (ack: { status: AckStatus; count?: number }) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly options: ClientOptions) { this.name = options.self.name; }

  start(): void { this.connect(); }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    clearTimeout(this.silence);
    this.setState('stopped');
    this.socket?.removeAllListeners('close');
    this.socket?.terminate();
    this.socket = undefined;
    this.settleAll();
  }

  /** Resolves with the hub's ack, or `unknown` when the link drops or no ack arrives in time (the message may still have been delivered). */
  send(message: SendFrame): Promise<{ status: AckStatus; count?: number }> {
    const socket = this.socket;
    if (this.state !== 'connected' || !socket || socket.readyState !== WebSocket.OPEN) return Promise.resolve({ status: 'offline' });
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.waiting.delete(message.id); resolve({ status: 'unknown' }); }, LIMITS.ackTimeoutMs);
      timer.unref();
      this.waiting.set(message.id, { resolve, timer });
      socket.send(frame(message), error => { if (error && this.waiting.delete(message.id)) { clearTimeout(timer); resolve({ status: 'unknown' }); } });
    });
  }

  private setState(state: ClientState, detail?: string): void {
    this.state = state;
    this.options.onState(state, detail);
  }
  private settleAll(): void {
    for (const { resolve, timer } of this.waiting.values()) { clearTimeout(timer); resolve({ status: 'unknown' }); }
    this.waiting.clear();
  }
  private touch(): void {
    clearTimeout(this.silence);
    this.silence = setTimeout(() => this.socket?.terminate(), SILENCE_MS);
    this.silence.unref();
  }

  private connect(): void {
    if (this.stopped) return;
    const { host, port, tls, code, self } = this.options;
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const socket = new WebSocket(`${tls ? 'wss' : 'ws'}://${hostForUrl(host)}:${port}${REMOTE_PATH}`, {
      perMessageDeflate: false, followRedirects: false, maxPayload: LIMITS.frameBytes, handshakeTimeout: 10000,
      // A LAN hub usually presents a self-signed certificate. Trust comes from the pairing proof, which binds the
      // certificate fingerprint seen on this connection: a different (intercepting) certificate fails the proof.
      ...(tls ? { rejectUnauthorized: false } : {}),
    });
    this.socket = socket;
    let fingerprint = '';
    let authFailed = false;
    socket.on('upgrade', response => {
      if (tls) fingerprint = (response.socket as TLSSocket).getPeerCertificate().fingerprint256?.replace(/:/g, '').toLowerCase() ?? '';
    });
    socket.on('error', () => undefined);
    socket.on('ping', () => this.touch());
    socket.on('close', () => {
      clearTimeout(this.silence);
      this.settleAll();
      if (this.stopped || this.socket !== socket) return;
      this.socket = undefined;
      if (authFailed) return;
      const delay = (this.options.backoff ?? defaultBackoff)(this.attempt);
      this.attempt += 1;
      this.setState('reconnecting');
      this.retry = setTimeout(() => this.connect(), delay);
      this.retry.unref();
    });
    socket.on('message', (data, isBinary) => {
      if (isBinary) return socket.close(1003);
      this.touch();
      let message: ServerFrame;
      try { message = parseServerFrame(data.toString()); } catch { return socket.close(1002); }
      switch (message.t) {
        case 'challenge': {
          if (message.v !== PROTOCOL_VERSION) { authFailed = true; this.setState('auth_failed', 'The hub speaks a different protocol version.'); return socket.close(1002); }
          socket.send(frame({ t: 'hello', v: PROTOCOL_VERSION, proof: authProof(code, message.nonce, self.name, fingerprint), info: self }));
          return;
        }
        case 'welcome':
          this.attempt = 0;
          this.name = message.name;
          this.setState('connected');
          this.options.onRoster(message.peers, this.name);
          return;
        case 'roster': return this.options.onRoster(message.peers, this.name);
        case 'deliver': return this.options.onMessage({ id: message.id, from: message.from, kind: message.kind, body: message.body, ...(message.git ? { git: message.git } : {}), ...(message.replyTo ? { replyTo: message.replyTo } : {}) });
        case 'ack': {
          const waiter = this.waiting.get(message.id);
          if (!waiter) return;
          this.waiting.delete(message.id);
          clearTimeout(waiter.timer);
          waiter.resolve({ status: message.status, ...(message.count === undefined ? {} : { count: message.count }) });
          return;
        }
        case 'error':
          if (message.code === 'auth_failed') { authFailed = true; this.setState('auth_failed', 'The hub rejected the pairing code.'); }
          // blocked/full are transient: the normal reconnect backoff applies after the hub closes the socket.
          return;
      }
    });
  }
}
