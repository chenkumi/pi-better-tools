import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { VERSION, getShellConfig, getPowerShellConfig, SettingsManager, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { isManagedForegroundChild } from './managed-child.js';
export function requireMonitorArgvConfig(config: { shell: string; args: string[]; commandTransport?: string }) {
  if (config.commandTransport === 'stdin') throw new Error('Monitor does not support legacy stdin command transport; configure a local argv-capable shell explicitly');
}
/** Internal offline contract seam, never exposed as a tool/configuration parameter. */
export interface MonitorExecSeam { loadBackend?: () => Promise<Record<string, unknown>>; spawn?: typeof spawn }
/** Optional per-run controls. `cwd` defaults to the session cwd. `abortGraceMs` defers an abort that arrives before the
 * first output/close (at most that long) so the host kills the tree after the shell spawned its children;
 * `exitIdleMs` settles once the shell exited and the pipes stayed silent that long (a descendant may still hold them). */
export interface MonitorExecOptions { cwd?: string; abortGraceMs?: number; exitIdleMs?: number }
export interface MonitorProcessEvents { stdout(data: Buffer): void; stderr(data: Buffer): void; started(): void; closed(code: number | null, signal: NodeJS.Signals | null, spawnError: boolean): void }
/** Channel-aware seam for Monitor only. Existing foreground/background Shell definitions are unchanged.
 * Pi's public operations merge channels and settle on exit; reuse its actual shell resolver,
 * environment, detached-child tracking and best-effort process-tree cancellation instead of copying them.
 * Internal backend functions are resolved RELATIVE to the installed pinned host, never a source checkout.
 * Missing/version-incompatible host fails closed; this is a Pi1.3.0-specific adaptation, not wildcard support.
 */
export async function execMonitorCommand(pi: Pick<ExtensionAPI, 'getSettings'>, ctx: ExtensionContext, tool: 'bash' | 'powershell', command: string, signal: AbortSignal, events: MonitorProcessEvents, seam: MonitorExecSeam = {}, options: MonitorExecOptions = {}): Promise<void> {
  if (isManagedForegroundChild()) throw new Error('Managed child cannot execute Monitor commands');
  if (VERSION !== '1.3.0') throw new Error('Monitor command backend requires Pi 1.3.0');
  if (signal.aborted) { events.closed(null, null, false); return; }
  const settings = pi.getSettings();
  const shellPath = SettingsManager.inMemory({ shellPath: settings.shellPath }).getShellPath();
  const config = tool === 'bash' ? getShellConfig(shellPath) : getPowerShellConfig();
  const resolvedCommand = tool === 'bash' && settings.shellCommandPrefix ? `${settings.shellCommandPrefix}\n${command}` : tool === 'powershell' ? `try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n${command}` : command;
  const entry = import.meta.resolve('@earendil-works/pi-coding-agent');
  const backend: any = seam.loadBackend ? await seam.loadBackend() : await import(new URL('./utils/shell.js', entry.startsWith('file:') ? entry : pathToFileURL(entry)).href);
  for (const key of ['getShellEnv', 'killProcessTree', 'trackDetachedChildPid', 'untrackDetachedChildPid']) if (typeof backend[key] !== 'function') throw new Error('Installed host lacks required Shell backend capability');
  if (signal.aborted) { events.closed(null, null, false); return; }
  const env = { ...backend.getShellEnv() };
  for (const key of ['PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_PROVIDER', 'PI_MODEL', 'PI_REASONING_LEVEL']) delete env[key];
  env.PI_SESSION_ID = ctx.sessionManager.getSessionId(); const file = ctx.sessionManager.getSessionFile(); if (file) env.PI_SESSION_FILE = file;
  if (ctx.model) { env.PI_PROVIDER = ctx.model.provider; env.PI_MODEL = ctx.model.id; } if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
  requireMonitorArgvConfig(config);
  const abortGraceMs = options.abortGraceMs && options.abortGraceMs > 0 ? options.abortGraceMs : 0, exitIdleMs = options.exitIdleMs && options.exitIdleMs > 0 ? options.exitIdleMs : 0;
  await new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try { child = (seam.spawn ?? spawn)(config.shell, [...config.args, resolvedCommand], { cwd: options.cwd ?? ctx.cwd, detached: process.platform !== 'win32', env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch { events.closed(null, null, true); reject(new Error('Monitor spawn failed')); return; }
    let spawnError = false, settled = false, sawOutput = false, graceTimer: ReturnType<typeof setTimeout> | undefined, idleTimer: ReturnType<typeof setTimeout> | undefined, pendingKill = false;
    const kill = () => { pendingKill = false; if (graceTimer) { clearTimeout(graceTimer); graceTimer = undefined; } if (child.pid) backend.killProcessTree(child.pid); };
    const abort = () => { if (abortGraceMs && !sawOutput && !settled) { pendingKill = true; graceTimer ??= setTimeout(kill, abortGraceMs); } else kill(); };
    const settle = (code: number | null, closeSignal: NodeJS.Signals | null) => {
      if (settled) return; settled = true;
      if (graceTimer) clearTimeout(graceTimer); if (idleTimer) clearTimeout(idleTimer);
      signal.removeEventListener('abort', abort); if (child.pid) backend.untrackDetachedChildPid(child.pid);
      child.stdout?.removeListener('data', onStdout); child.stderr?.removeListener('data', onStderr);
      events.closed(code, closeSignal, spawnError); resolve();
    };
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    const armIdle = () => { if (!exited || !exitIdleMs) return; if (idleTimer) clearTimeout(idleTimer); idleTimer = setTimeout(() => settle(exited!.code, exited!.signal), exitIdleMs); };
    const onData = () => { if (!sawOutput) { sawOutput = true; if (pendingKill) kill(); } armIdle(); };
    const onStdout = (data: Buffer) => { onData(); events.stdout(data); };
    const onStderr = (data: Buffer) => { onData(); events.stderr(data); };
    if (child.pid) backend.trackDetachedChildPid(child.pid);
    child.once('spawn', events.started);
    child.stdout?.on('data', onStdout); child.stderr?.on('data', onStderr);
    child.once('error', () => { spawnError = true; });
    if (exitIdleMs) child.once('exit', (code, closeSignal) => { exited = { code, signal: closeSignal }; armIdle(); });
    // exit is not the barrier: inherited pipes may remain open. Retain owned listeners until close.
    child.once('close', (code, closeSignal) => settle(code, closeSignal));
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  });
}
