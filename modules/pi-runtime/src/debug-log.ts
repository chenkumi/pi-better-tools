import { appendFileSync, chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { safeText } from './policy.js';

export interface RuntimeLogOptions { agentDir?: string; logsDir?: string; now?: Date }
export interface RuntimeLogging {
  enabled(): boolean;
  write(record: Record<string, unknown>): void;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Global-only, opt-in, reread at capture/failure; never modifies personal settings. */
export function runtimeDebugEnabled(options: RuntimeLogOptions = {}): boolean {
  try {
    const path = join(options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'), 'settings.json');
    const settings = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    return isPlainRecord(settings) && isPlainRecord(settings['pi-runtime']) && settings['pi-runtime'].debugLog === true;
  } catch { return false; }
}

/** Bounded, detached diagnostic data. Common-secret masking is not complete DLP. */
export function runtimeLogSnapshot(value: unknown): { value: unknown; truncated: boolean } {
  let remaining = 48 * 1024, nodes = 2048, truncated = false;
  const seen = new WeakSet<object>();
  const text = (s: string) => {
    // Redact before truncating: cutting quoted credentials first could expose suffixes.
    const cleaned = safeText(s.replace(/(["']?(?:password|secret|token)["']?\s*[=:]\s*)(?:"(?:\\[\s\S]|[^"\\\r\n])*(?:"|$)|'(?:\\[\s\S]|[^'\\\r\n])*(?:'|$)|[^\s"',;}]+)/gi, '$1"[REDACTED]"')
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
      .replace(/([?&](?:api[_-]?key|token|access_token|secret|password|authorization|signature)=)[^&#\s]*/gi, '$1[REDACTED]'), 8192);
    const result = cleaned.slice(0, Math.max(0, remaining));
    remaining -= result.length;
    if (s.length > 8192 || result.length < cleaned.length) truncated = true;
    return result;
  };
  const visit = (v: unknown, depth: number): unknown => {
    if (--nodes < 0 || depth > 8 || remaining <= 0) { truncated = true; return '[OMITTED: limit]'; }
    if (typeof v === 'string') return text(v);
    if (v === null || typeof v === 'boolean' || typeof v === 'number') return v;
    if (typeof v !== 'object') return String(v);
    if (seen.has(v)) { truncated = true; return '[OMITTED: cycle/shared reference]'; }
    seen.add(v);
    if (Array.isArray(v)) {
      if (v.length > 128) truncated = true;
      return v.slice(0, 128).map(item => visit(item, depth + 1));
    }
    const result: Record<string, unknown> = Object.create(null);
    let count = 0;
    for (const key in v) {
      if (!Object.hasOwn(v, key)) continue;
      if (++count > 128 || nodes <= 0 || remaining <= 0) { truncated = true; break; }
      const name = text(key);
      if (/^(?:api[_-]?key|access[_-]?token|authorization|cookie|password|secret|token|headers)$/i.test(key)) result[name] = '[REDACTED]';
      else if (/^(?:data|image_url|audio|file_data)$/i.test(key)) {
        truncated = true; result[name] = '[OMITTED: binary/media]';
      } else result[name] = visit((v as Record<string, unknown>)[key], depth + 1);
    }
    return result;
  };
  try { return { value: visit(value, 0), truncated }; }
  catch { return { value: '[OMITTED: unreadable diagnostic data]', truncated: true }; }
}

/** Synchronous failure-only append preserves recovery admission/reservation ordering.
 * Throws on write failure so the owning Runtime can notify without masking its original error.
 * No automatic retention/deletion, consistent with File Tools' daily JSONL logs.
 */
export function writeRuntimeFailure(record: Record<string, unknown>, options: RuntimeLogOptions = {}): void {
  if (!runtimeDebugEnabled(options)) return;
  const timestamp = (options.now ?? new Date()).toISOString();
  const directory = options.logsDir ?? join(homedir(), '.pi', 'logs', 'pi-runtime');
  const path = join(directory, `${timestamp.slice(0, 10)}.jsonl`);
  const snapshot = runtimeLogSnapshot(record);
  const line = JSON.stringify({ version: 1, timestamp, ...snapshot }) + '\n';
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(directory, 0o700);
  appendFileSync(path, line, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

export const runtimeLogging: RuntimeLogging = {
  enabled: () => runtimeDebugEnabled(),
  write: record => writeRuntimeFailure(record),
};
