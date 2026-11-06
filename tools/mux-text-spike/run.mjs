// Spike harness: listens on a loopback port, runs interactive Pi in a PTY with the viewer extension, sends a prompt over the side channel.
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pty from 'node-pty';
import { createRequire } from 'node:module';
const { Terminal } = createRequire(resolve('tools/pty-mcp/package.json'))('@xterm/headless');
const term = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
const ext = resolve('tools/mux-text-spike/viewer-ext.ts');
const home = mkdtempSync(join(tmpdir(), 'spike-'));
const events = []; let screen = '';
const server = createServer(sock => {
  let buf = '';
  sock.on('data', d => { buf += d; for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); events.push(m); console.log('EVENT', JSON.stringify(m));
    if (m.type === 'hello') setTimeout(() => sock.write(JSON.stringify({ type: 'prompt', text: 'hello from parent' }) + '\n'), 1500);
    if (m.type === 'agent_settled') setTimeout(done, 1000); } });
});
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const cli = resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
  const p = pty.spawn(process.execPath, [cli, '-e', ext, '--no-extensions', '--provider', 'spike', '--model', 'fixture', '--no-skills', '--no-themes', '--no-approve'], { cwd: home, cols: 100, rows: 30,
    env: { ...process.env, SPIKE_PORT: String(port), PI_CODING_AGENT_DIR: join(home, 'agent'), HOME: home, USERPROFILE: home } });
  p.onData(d => { screen += d; term.write(d); });
  globalThis.p = p;
  setTimeout(() => { console.log('TIMEOUT'); done(); }, 30000);
});
function done() {
  const rows = []; for (let y = 0; y < 30; y++) rows.push(term.buffer.active.getLine(y)?.translateToString(true) ?? '');
  console.log('--- final screen ---\n' + rows.map((r, i) => String(i).padStart(2) + '|' + r).join('\n'));
  const plain = screen.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '');
  console.log('--- visible text (last 1200 chars) ---\n' + plain.slice(-1200));
  globalThis.p?.kill(); server.close(); process.exit(0);
}
