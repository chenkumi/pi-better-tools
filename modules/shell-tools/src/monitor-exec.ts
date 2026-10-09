import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { VERSION, getShellConfig, getPowerShellConfig, SettingsManager, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { isManagedForegroundChild } from './managed-child.js';
export function requireMonitorArgvConfig(config: { shell: string; args: string[]; commandTransport?: string }) {
  if (config.commandTransport === 'stdin') throw new Error('Monitor does not support legacy stdin command transport; configure a local argv-capable shell explicitly');
}
/** Internal offline contract seam, never exposed as a tool/configuration parameter. */
export interface MonitorExecSeam { loadBackend?: () => Promise<Record<string, unknown>>; spawn?: typeof spawn }
export interface MonitorProcessEvents { stdout(data: Buffer): void; stderr(data: Buffer): void; started(): void; closed(code: number | null, signal: NodeJS.Signals | null, spawnError: boolean): void }
/** Channel-aware seam for Monitor only. Existing foreground/background Shell definitions are unchanged.
 * Pi's public operations merge channels and settle on exit; reuse its actual shell resolver,
 * environment, detached-child tracking and best-effort process-tree cancellation instead of copying them.
 * Internal backend functions are resolved RELATIVE to the installed pinned host, never a source checkout.
 * Missing/version-incompatible host fails closed; this is a Pi1.1.0-specific adaptation, not wildcard support.
 */
export async function execMonitorCommand(pi: Pick<ExtensionAPI, 'getSettings'>, ctx: ExtensionContext, tool: 'bash' | 'powershell', command: string, signal: AbortSignal, events: MonitorProcessEvents, seam: MonitorExecSeam = {}): Promise<void> {
  if (isManagedForegroundChild()) throw new Error('Managed child cannot execute Monitor commands');
  if (VERSION !== '1.1.0') throw new Error('Monitor command backend requires Pi 1.1.0');
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
  await new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try { child = (seam.spawn ?? spawn)(config.shell, [...config.args, resolvedCommand], { cwd: ctx.cwd, detached: process.platform !== 'win32', env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch { events.closed(null, null, true); reject(new Error('Monitor spawn failed')); return; }
    let spawnError = false;
    const abort = () => { if (child.pid) backend.killProcessTree(child.pid); };
    if (child.pid) backend.trackDetachedChildPid(child.pid);
    child.once('spawn', events.started);
    child.stdout?.on('data', events.stdout); child.stderr?.on('data', events.stderr);
    child.once('error', () => { spawnError = true; });
    // exit is not the barrier: inherited pipes may remain open. Retain owned listeners until close.
    child.once('close', (code, closeSignal) => {
      signal.removeEventListener('abort', abort); if (child.pid) backend.untrackDetachedChildPid(child.pid);
      child.stdout?.removeListener('data', events.stdout); child.stderr?.removeListener('data', events.stderr);
      events.closed(code, closeSignal, spawnError); resolve();
    });
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  });
}
