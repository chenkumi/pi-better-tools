import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { codexEnvironment, codexPreflight, generateCodex, resolveCodexLaunch } from '../src/backends/codex.ts';
import { config, png, tempDir } from './helpers.ts';

const PNG_B64 = png(8, 8).toString('base64');
/** A stand-in for the codex executable, run by node. Its behaviour is chosen with `-m <mode>`; `login status` follows a marker file. */
const FAKE = `
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2), home = process.env.CODEX_HOME;
if (args[0] === 'login') {
  if (fs.existsSync(path.join(home, 'not-logged-in'))) { console.error('Not logged in'); process.exit(1); }
  console.log('Logged in using ChatGPT'); process.exit(0);
}
const log = path.join(home, 'calls.log');
const n = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean).length + 1 : 1;
fs.appendFileSync(log, JSON.stringify({ args, cwd: process.cwd(), leak: !!process.env.OPENAI_API_KEY || !!process.env.CODEX_API_KEY, pid: process.pid }) + '\\n');
const mode = args[args.indexOf('-m') + 1];
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-' + n }));
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'i0', type: 'error', message: 'Under-development features enabled' } }));
if (mode === 'hang') { setInterval(() => {}, 1000); return; }
if (mode === 'fail') { console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'quota exceeded' } })); process.exit(1); }
if (mode !== 'noimage') {
  const dir = path.join(home, 'generated_images', 'thread-' + n);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'exec-' + n + '.png'), Buffer.from('${PNG_B64}', 'base64'));
}
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: mode === 'noimage' ? 'I cannot do that' : 'done' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } }));
`;

async function fixture(t: TestContext) {
  const root = await tempDir(t, 'image-codex-test-');
  const home = join(root, 'home'), tmpRoot = join(root, 'tmp');
  await mkdir(home); await mkdir(tmpRoot);
  const script = join(root, 'fake-codex.cjs');
  await writeFile(script, FAKE);
  const env = { timeoutMs: 20_000, argsPrefix: [script], codexHome: home, tmpRoot, baseEnv: { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: 'sk-MUST-NOT-LEAK', CODEX_API_KEY: 'also-not' } };
  const settings = (model?: string) => ({ ...config().codex, path: process.execPath, ...(model ? { model } : {}), timeoutMs: 20_000 });
  const calls = async () => (await readFile(join(home, 'calls.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { root, home, tmpRoot, env, settings, calls };
}

test('the environment passed to codex keeps what it needs to start and drops API keys', () => {
  const out = codexEnvironment({ PATH: 'p', CODEX_HOME: 'h', USERPROFILE: 'u', OPENAI_API_KEY: 'k', CODEX_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', HTTPS_PROXY: 'x', RANDOM_SECRET: 's' });
  assert.deepEqual(Object.keys(out).sort(), ['CODEX_HOME', 'HTTPS_PROXY', 'PATH', 'USERPROFILE']);
});

test('preflight: logged in passes; not logged in and a missing executable are told apart', async t => {
  const f = await fixture(t);
  await codexPreflight(f.settings(), f.env);
  await writeFile(join(f.home, 'not-logged-in'), '');
  await assert.rejects(codexPreflight(f.settings(), f.env), /IMAGE_AUTH_MISSING: Codex is not logged in/);
  await assert.rejects(codexPreflight({ ...f.settings(), path: 'definitely-no-such-codex-binary' }, { timeoutMs: 5000, baseEnv: process.env }), /IMAGE_CODEX_MISSING/);
});

test('one exec in an empty temporary directory: read-only, ephemeral, keys withheld; the picture is found by its thread id', async t => {
  const f = await fixture(t);
  const result = await generateCodex({ prompt: 'a blue square', aspectRatio: '1:1', resolution: '2K', transparentBackground: true, count: 1 }, f.settings('ok'), f.env);
  assert.equal(result.images.length, 1); assert.equal(result.images[0]!.info.mime, 'image/png'); assert.equal(result.controls, 'prompt-hint');
  assert.deepEqual(result.usage, { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 });
  const [call] = await f.calls();
  const args: string[] = call.args;
  for (const flag of ['exec', '--json', '--ephemeral', '--skip-git-repo-check']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('-s') + 1], 'read-only'); assert.equal(args[args.indexOf('-m') + 1], 'ok');
  assert.equal(args[args.indexOf('-C') + 1], call.cwd, 'the working root is the temporary directory');
  assert.ok(call.cwd.startsWith(f.tmpRoot) && call.cwd !== process.cwd());
  assert.equal(call.leak, false, 'OPENAI_API_KEY and CODEX_API_KEY were not passed on');
  const prompt = args[args.length - 1]!;
  assert.match(prompt, /image_gen tool exactly once/); assert.match(prompt, /a blue square/); assert.match(prompt, /Aspect ratio: 1:1\./); assert.match(prompt, /transparent background/);
  assert.equal(existsSync(call.cwd), false, 'the temporary directory is removed again');
  assert.equal(result.ignored.length, 0);
});

test('quality and non-png formats are reported as ignored', async t => {
  const f = await fixture(t);
  const result = await generateCodex({ prompt: 'x', quality: 'high', format: 'webp', count: 1 }, f.settings('ok'), f.env);
  assert.match(result.ignored.join(' | '), /quality.*\| format webp \(Codex saves PNG\)/);
});

test('count runs one exec per image and returns each picture', async t => {
  const f = await fixture(t);
  const result = await generateCodex({ prompt: 'x', count: 2 }, f.settings('ok'), f.env);
  assert.equal(result.images.length, 2); assert.equal((await f.calls()).length, 2);
});

test('failures: no image, a failed turn, and the warning item that must not count as one', async t => {
  const f = await fixture(t);
  await assert.rejects(generateCodex({ prompt: 'x', count: 1 }, f.settings('noimage'), f.env), /IMAGE_NO_OUTPUT: .*It said: I cannot do that/);
  await assert.rejects(generateCodex({ prompt: 'x', count: 1 }, f.settings('fail'), f.env), /IMAGE_CODEX_FAILED: Codex failed: quota exceeded/);
  const ok = await generateCodex({ prompt: 'x', count: 1 }, f.settings('ok'), f.env);
  assert.equal(ok.images.length, 1, 'the type "error" warning item did not fail a run that produced an image');
});

test('an old picture already in generated_images is not mistaken for the new one', async t => {
  const f = await fixture(t);
  await mkdir(join(f.home, 'generated_images', 'old-thread'), { recursive: true });
  await writeFile(join(f.home, 'generated_images', 'old-thread', 'exec-old.png'), png(99, 99));
  await assert.rejects(generateCodex({ prompt: 'x', count: 1 }, f.settings('noimage'), f.env), /IMAGE_NO_OUTPUT/);
});

test('cancelling asks the codex process to end and reports the cancellation', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const run = generateCodex({ prompt: 'x', count: 1 }, f.settings('hang'), { ...f.env, signal: controller.signal });
  // Wait until the fake has started (its call is logged), then cancel.
  for (let i = 0; i < 200 && !(await f.calls()).length; i++) await new Promise(resolve => setTimeout(resolve, 25));
  const [call] = await f.calls();
  assert.ok(call, 'the fake codex started');
  controller.abort();
  await assert.rejects(run, /IMAGE_CANCELLED/);
  let alive = true;
  for (let i = 0; i < 200 && alive; i++) { try { process.kill(call.pid, 0); await new Promise(resolve => setTimeout(resolve, 25)); } catch { alive = false; } }
  assert.equal(alive, false, 'the process ended (best effort; this does not prove a process tree stopped)');
});

test('on Windows the bare codex name is resolved from its npm .cmd shim to node + codex.js; nothing else is rewritten', async t => {
  const root = await tempDir(t, 'image-codex-shim-');
  const bin = join(root, 'bin'), script = join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  await mkdir(join(bin, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
  await writeFile(join(bin, 'codex.cmd'), '@echo off');
  await writeFile(script, "console.log('Logged in using ChatGPT')");
  const win = { platform: 'win32' as const, baseEnv: { Path: bin } };
  assert.deepEqual(resolveCodexLaunch('codex', win), { command: process.execPath, prefix: [script] }, 'the PATH variable is found whatever its case');
  assert.deepEqual(resolveCodexLaunch('codex', { ...win, platform: 'linux' }), { command: 'codex', prefix: [] }, 'only Windows');
  assert.deepEqual(resolveCodexLaunch('C:/tools/codex.exe', win), { command: 'C:/tools/codex.exe', prefix: [] }, 'an explicit path is used as configured');
  assert.deepEqual(resolveCodexLaunch('codex', { platform: 'win32', baseEnv: { Path: join(root, 'empty') } }), { command: 'codex', prefix: [] }, 'no shim on PATH');
  const bare = join(root, 'bare'); await mkdir(bare); await writeFile(join(bare, 'codex.cmd'), '@echo off');
  assert.deepEqual(resolveCodexLaunch('codex', { platform: 'win32', baseEnv: { Path: bare } }), { command: 'codex', prefix: [] }, 'a shim whose script is not where npm puts it is not guessed at');
  // End to end without a shell: the shim's script is run by node and the login check passes.
  const f = await fixture(t);
  await codexPreflight({ ...f.settings(), path: 'codex' }, { timeoutMs: 20_000, platform: 'win32', baseEnv: { Path: bin }, tmpRoot: f.tmpRoot });
});
