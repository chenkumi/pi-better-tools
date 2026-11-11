import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { defaults, type Config } from '../src/config.ts';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** The smallest thing the sniffer accepts as a PNG: magic plus an IHDR-sized header carrying the size. */
export function png(width = 2, height = 3, extra = 0): Buffer {
  const head = Buffer.alloc(24 + extra);
  PNG_MAGIC.copy(head); head.writeUInt32BE(width, 16); head.writeUInt32BE(height, 20);
  return head;
}
export const jpeg = (): Buffer => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 3, 0, 2, 1, 1, 0x11, 0]);

export interface Recorded { method: string; url: string; headers: IncomingMessage['headers']; body: string }
export interface TestServer { url: string; requests: Recorded[]; close(): Promise<void> }

/** A local HTTP server on a free port; `handler` answers each request. Used as the injected provider endpoint. */
export async function startServer(t: TestContext, handler: (req: Recorded, res: ServerResponse, index: number) => void): Promise<TestServer> {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const recorded = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      requests.push(recorded);
      handler(recorded, res, requests.length - 1);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const close = () => new Promise<void>(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });
  t.after(close);
  return { url: `http://127.0.0.1:${address.port}/v1/test`, requests, close };
}
export const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

export async function tempDir(t: TestContext, prefix = 'image-gen-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export const config = (patch: Partial<Config> = {}): Config => ({ ...defaults(), enabled: true, ...patch });
