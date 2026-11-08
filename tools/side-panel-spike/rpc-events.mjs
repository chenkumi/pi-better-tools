// Which events does a plain `pi --mode rpc` child send while the model streams slowly?
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const cli = resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
const root = mkdtempSync(join(tmpdir(), 'spike-rpc-'));
const proc = spawn(process.execPath, [cli, '--mode', 'rpc', '--offline', '--no-extensions', '--no-approve', '--no-session', '-e', resolve('tools/side-panel-spike/fork-panel-ext.ts'), '--model', 'spike/fixture', '--thinking', 'off'], {
  cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: join(root, 'agent'), HOME: root, USERPROFILE: root, PI_OFFLINE: '1', SPIKE_FORCE_CHILD: '1', SPIKE_CHILD_CHUNKS: '8', SPIKE_CHILD_CHUNK_MS: '300' }, stdio: ['pipe', 'pipe', 'pipe'] });
const t0 = Date.now(); const counts = {}; let buf = '';
proc.stdout.setEncoding('utf8');
proc.stdout.on('data', d => { buf += d; for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { const line = buf.slice(0, i); buf = buf.slice(i + 1);
  try { const e = JSON.parse(line); const k = e.type === 'message_update' ? `message_update/${e.assistantMessageEvent?.type}` : e.type; counts[k] = (counts[k] ?? 0) + 1;
    if (k === 'message_update/text_delta' && (counts[k] === 3)) console.log('RAW DELTA:', line.slice(0, 700)); if (k === 'message_update/text_end') console.log('RAW END:', line.slice(0, 500)); } catch {} } });
setTimeout(() => proc.stdin.write(JSON.stringify({ id: '1', type: 'prompt', message: 'go' }) + '\n'), 3000);
setTimeout(() => { console.log('\nTOTALS', JSON.stringify(counts)); proc.kill(); process.exit(0); }, 9000);
