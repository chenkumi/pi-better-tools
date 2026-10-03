import { readFileSync } from 'node:fs';
import { appendFile, chmod, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve, win32 } from 'node:path';

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_LOG_DAYS = 7;
const MAX_RECORD_BYTES = 16 * 1024;
const SETTINGS_PATH = join(homedir(), '.pi', 'agent', 'settings.json');
const LOG_ROOT = join(homedir(), '.pi', 'logs');
const appendTails = new Map<string, Promise<void>>();

type FailureContext = { cwd: string } | undefined;

export function projectNameFromCwd(cwd: string): string | undefined {
  // Recognize explicit Windows drive/UNC paths on every host; ordinary POSIX
  // names may contain backslashes, so do not reinterpret all paths as Windows.
  const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(cwd) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(cwd);
  const leaf = windowsAbsolute ? win32.basename(win32.normalize(cwd)) : basename(resolve(cwd));
  const name = leaf.normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+|\.+$/g, '').slice(0, 80);
  if (!name || name === '.' || name === '..') return;
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name) ? `_${name}` : name;
}

function debugEnabled(settingsPath: string, projectName: string): boolean {
  try {
    const settings: unknown = JSON.parse(requireText(settingsPath));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
    const project = (settings as Record<string, unknown>)[projectName];
    return !!project && typeof project === 'object' && !Array.isArray(project) &&
      (project as Record<string, unknown>).debugLog === true;
  } catch { return false; }
}

// Keep this synchronous read deliberately tiny and local: the setting is checked
// only after a tool failure, never on successful calls or during extension load.
function requireText(path: string): string {
  // A static node:fs import avoids dynamic module loading in error paths.
  return readFileSync(path, { encoding: 'utf8', flag: 'r' });
}

function redact(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:api[_-]?key|token|access_token|secret|password|authorization|signature)=)[^&#\s]*/gi, '$1[REDACTED]')
    .replace(/\b(api[_-]?key|access[_-]?token|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

export interface ToolFailureLogOptions {
  cwd: string;
  toolName: string;
  error: unknown;
  settingsPath?: string;
  logsRoot?: string;
  now?: Date;
}

/** Best-effort, opt-in diagnostic logging. Never throws or masks the tool error. */
export async function logToolFailure(options: ToolFailureLogOptions): Promise<string | undefined> {
  try {
    const projectName = projectNameFromCwd(options.cwd);
    if (!projectName || !debugEnabled(options.settingsPath ?? SETTINGS_PATH, projectName)) return;

    const now = options.now ?? new Date();
    const date = now.toISOString().slice(0, 10);
    const directory = join(options.logsRoot ?? LOG_ROOT, projectName);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(directory, 0o700);
    const filename = `tool-errors-${date}.jsonl`;
    const path = join(directory, filename);
    const error = options.error instanceof Error ? options.error : new Error(String(options.error));
    const record = {
      timestamp: now.toISOString(), project: projectName,
      tool: redact(options.toolName).slice(0, 100),
      error: { name: redact(error.name || 'Error').slice(0, 100), message: redact(error.message).slice(0, 4000),
        ...(error.stack ? { stack: redact(error.stack).slice(0, 8000) } : {}) },
    };
    const line = JSON.stringify(record) + '\n', bytes = Buffer.byteLength(line);
    if (bytes > MAX_RECORD_BYTES) return;
    const previous = appendTails.get(path) ?? Promise.resolve();
    let logged = false;
    const queued = previous.catch(() => undefined).then(async () => {
      let currentSize = 0;
      try { currentSize = (await stat(path)).size; } catch { /* first log for this day */ }
      if (currentSize + bytes > MAX_LOG_BYTES) return;
      await appendFile(path, line, { encoding: 'utf8', mode: 0o600, flag: 'a' });
      if (process.platform !== 'win32') await chmod(path, 0o600);
      logged = true;
      await pruneOldLogs(directory, date);
    });
    appendTails.set(path, queued);
    try { await queued; } finally { if (appendTails.get(path) === queued) appendTails.delete(path); }
    return logged ? path : undefined;
  } catch {
    // Diagnostics must never replace the original tool failure or create another failure loop.
    return;
  }
}

async function pruneOldLogs(directory: string, _today: string): Promise<void> {
  try {
    const files = (await readdir(directory)).filter(name => /^tool-errors-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().reverse();
    let kept = 0;
    for (const name of files) {
      // Retain the seven newest canonical UTC-dated files, even if the clock moves backward.
      if (kept++ < MAX_LOG_DAYS) continue;
      await unlink(join(directory, name)).catch(() => undefined);
    }
  } catch { /* best effort */ }
}

export async function logToolExecutionFailure(ctx: FailureContext, toolName: string, error: unknown): Promise<void> {
  if (!ctx?.cwd) return;
  await logToolFailure({ cwd: ctx.cwd, toolName, error });
}

export async function executeWithDebugLog<T>(ctx: FailureContext, toolName: string, execute: () => Promise<T>,
  writeFailure: typeof logToolExecutionFailure = logToolExecutionFailure): Promise<T> {
  try { return await execute(); }
  catch (error) {
    try { await writeFailure(ctx, toolName, error); } catch { /* diagnostic failures never mask the tool failure */ }
    throw error;
  }
}


