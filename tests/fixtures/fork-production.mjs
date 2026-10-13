// Production tarball probe for Fork: real packaged Pi host, real packaged extension, real independent child; offline fake provider.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const packageRoot = resolve(process.argv[2]), providerPath = resolve(process.argv[3]), host = process.env.PI_BETTER_TOOLS_HOST;
assert.ok(host, 'PI_BETTER_TOOLS_HOST is required');
const cli = join(host, 'dist/bundle/cli.js');
const home = homedir(), agentDir = join(home, '.pi/agent'), ws = join(home, 'workspace'), sessions = join(home, 'sessions'), capture = await mkdtemp(join(home, 'capture-'));
for (const dir of [agentDir, ws, sessions]) await mkdir(dir, { recursive: true });
await writeFile(join(agentDir, 'auth.json'), '{}');
await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off', defaultProjectTrust: 'never' }));
const deadline = 120_000;
const args = [cli, '--mode', 'rpc', '--offline', '--no-extensions', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-themes',
  '-e', join(packageRoot, 'modules/fork/src/index.ts'), '-e', providerPath, '--model', 'fork-offline/m', '--thinking', 'off', '--tools', 'read,fork,fork_status', '--session-dir', sessions];
const proc = spawn(process.execPath, args, { cwd: ws, env: { ...process.env, FORK_CAPTURE: capture }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const events = []; let stderr = '', buffer = '';
const waiters = [];
proc.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
proc.stdout.setEncoding('utf8');
proc.stdout.on('data', chunk => {
  buffer += chunk;
  for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) { try { events.push(JSON.parse(buffer.slice(0, at))); } catch { /* non-JSON line */ } buffer = buffer.slice(at + 1); }
  for (const waiter of [...waiters]) if (waiter.test()) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(); }
});
const exit = new Promise(resolveExit => proc.once('close', resolveExit));
const kill = setTimeout(() => proc.kill('SIGKILL'), deadline);
const waitFor = (name, test) => new Promise((resolveWait, reject) => {
  if (test()) { resolveWait(); return; }
  waiters.push({ test, resolve: resolveWait });
  exit.then(code => reject(new Error(`Pi exited (${code}) while waiting for ${name}\n${stderr}`)));
  setTimeout(() => reject(new Error(`deadline waiting for ${name}`)), deadline).unref();
});
const notices = () => events.filter(e => e.type === 'message_end' && e.message?.customType === 'fork-result');
try {
  console.error('[fork-production] Prompting packaged parent Pi (offline)...');
  proc.stdin.write(JSON.stringify({ id: 'p1', type: 'prompt', message: 'DO_FORK production' }) + '\n');
  await waitFor('fork result', () => notices().length > 0);
  await waitFor('settle', () => { const at = events.findIndex(e => e.message?.customType === 'fork-result'); return events.slice(at).some(e => e.type === 'agent_settled'); });
  proc.stdin.end();
  const code = await Promise.race([exit, new Promise(resolveTimeout => setTimeout(() => resolveTimeout('timeout'), 30_000))]);
  assert.equal(code, 0, stderr);
  const details = notices()[0].message.details;
  assert.equal(details.status, 'completed');
  assert.match(notices()[0].message.content, /FORK_CHILD_DONE/);
  const requests = await Promise.all((await readdir(capture)).map(async name => JSON.parse(await readFile(join(capture, name), 'utf8'))));
  const child = requests.filter(r => r.isChild), root = requests.filter(r => !r.isChild);
  assert.ok(child.length >= 1 && root.length >= 2);
  assert.notEqual(child[0].pid, root[0].pid, 'independent process');
  assert.deepEqual(child[0].tools, ['read'], 'packaged child inherits the exact selection minus Fork tools');
  const files = (await readdir(sessions)).filter(name => name.endsWith('.jsonl'));
  assert.equal(files.length, 2);
  const forkFile = files.find(name => name.includes(details.forkSessionId));
  const rows = (await readFile(join(sessions, forkFile), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows[0].id, details.forkSessionId); assert.ok(rows.some(row => row.customType === 'pi-better-tools.fork-origin'));
  console.log(JSON.stringify({ status: 'passed', host: JSON.parse(await readFile(join(host, 'package.json'), 'utf8')).version, providerCalls: 0, cases: ['snapshot', 'independent-child', 'report-origin', 'tool-selection'] }));
} finally {
  clearTimeout(kill);
  try { proc.kill('SIGKILL'); } catch { /* gone */ }
  await exit;
  await rm(capture, { recursive: true, force: true });
}
