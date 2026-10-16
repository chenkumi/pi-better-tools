import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, parse, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupCommand } from './commands.mjs';

const require = createRequire(import.meta.url);
export const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const json = path => JSON.parse(readFileSync(path, 'utf8'));

export function resolveDependency(name) {
  const manifest = require.resolve(`${name}/package.json`);
  return { root: dirname(manifest), version: json(manifest).version };
}

export function browserInvocation(action, { resolve = resolveDependency, execPath = process.execPath } = {}) {
  const actions = {
    install: ['install', 'chromium', '--no-shell'],
    'install-deps': ['install-deps', 'chromium'],
    setup: ['install', '--with-deps', 'chromium', '--no-shell'],
  };
  if (!Object.hasOwn(actions, action)) throw new Error('Unknown browser action.');
  return { command: execPath, args: [join(resolve('playwright').root, 'cli.js'), ...actions[action]], cwd: packageRoot, env: process.env };
}

// Only known npm CLI locations are considered; never execute a PATH shim or npx download.
export function discoverNpm({ env = process.env, execPath = process.execPath, exists = existsSync, realpath = realpathSync } = {}) {
  const nodeDir = dirname(realpath(execPath));
  const candidates = [env.npm_execpath, join(nodeDir, 'node_modules/npm/bin/npm-cli.js'), join(nodeDir, '../lib/node_modules/npm/bin/npm-cli.js')];
  const cli = candidates.find(path => path && isAbsolute(path) && basename(path) === 'npm-cli.js' && exists(path));
  if (!cli) throw new Error('npm CLI not found beside Node. Run this same setup CLI through npm exec --offline, or install npm alongside this Node executable. No installation was attempted.');
  return cli;
}

export function consumerRoot(dependencyRoot) {
  const parts = dependencyRoot.split(sep);
  const index = parts.indexOf('node_modules');
  if (index < 0) throw new Error('Unsupported node-pty layout: no node_modules owner.');
  return parts.slice(0, index).join(sep) || parse(dependencyRoot).root;
}

export function ptyInvocation({ resolve = resolveDependency, readJson = json, npm = discoverNpm, env = process.env, execPath = process.execPath } = {}) {
  const dependency = resolve('node-pty');
  const cwd = consumerRoot(dependency.root);
  let manifest;
  try { manifest = readJson(join(cwd, 'package.json')); }
  catch {
    throw new Error('Native setup requires a readable consumer package.json with exact node-pty version approval. For a global/package-manager layout without one, use that installation owner\'s approved native setup procedure or install into an explicit consumer project. No installation was attempted.');
  }
  // A dependency's own allowScripts is never consumer approval. Require the exact installed version.
  if (manifest.allowScripts?.[`node-pty@${dependency.version}`] !== true) {
    throw new Error(`Native setup requires consumer approval: set allowScripts["node-pty@${dependency.version}"] to true in the owning project's package.json, then retry. No policy was changed.`);
  }
  const childEnv = { ...env };
  // npm run promotes this setting to CLI policy, which npm rejects for project installs.
  for (const key of Object.keys(childEnv)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete childEnv[key];
  return { command: execPath, args: [npm({ env, execPath }), 'rebuild', dependency.root, '--foreground-scripts', '--global=false', '--prefix', cwd], cwd, env: childEnv };
}

export function doctor() {
  const result = { schemaVersion: 1, packageRoot, node: { version: process.version, executable: process.execPath }, platform: process.platform, arch: process.arch };
  try {
    const dependency = resolveDependency('playwright');
    const executable = require('playwright').chromium.executablePath();
    result.browser = { status: existsSync(executable) ? 'executable-present' : 'executable-missing', ...dependency, executable, next: setupCommand(['browser', 'install']) };
  } catch {
    result.browser = { status: 'dependency-unavailable' };
  }
  try {
    const dependency = resolveDependency('node-pty');
    let nativeStatus = 'loadable';
    try { require('node-pty'); } catch { nativeStatus = 'unavailable'; }
    const owner = consumerRoot(dependency.root);
    let approved = false;
    try { approved = json(join(owner, 'package.json')).allowScripts?.[`node-pty@${dependency.version}`] === true; } catch { /* Missing consumer manifest is not approval. */ }
    result.pty = { status: nativeStatus, ...dependency, owner, approved, next: setupCommand(['pty', 'setup']) };
  } catch {
    result.pty = { status: 'dependency-unavailable' };
  }
  // Presence/loading checks only: no browser launch, PTY spawn, network or native setup.
  return result;
}

export function runInvocation(invocation, { spawnChild = spawn, log = console.log } = {}) {
  log('[setup] Starting explicitly requested installation...');
  return new Promise(resolve => {
    const child = spawnChild(invocation.command, invocation.args, { cwd: invocation.cwd, env: invocation.env, stdio: 'inherit', shell: false });
    const heartbeat = setInterval(() => log('[setup] Installation still running...'), 10000);
    const finish = code => { clearInterval(heartbeat); resolve(code); };
    child.once('error', () => { console.error('[setup] Could not start installer.'); finish(1); });
    child.once('close', code => finish(code ?? 1));
  });
}

export const help = `pi-better-tools setup (explicit operations only)
  doctor [--json]       Read-only presence/loading checks; no launch or network
  browser install      Install this package's Chromium (no OS dependencies)
  browser install-deps Install Chromium OS dependencies (may require elevation)
  browser setup        Install Chromium AND OS dependencies (explicit convenience)
  pty setup            Rebuild only this instance's node-pty; consumer approval required
  --help               Show this help
Doctor does not verify browser launch, OS libraries, or PTY spawning.`;

export async function main(args, { inspect = doctor, browser = browserInvocation, pty = ptyInvocation, run = runInvocation, output = console.log } = {}) {
  if (args.length === 0 || (args.length === 1 && ['--help', '-h', 'help'].includes(args[0]))) { output(help); return 0; }
  if (args[0] === 'doctor' && (args.length === 1 || (args.length === 2 && args[1] === '--json'))) {
    const report = inspect();
    output(args[1] === '--json' ? JSON.stringify(report) : `Read-only setup diagnostic (presence/loading only):\n${JSON.stringify(report, null, 2)}`);
    return 0;
  }
  if (args.length === 2 && args[0] === 'browser' && ['install', 'install-deps', 'setup'].includes(args[1])) return run(browser(args[1]));
  if (args.length === 2 && args[0] === 'pty' && args[1] === 'setup') return run(pty());
  throw new Error('Unknown arguments. Run pi-better-tools --help.');
}
