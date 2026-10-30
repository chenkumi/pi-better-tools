import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { generateCode, normalizeCode } from './protocol.js';

interface Stored { version: 1; serverCode?: string; clients?: Record<string, string> }
export const credentialsPath = () => join(getAgentDir(), 'pi-remote.json');

/**
 * Pairing codes live in the user's agent directory, never in the project (`remote.json` may be committed). The server
 * keeps one code that survives restarts until regenerated; a client keeps the code per `host:port`. Not encrypted:
 * the file is written owner-only where the platform supports it, like other Pi credentials.
 */
export class CredentialStore {
  constructor(private readonly path: string = credentialsPath()) {}

  private async read(): Promise<Stored> {
    let contents: string;
    try { contents = await readFile(this.path, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1 };
      throw error;
    }
    // A damaged file is reported, never overwritten: it may hold other clients' codes.
    let parsed: unknown;
    try { parsed = JSON.parse(contents); } catch { throw new Error(`Remote credentials file is not valid JSON: ${this.path}`); }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Remote credentials file must be a JSON object: ${this.path}`);
    return { version: 1, ...(parsed as Partial<Stored>) };
  }
  private async write(data: Stored): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }

  /** The server's code, created on first use. */
  async serverCode(): Promise<string> {
    const data = await this.read();
    if (data.serverCode && normalizeCode(data.serverCode)) return data.serverCode;
    return this.regenerateServerCode(data);
  }
  /** The stored server code, without creating one (the settings panel generates a candidate itself and stores it on Save). */
  async peekServerCode(): Promise<string | undefined> {
    const { serverCode } = await this.read();
    return serverCode && normalizeCode(serverCode) ? serverCode : undefined;
  }
  /** Stores a code chosen in the settings panel. A different code than before revokes every client paired with the old one. */
  async saveServerCode(code: string): Promise<void> {
    const normalized = normalizeCode(code);
    if (!normalized) throw new Error('The pairing code must be 12 letters and digits, for example ABCD-EFGH-JKLM.');
    await this.write({ ...await this.read(), serverCode: normalized.replace(/(.{4})(?=.)/g, '$1-') });
  }
  /** A new code revokes every client that paired with the old one (they are refused on their next connect). */
  async regenerateServerCode(data?: Stored): Promise<string> {
    const current = data ?? await this.read();
    const serverCode = generateCode();
    await this.write({ ...current, serverCode });
    return serverCode;
  }
  async clientCode(endpoint: string): Promise<string | undefined> {
    const code = (await this.read()).clients?.[endpoint];
    return code && normalizeCode(code) ? code : undefined;
  }
  async saveClientCode(endpoint: string, code: string): Promise<void> {
    const normalized = normalizeCode(code);
    if (!normalized) throw new Error('The pairing code must be 12 letters and digits, for example ABCD-EFGH-JKLM.');
    const data = await this.read();
    await this.write({ ...data, clients: { ...data.clients, [endpoint]: normalized } });
  }
}
