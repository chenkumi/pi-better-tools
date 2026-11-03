import { resolve } from 'node:path';
import { asRecord, str } from '../fold/util.ts';
import { scanLines } from './lines.ts';

export class SessionReadError extends Error {}

/** A tool argument that must be a safe integer of at least `min`; anything else is reported to the model under the argument's name. */
export const integer = (value: unknown, name: string, min: number): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new SessionReadError(`"${name}" must be an integer >= ${min}.`);
  return value;
};

export interface SessionFile { id: string; file: string }

const MAX_ANCESTORS = 16;
const MAX_HEADER_BYTES = 64 * 1024;

/** The first line of a session file, if it is a session header. Anything else (not a session, unreadable) yields undefined. */
export async function readHeader(file: string): Promise<{ id: string; parentSession?: string } | undefined> {
  try {
    for await (const first of scanLines(file, 1, 1)) {
      if (first.text === undefined || first.bytes > MAX_HEADER_BYTES) return undefined;
      const header = asRecord(JSON.parse(first.text));
      const id = str(header?.id);
      const parent = str(header?.parentSession);
      return header?.type === 'session' && id ? { id, ...(parent ? { parentSession: parent } : {}) } : undefined;
    }
  } catch { /* unreadable or not JSON */ }
  return undefined;
}

/**
 * The sessions the tool may read: the current one first, then its ancestors following each header's `parentSession`. A file is
 * only followed when its first line is a session header, and the walk stops at a cycle or after a fixed depth, so a crafted
 * `parentSession` cannot turn the tool into a general file reader or loop forever.
 */
export async function resolveReadableSessions(current: { id: string; file: string | undefined }): Promise<SessionFile[]> {
  if (!current.file) return [];
  const chain: SessionFile[] = [{ id: current.id, file: resolve(current.file) }];
  const seen = new Set([chain[0]!.file.toLowerCase()]);
  let header = await readHeader(chain[0]!.file);
  while (header?.parentSession && chain.length <= MAX_ANCESTORS) {
    const file = resolve(header.parentSession);
    if (!/\.jsonl$/i.test(file) || seen.has(file.toLowerCase())) break;
    seen.add(file.toLowerCase());
    const parent = await readHeader(file);
    if (!parent) break;
    chain.push({ id: parent.id, file });
    header = parent;
  }
  return chain;
}

/** The session a call addresses: the current one by default, else one of the readable ancestors. Anything else is refused. */
export function pickSession(readable: readonly SessionFile[], sessionId: string | undefined): SessionFile {
  if (readable.length === 0) throw new SessionReadError('This session has no session file (it is not persisted), so there is nothing to read.');
  const target = sessionId === undefined ? readable[0] : readable.find(item => item.id === sessionId);
  if (!target) throw new SessionReadError(`Session ${JSON.stringify(String(sessionId).slice(0, 80))} is not readable here. Readable sessions: ${readable.map(item => item.id).join(', ')}.`);
  return target;
}

export const isCurrent = (readable: readonly SessionFile[], target: SessionFile): boolean => target === readable[0];
