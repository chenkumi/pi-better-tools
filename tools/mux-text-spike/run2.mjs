// Scenario harness: abort / steer / followUp / stats over the side channel.
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pty from 'node-pty';

const ext = resolve('tools/mux-text-spike/viewer-ext.ts');
const home = mkdtempSync(join(tmpdir(), 'spike-'));
const events = []; let sock; const waiters = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const send = o => sock.write(JSON.stringify(o) + '\n');
const count = type => events.filter(e => e.type === type).length;
const until = (type, n, ms = 15000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout waiting ${type}#${n}`)), ms);
  const check = () => { if (count(type) >= n) { clearTimeout(t); res(); return true; } };
  if (!check()) waiters.push(check);
});
const server = createServer(s => {
  sock = s; let buf = '';
  s.on('data', d => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); events.push(m);
      console.log('  <-', JSON.stringify(m));
      for (let k = waiters.length - 1; k >= 0; k--) if (waiters[k]()) waiters.splice(k, 1);
    }
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const cli = resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
const p = pty.spawn(process.execPath, [cli, '-e', ext, '--no-extensions', '--provider', 'spike', '--model', 'fixture', '--no-skills', '--no-themes', '--no-approve'], {
  cwd: home, cols: 100, rows: 30,
  env: { ...process.env, SPIKE_PORT: String(server.address().port), PI_CODING_AGENT_DIR: join(home, 'agent'), HOME: home, USERPROFILE: home } });
let exited; p.onExit(e => { exited = e; console.log("  PROCESS EXITED", JSON.stringify(e)); });
const step = async (name, fn) => { console.log(`\n== ${name}`); await fn(); };
try {
  await until('hello', 1); await sleep(800);
  for (const [name, keys] of [['Esc', '\x1b'], ['Ctrl+C', '\x03'], ['Ctrl+C x2', '\x03\x03'], ['Ctrl+D', '\x04'], ['Ctrl+Z', '\x1a'], ['Ctrl+L', '\x0c'], ['Shift+Tab', '\x1b[Z']]) {
    if (exited) break;
    await step(name + ' during slow stream', async () => {
      const n = count('agent_start') + 1; send({ type: 'prompt', text: 'slow ' + name }); await until('agent_start', n); await sleep(500);
      p.write(keys); await sleep(1500);
      const last = events.filter(e => e.type === 'message_end' && e.role === 'assistant').at(-1);
      console.log('  => process alive:', !exited, '| last assistant stop:', last?.stop, '| still streaming:', count('agent_settled') < n);
      if (count('agent_settled') < n) { send({ type: 'abort' }); await until('agent_settled', n); }
    });
  }
  console.log('\nfinal: process alive =', !exited);
} catch (e) { console.log('FAIL', e.message); }
p.kill(); server.close(); process.exit(0);
