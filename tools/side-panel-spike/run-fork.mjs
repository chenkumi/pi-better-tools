// Real Pi TUI in a PTY + the real Fork module + a right-hand column showing the running Fork's live conversation.
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import pty from 'node-pty';

const { Terminal } = createRequire(resolve('tools/pty-mcp/package.json'))('@xterm/headless');
const forkEntry = resolve('modules/fork/src/index.ts');
const panelExt = resolve('tools/side-panel-spike/fork-panel-ext.ts');
const cli = resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
const root = mkdtempSync(join(tmpdir(), 'spike-forkpanel-'));
const ws = join(root, 'ws'), agent = join(root, 'agent'), sessions = join(root, 'sessions'), capture = join(root, 'capture');
for (const d of [ws, agent, sessions, capture]) mkdirSync(d, { recursive: true });
const logFile = join(root, 'spike.log');
const cols = 120, rows = 30;
const term = new Terminal({ cols, rows, allowProposedApi: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const env = {};
for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)']) if (process.env[key]) env[key] = process.env[key];
Object.assign(env, { PI_CODING_AGENT_DIR: agent, HOME: root, USERPROFILE: root, APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'), PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1', SPIKE_LOG: logFile, FORK_CAPTURE: capture, SPIKE_CHILD_CHUNKS: '40', SPIKE_CHILD_CHUNK_MS: '400', ...(process.env.SPIKE_TEE ? { SPIKE_TEE: '1' } : {}) });
const p = pty.spawn(process.execPath, [cli, '--offline', '--no-extensions', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-approve',
  '-e', forkEntry, '-e', panelExt, '--model', 'spike/fixture', '--thinking', 'off', '--tools', 'read,fork,fork_status', '--session-dir', sessions], { cwd: ws, cols, rows, env });
p.onData(d => term.write(d));
const ENTER = String.fromCharCode(13);
const dump = title => {
  console.log(`\n===== ${title} =====`);
  for (let y = 0; y < rows; y++) { const line = term.buffer.active.getLine(y)?.translateToString(true) ?? ''; if (line.trim()) console.log(String(y).padStart(2) + '|' + line); }
};
await sleep(5000); dump('startup');
p.write('DO_FORK now'); await sleep(300); p.write(ENTER);
const column = title => {
  console.log(`\n===== ${title} (right column only) =====`);
  for (let y = 0; y < rows; y++) { const line = (term.buffer.active.getLine(y)?.translateToString(true) ?? '').slice(76); if (line.replace('│', '').trim()) console.log(String(y).padStart(2) + '|' + line); }
};
const started = Date.now();
for (let t = 0; t < 14; t++) { await sleep(2500); column(`t=${((Date.now() - started) / 1000).toFixed(1)}s after sending the prompt`); }
console.log(`\n--- extension log ---\n${existsSync(logFile) ? readFileSync(logFile, 'utf8') : '(none)'}`);
p.kill(); process.exit(0);
