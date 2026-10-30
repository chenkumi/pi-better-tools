import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export const PROTOCOL_VERSION = 1;
export const REMOTE_PATH = '/remote';
export const LIMITS = {
  /** WebSocket frame cap (ws `maxPayload`); a body is further limited to `bodyChars`. */
  frameBytes: 65536,
  bodyChars: 32000,
  fieldChars: 200,
  maxPeers: 16,
  /** Unauthenticated connections held at once, and how long one may stay unauthenticated. */
  maxPending: 8,
  authTimeoutMs: 5000,
  /** Per peer: at most `sendBurst` messages per `sendWindowMs`. */
  sendBurst: 30,
  sendWindowMs: 10000,
  /** Close a peer whose socket buffer grows past this (slow or stalled reader). */
  bufferedBytes: 1048576,
  ackTimeoutMs: 10000,
  receipts: 64,
} as const;

export type Kind = 'message' | 'sync';
export type AckStatus = 'delivered' | 'offline' | 'rejected' | 'too_large' | 'rate_limited' | 'unknown';
export interface GitInfo { branch?: string; commit?: string; remote?: string }
/** What the hub shares about each peer. Free-text fields are display data only and never enter a system prompt. */
export interface RosterEntry { name: string; platform: string; arch: string; hostname: string; project: string }
export interface PeerInfo extends RosterEntry { instanceId: string }

export type ClientFrame =
  | { t: 'hello'; v: number; proof: string; info: PeerInfo }
  | { t: 'send'; id: string; to: string; kind: Kind; body: string; git?: GitInfo; replyTo?: string };
export type ServerFrame =
  | { t: 'challenge'; v: number; nonce: string }
  | { t: 'welcome'; name: string; peers: RosterEntry[] }
  | { t: 'roster'; peers: RosterEntry[] }
  | { t: 'deliver'; id: string; from: string; kind: Kind; body: string; git?: GitInfo; replyTo?: string }
  | { t: 'ack'; id: string; status: AckStatus; count?: number }
  | { t: 'error'; code: 'auth_failed' | 'protocol' | 'full' | 'blocked' };

export class ProtocolError extends Error {}
const bad = (what: string): never => { throw new ProtocolError(what); };
const obj = (v: unknown, what: string): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : bad(`${what}: expected an object`));
const str = (v: unknown, what: string, max: number, min = 1): string => (typeof v === 'string' && v.length >= min && v.length <= max ? v : bad(`${what}: expected a string of ${min}-${max} characters`));

/** Display text: control characters become spaces, then trim and cap. */
export function cleanText(value: unknown, max: number = LIMITS.fieldChars): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim().slice(0, max);
}
/** Message body: keeps line breaks and tabs, drops other control characters. */
export function cleanBody(value: string): string { return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''); }

const NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;
/** Peer names are lower-case `[a-z0-9-]`, at most 24 characters: safe to show anywhere, including a system prompt. */
export function normalizeName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim().toLowerCase();
  return NAME.test(name) ? name : undefined;
}
export function randomName(platform: string = process.platform): string {
  const label = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : /^[a-z0-9]{2,12}$/.test(platform) ? platform : 'peer';
  return `${label}-${randomInt(0, 0x10000).toString(16).padStart(4, '0')}`;
}
function parseGit(value: unknown): GitInfo | undefined {
  if (value === undefined) return undefined;
  const raw = obj(value, 'git');
  const git: GitInfo = {};
  for (const key of ['branch', 'commit', 'remote'] as const) {
    if (raw[key] === undefined) continue;
    const text = cleanText(raw[key]);
    if (text) git[key] = text;
  }
  return Object.keys(git).length ? git : undefined;
}
function parseEntry(value: unknown): RosterEntry {
  const raw = obj(value, 'peer');
  const name = normalizeName(raw.name) ?? bad('peer.name');
  return { name, platform: cleanText(raw.platform, 16), arch: cleanText(raw.arch, 16), hostname: cleanText(raw.hostname, 63), project: cleanText(raw.project, 64) };
}
const KINDS = new Set<Kind>(['message', 'sync']);
const STATUSES = new Set<AckStatus>(['delivered', 'offline', 'rejected', 'too_large', 'rate_limited', 'unknown']);

function parseJson(raw: string): Record<string, unknown> {
  if (Buffer.byteLength(raw) > LIMITS.frameBytes) bad('frame too large');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return bad('not JSON'); }
  return obj(value, 'frame');
}
function parseMessageFields(raw: Record<string, unknown>) {
  const kind = raw.kind as Kind;
  if (!KINDS.has(kind)) bad('kind');
  const body = typeof raw.body === 'string' ? raw.body : bad('body');
  const git = parseGit(raw.git);
  const replyTo = raw.replyTo === undefined ? undefined : str(raw.replyTo, 'replyTo', 64);
  return { kind, body, ...(git ? { git } : {}), ...(replyTo ? { replyTo } : {}) };
}

export function parseClientFrame(text: string): ClientFrame {
  const raw = parseJson(text);
  if (raw.t === 'hello') {
    const info = obj(raw.info, 'info');
    const entry = parseEntry(info);
    return { t: 'hello', v: typeof raw.v === 'number' ? raw.v : bad('v'), proof: str(raw.proof, 'proof', 64, 64), info: { ...entry, instanceId: str(info.instanceId, 'instanceId', 64) } };
  }
  if (raw.t === 'send') return { t: 'send', id: str(raw.id, 'id', 64), to: str(raw.to, 'to', 24), ...parseMessageFields(raw) };
  return bad('unknown frame');
}
export function parseServerFrame(text: string): ServerFrame {
  const raw = parseJson(text);
  const peers = (value: unknown) => (Array.isArray(value) && value.length <= LIMITS.maxPeers ? value.map(parseEntry) : bad('peers'));
  switch (raw.t) {
    case 'challenge': return { t: 'challenge', v: typeof raw.v === 'number' ? raw.v : bad('v'), nonce: str(raw.nonce, 'nonce', 64, 16) };
    case 'welcome': return { t: 'welcome', name: normalizeName(raw.name) ?? bad('name'), peers: peers(raw.peers) };
    case 'roster': return { t: 'roster', peers: peers(raw.peers) };
    case 'deliver': return { t: 'deliver', id: str(raw.id, 'id', 64), from: normalizeName(raw.from) ?? bad('from'), ...parseMessageFields(raw) };
    case 'ack': return { t: 'ack', id: str(raw.id, 'id', 64), status: STATUSES.has(raw.status as AckStatus) ? raw.status as AckStatus : bad('status'), ...(typeof raw.count === 'number' ? { count: raw.count } : {}) };
    case 'error': return { t: 'error', code: (['auth_failed', 'protocol', 'full', 'blocked'] as const).includes(raw.code as never) ? raw.code as 'protocol' : bad('code') };
    default: return bad('unknown frame');
  }
}

// --- pairing code -----------------------------------------------------------------------------------------------
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols, no 0/O/1/I
/** 12 symbols = 60 bits, shown as XXXX-XXXX-XXXX. Never sent over the wire; only a keyed proof is. */
export function generateCode(): string {
  const symbols = Array.from({ length: 12 }, () => ALPHABET[randomInt(0, ALPHABET.length)]!);
  return [0, 4, 8].map(i => symbols.slice(i, i + 4).join('')).join('-');
}
export function normalizeCode(value: string): string | undefined {
  const code = value.toUpperCase().replace(/[\s-]/g, '');
  return code.length === 12 && [...code].every(c => ALPHABET.includes(c)) ? code : undefined;
}
/**
 * Challenge-response proof. Binding the TLS certificate fingerprint (empty for plain ws) means a self-signed
 * certificate needs no trust-on-first-use step: a man in the middle presents a different certificate, so the
 * proof the client computes cannot verify at the real server.
 */
export function authProof(code: string, nonce: string, name: string, fingerprint: string): string {
  const key = normalizeCode(code) ?? bad('pairing code');
  return createHmac('sha256', key).update(['pi-remote', PROTOCOL_VERSION, nonce, name, fingerprint].join('\n')).digest('hex');
}
export function proofMatches(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex'), right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}
export const frame = (value: ClientFrame | ServerFrame): string => JSON.stringify(value);
