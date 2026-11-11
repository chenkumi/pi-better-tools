import { spawn, type SpawnOptions } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { ToolError } from '../../../../shared/src/tool-error/index.ts';
import type { Config } from '../config.ts';
import { sniffImage } from '../images.ts';
import { clean } from '../text.ts';
import { MAX_IMAGE_BYTES, numericUsage, type BackendEnv, type GeneratedImage, type GenerateRequest, type GenerateResult } from './types.ts';

/** Variables Codex needs to start, find its login and reach the network. Keys such as OPENAI_API_KEY and CODEX_API_KEY are deliberately not passed. */
const ENV_ALLOW = [
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'TEMP', 'TMP', 'TMPDIR',
  'CODEX_HOME', 'LANG', 'LC_ALL', 'TERM', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
];
export function codexEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined && ENV_ALLOW.includes(key.toUpperCase())) out[key] = value;
  return out;
}

export interface CodexEnv extends BackendEnv {
  spawnImpl?: (command: string, args: string[], options: SpawnOptions) => ReturnType<typeof spawn>;
  /** Test seam: arguments placed before the real ones (a fake codex script run by node). */
  argsPrefix?: string[];
  codexHome?: string;
  tmpRoot?: string;
  baseEnv?: NodeJS.ProcessEnv;
  /** Test seam: the platform whose launch rules apply (default: this process's). */
  platform?: NodeJS.Platform;
}

/**
 * On Windows an npm install of Codex provides only `codex.cmd`, which cannot be started without a shell. The shim does nothing but run
 * `node <dir>
ode_modules@openaicodexincodex.js`, so for the bare name `codex` that script is started with this Node directly
 * (still no shell: the prompt stays one argument). Anything else, or a layout that is not found, is launched as configured.
 */
export function resolveCodexLaunch(command: string, env: Pick<CodexEnv, 'baseEnv' | 'platform'> = {}): { command: string; prefix: string[] } {
  const asConfigured = { command, prefix: [] as string[] };
  if ((env.platform ?? process.platform) !== 'win32' || command.toLowerCase() !== 'codex') return asConfigured;
  const base = env.baseEnv ?? process.env;
  const pathKey = Object.keys(base).find(key => key.toUpperCase() === 'PATH');
  for (const dir of (pathKey ? base[pathKey] ?? '' : '').split(delimiter)) {
    if (!dir || !existsSync(join(dir, 'codex.cmd'))) continue;
    const script = join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    return existsSync(script) ? { command: process.execPath, prefix: [script] } : asConfigured;
  }
  return asConfigured;
}

interface ProcessResult { code: number | null; lines: string[]; stderr: string; timedOut: boolean; cancelled: boolean; spawnError?: string }
const STDOUT_LIMIT = 4 * 1024 * 1024, STDERR_TAIL = 8 * 1024, KILL_GRACE_MS = 3000;

function runCodex(command: string, args: string[], cwd: string, env: CodexEnv, timeoutMs: number): Promise<ProcessResult> {
  return new Promise(resolve => {
    const result: ProcessResult = { code: null, lines: [], stderr: '', timedOut: false, cancelled: false };
    let buffer = '', size = 0, done = false;
    let child: ReturnType<typeof spawn>;
    try {
      const launch = resolveCodexLaunch(command, env);
      child = (env.spawnImpl ?? spawn)(launch.command, [...launch.prefix, ...(env.argsPrefix ?? []), ...args], { cwd, env: codexEnvironment(env.baseEnv), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    } catch (error) { resolve({ ...result, spawnError: (error as { code?: string }).code ?? 'SPAWN' }); return; }
    const finish = () => { if (done) return; done = true; clearTimeout(timer); env.signal?.removeEventListener('abort', onAbort); resolve(result); };
    const stop = () => {
      // Best effort: the process (and on Windows its tree) is asked to end. This does not prove everything stopped.
      try { child.kill(); } catch { /* already gone */ }
      if (process.platform === 'win32' && child.pid) { try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined); } catch { /* best effort */ } }
      // A descendant that keeps the pipes open would keep `close` from firing: do not wait for it forever.
      setTimeout(finish, KILL_GRACE_MS).unref();
    };
    const onAbort = () => { result.cancelled = true; stop(); };
    const timer = setTimeout(() => { result.timedOut = true; stop(); }, timeoutMs);
    if (env.signal?.aborted) onAbort(); else env.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > STDOUT_LIMIT) return; // events past the cap are dropped; the files on disk are what counts
      buffer += chunk.toString('utf8');
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) { result.lines.push(buffer.slice(0, at)); buffer = buffer.slice(at + 1); }
    });
    child.stderr?.on('data', (chunk: Buffer) => { result.stderr = (result.stderr + chunk.toString('utf8')).slice(-STDERR_TAIL); });
    child.on('error', error => { result.spawnError = (error as { code?: string }).code ?? 'SPAWN'; finish(); });
    child.on('close', code => { if (buffer.trim()) result.lines.push(buffer); result.code = code; finish(); });
  });
}

/** Cheap and free: is the codex executable there and logged in? Run before the user is asked to confirm a paid call. */
export async function codexPreflight(config: Config['codex'], env: CodexEnv): Promise<void> {
  const tmp = await mkdtemp(join(env.tmpRoot ?? tmpdir(), 'pi-image-codex-'));
  try {
    const result = await runCodex(config.path, ['login', 'status'], tmp, env, 20_000);
    if (result.spawnError === 'ENOENT') throw new ToolError('IMAGE_CODEX_MISSING', `The codex executable "${clean(config.path, 100)}" was not found. Install the Codex CLI or set codex.path in the image-generation settings.${process.platform === 'win32' ? ' On Windows an npm install provides only codex.cmd, which cannot be used: point codex.path at the real executable (codex.exe under node_modules\@openai\codex, or the native binary it ships).' : ''}`);
    if (result.spawnError) throw new ToolError('IMAGE_CODEX_MISSING', `The codex executable could not be started (${clean(result.spawnError, 30)}).`);
    if (result.cancelled) throw new ToolError('IMAGE_CANCELLED', 'Cancelled while checking the Codex login.');
    const text = `${result.lines.join('\n')}\n${result.stderr}`;
    if (result.code !== 0 || !/\blogged in\b/i.test(text) || /\bnot logged in\b/i.test(text)) throw new ToolError('IMAGE_AUTH_MISSING', 'Codex is not logged in. Run "codex login" in a terminal first.');
  } finally { await rm(tmp, { recursive: true, force: true }).catch(() => undefined); }
}

const sanitizeId = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_') || 'generated_image';
const IMAGE_FILE = /\.(?:png|jpe?g|webp)$/i;

async function snapshot(root: string): Promise<Map<string, number>> {
  const files = new Map<string, number>();
  for (const dir of await readdir(root).catch(() => [] as string[])) {
    for (const name of await readdir(join(root, dir)).catch(() => [] as string[])) {
      if (!IMAGE_FILE.test(name)) continue;
      const file = join(root, dir, name);
      const info = await stat(file).catch(() => undefined);
      if (info?.isFile()) files.set(file, info.mtimeMs);
    }
  }
  return files;
}

function wrapPrompt(request: GenerateRequest): string {
  const hints = [
    request.aspectRatio ? `Aspect ratio: ${request.aspectRatio}.` : '',
    request.resolution ? `Target resolution: about ${request.resolution}.` : '',
    request.transparentBackground ? 'Use a transparent background.' : '',
  ].filter(Boolean);
  return ['Use the built-in image_gen tool exactly once to create the image described between the markers. Do not run shell commands, read or edit files, or use any other tool. When it is done, reply with the single word done.',
    '--- image description ---', request.prompt, ...hints, '--- end ---'].join('\n');
}

/** One `codex exec` per image, in an empty temporary directory under a read-only sandbox. This limits what the Codex agent touches; it is not a sandbox for the model. */
export async function generateCodex(request: GenerateRequest, config: Config['codex'], env: CodexEnv): Promise<GenerateResult> {
  const ignored: string[] = [], notes: string[] = [];
  if (request.quality) ignored.push('quality (not a Codex option)');
  if (request.format && request.format !== 'png') ignored.push(`format ${request.format} (Codex saves PNG)`);
  const home = env.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const generatedRoot = join(home, 'generated_images');
  const images: GeneratedImage[] = [];
  const usage: Record<string, number> = {};
  for (let index = 0; index < request.count; index++) {
    env.onProgress?.(`Asking Codex for image ${index + 1} of ${request.count}…`);
    const tmp = await mkdtemp(join(env.tmpRoot ?? tmpdir(), 'pi-image-codex-'));
    try {
      const before = await snapshot(generatedRoot);
      const started = Date.now();
      const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-C', tmp, ...(config.model ? ['-m', config.model] : []), wrapPrompt(request)];
      const run = await runCodex(config.path, args, tmp, env, config.timeoutMs);
      if (run.spawnError) throw new ToolError('IMAGE_CODEX_MISSING', `The codex executable could not be started (${clean(run.spawnError, 30)}).`);
      if (run.cancelled) throw new ToolError('IMAGE_CANCELLED', 'The Codex run was cancelled. Codex may still finish in the background.');
      let threadId: string | undefined, lastMessage = '', failure = '';
      for (const line of run.lines) {
        let event: Record<string, unknown>;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'thread.started' && typeof event.thread_id === 'string') threadId = event.thread_id;
        else if (event.type === 'turn.failed') failure = clean((event.error as { message?: unknown } | undefined)?.message, 300) || 'the turn failed';
        else if (event.type === 'item.completed') {
          const item = event.item as { type?: unknown; text?: unknown } | undefined;
          if (item?.type === 'agent_message' && typeof item.text === 'string') lastMessage = item.text;
        } else if (event.type === 'turn.completed') {
          for (const [key, value] of Object.entries(numericUsage(event.usage, ['input_tokens', 'cached_input_tokens', 'output_tokens']) ?? {})) usage[key] = (usage[key] ?? 0) + value;
        }
      }
      const after = await snapshot(generatedRoot);
      const fresh = (file: string, mtime: number) => !before.has(file) && mtime >= started - 2000;
      const threadDir = threadId ? join(generatedRoot, sanitizeId(threadId)) : undefined;
      const inThread = threadDir ? [...after].filter(([file, mtime]) => dirname(file) === threadDir && fresh(file, mtime)) : [];
      // Only without a thread id is any fresh file taken: with one, another session's image must never be picked up.
      const candidates = (threadDir ? inThread : [...after].filter(([file, mtime]) => fresh(file, mtime))).sort((a, b) => a[1] - b[1]);
      if (!candidates.length) {
        if (run.timedOut) throw new ToolError('IMAGE_TIMEOUT', `Codex produced no image within ${Math.round(config.timeoutMs / 1000)} s and was stopped.`);
        if (failure || run.code !== 0) throw new ToolError('IMAGE_CODEX_FAILED', `Codex failed${failure ? `: ${failure}` : ` (exit code ${run.code ?? 'none'})`}${run.stderr ? `. ${clean(run.stderr.slice(-400), 200)}` : ''}`);
        throw new ToolError('IMAGE_NO_OUTPUT', `Codex finished without generating an image${lastMessage ? `. It said: ${clean(lastMessage, 300)}` : ''}.`);
      }
      const file = candidates[candidates.length - 1]![0];
      const bytes = await readFile(file);
      const info = bytes.length <= MAX_IMAGE_BYTES ? sniffImage(bytes) : undefined;
      if (!info) throw new ToolError('IMAGE_BAD_IMAGE', 'The file Codex saved is not a valid png, jpeg or webp image.');
      images.push({ bytes, info });
      if (candidates.length > 1) notes.push(`Codex saved ${candidates.length} files for one request; the newest was used.`);
    } catch (error) {
      if (!images.length || (error instanceof ToolError && error.code === 'IMAGE_CANCELLED') || env.signal?.aborted) throw error;
      notes.push(`Stopped after ${images.length} of ${request.count} images: ${error instanceof ToolError ? error.message : 'the run failed'}`);
      break;
    } finally { await rm(tmp, { recursive: true, force: true }).catch(() => undefined); }
  }
  return { images, model: config.model ?? 'codex default', controls: 'prompt-hint', ignored, notes, ...(Object.keys(usage).length ? { usage } : {}) };
}
