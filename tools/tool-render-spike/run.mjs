// Real Pi TUI (fullscreen) in a PTY with the global tool renderer: collapsed screen, a mouse click on a result, expanded screen.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import pty from 'node-pty';

const { Terminal } = createRequire(resolve('tools/pty-mcp/package.json'))('@xterm/headless');
const cli = resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
const root = mkdtempSync(join(tmpdir(), 'spike-toolrender-'));
const ws = join(root, 'ws'), agent = join(root, 'agent');
for (const d of [ws, agent]) mkdirSync(d, { recursive: true });
writeFileSync(join(ws, 'sample.txt'), Array.from({ length: 30 }, (_, i) => `line ${i + 1} ${i === 11 ? 'needle' : 'plain text'}`).join('\n') + '\n');
const cols = 100, rows = 40;
const term = new Terminal({ cols, rows, allowProposedApi: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const env = {};
for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)']) if (process.env[key]) env[key] = process.env[key];
Object.assign(env, { ...(process.env.SPIKE_SCRIPT ? { SPIKE_SCRIPT: process.env.SPIKE_SCRIPT } : {}), ...(process.env.SPIKE_NO_RENDERER ? { SPIKE_NO_RENDERER: '1' } : {}), PI_CODING_AGENT_DIR: agent, HOME: root, USERPROFILE: root, APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'), PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' });
const extra = process.env.SPIKE_EXT ? process.env.SPIKE_EXT.split(',').flatMap(e => ['-e', resolve(e)]) : [];
const p = pty.spawn(process.execPath, [cli, '--offline', '--no-extensions', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-approve',
  '-e', resolve('tools/tool-render-spike/ext.ts'), ...extra, '--model', 'spike/fixture', '--thinking', 'off', '--tools', process.env.SPIKE_TOOLS || 'read,write,grep,bash'], { cwd: ws, cols, rows, env });
p.onData(d => term.write(d));
const dump = title => { console.log(`\n===== ${title} =====`); for (let y = 0; y < rows; y++) { const line = term.buffer.active.getLine(y)?.translateToString(true) ?? ''; if (line.trim()) console.log(String(y).padStart(2) + '|' + line); } };
const ESC = String.fromCharCode(27);
const click = (x, y) => { p.write(`${ESC}[<0;${x};${y}M`); p.write(`${ESC}[<0;${x};${y}m`); };
await sleep(Number(process.env.SPIKE_START_MS || 5000));
p.write('run the tools'); await sleep(300); p.write(String.fromCharCode(13));
await sleep(14000); dump('collapsed (after all tool calls)');
// find the row of the first "[Click to expand]" and click on it
let target = -1;
for (let y = 0; y < rows; y++) if ((term.buffer.active.getLine(y)?.translateToString(true) ?? '').includes('[Click to expand]')) { target = y; break; }
console.log(`\nfirst expand hint at row ${target}`);
if (target >= 0) { click(10, target + 1); await sleep(1200); dump('after clicking the first result'); }
p.write(String.fromCharCode(15)); await sleep(1200); dump('after Ctrl+O (expand all)');
p.kill(); process.exit(0);
