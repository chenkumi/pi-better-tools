import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
const exec = promisify(execFile);

/** Preserve platform essentials, not provider keys, user pi settings, or npm credentials. */
export function isolatedEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'SystemDrive', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'PROCESSOR_ARCHITECTURE']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
    PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'), PI_OFFLINE: '1',
    npm_config_userconfig: join(home, 'empty.npmrc'), npm_config_cache: join(home, '.npm-cache') };
}

async function terminateTree(pid: number) {
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    try { await exec(taskkill, ['/PID', String(pid), '/T', '/F'], { timeout: 5000, windowsHide: true }); }
    catch { try { process.kill(pid, 0); } catch { return; } throw new Error('owned process-tree termination failed'); }
    return;
  }
  // Every primary child starts its own session/group. Discover detached descendant
  // groups before stopping the parent, so npm workers and Chromium are included.
  const groups = new Set([pid]);
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,pgid='], { timeout: 5000, maxBuffer: 1024 * 1024 });
  const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const owned = new Set([pid]);
  for (const parent of owned) for (const [id, ppid, group] of rows) {
    if (ppid === parent && id && group) { owned.add(id); groups.add(group); }
  }
  const kill = (signal: NodeJS.Signals) => {
    for (const group of groups) try { process.kill(-group, signal); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('owned process-group termination failed'); }
  };
  kill('SIGTERM'); await delay(1000); kill('SIGKILL');
}

export interface RunOptions { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; label: string; echo?: boolean }
export async function runCommand(command: string, args: string[], options: RunOptions): Promise<{ stdout: string; stderr: string }> {
  console.error(`Progress: ${options.label}`);
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true, detached: process.platform !== 'win32' });
  let stdout = '', stderr = '';
  const append = (old: string, chunk: Buffer) => (old + chunk.toString()).slice(-1024 * 1024);
  child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); if (options.echo) process.stdout.write(chunk); });
  child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); if (options.echo) process.stderr.write(chunk); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const progress = setInterval(() => console.error(`Progress: ${options.label} is still running`), 10000);
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), options.timeoutMs ?? 600000); });
  try {
    const status = await Promise.race([closed, deadline]);
    if (status === 'timeout') {
      console.error(`Progress: terminating timed-out process tree for ${options.label}`);
      let cleanupError = '';
      try { if (child.pid) await terminateTree(child.pid); } catch (e) { cleanupError = `; ${(e as Error).message}`; child.kill('SIGKILL'); }
      // close can wait forever on inherited pipes. Independently bound the final
      // wait, destroy pipe handles, and report any cleanup failure rather than hang.
      let finalTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([closed.catch(() => undefined), new Promise<void>(resolve => { finalTimer = setTimeout(resolve, 2000); })]);
      clearTimeout(finalTimer);
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      throw new Error(`${options.label} failed (timeout${cleanupError}):\n${stdout}\n${stderr}`);
    }
    if (status.code !== 0) throw new Error(`${options.label} failed (exit=${status.code}, signal=${status.signal}):\n${stdout}\n${stderr}`);
    return { stdout, stderr };
  } finally { clearInterval(progress); clearTimeout(timer!); }
}

/** Invoke npm's JS CLI directly: npm.cmd cannot be execFile'd safely on Windows. */
export function runNpm(args: string[], options: RunOptions) {
  const cli = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(cli)) throw new Error('npm CLI not found; run this script through npm run');
  return runCommand(process.execPath, [cli, ...args], options);
}
