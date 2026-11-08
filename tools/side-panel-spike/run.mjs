// Drive Pi in a PTY, dump the final screen (xterm headless) at several points.
// Env: SPIKE_REGULAR=1 -> tuiMode "regular"; SPIKE_RELOAD=1 -> run /reload instead of a chat turn.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import pty from 'node-pty';

const { Terminal } = createRequire(resolve('tools/pty-mcp/package.json'))('@xterm/headless');
const ext = resolve('tools/side-panel-spike/panel-ext.ts');
const cli = resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
const home = mkdtempSync(join(tmpdir(), 'spike-panel-'));
const logFile = join(home, 'spike.log');
if (process.env.SPIKE_REGULAR) { mkdirSync(join(home, 'agent'), { recursive: true }); writeFileSync(join(home, 'agent', 'settings.json'), JSON.stringify({ tuiMode: 'regular' })); }
let cols = 100, rows = 28;
const term = new Terminal({ cols, rows, allowProposedApi: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const p = pty.spawn(process.execPath, [cli, '-e', ext, '--no-extensions', '--provider', 'spike', '--model', 'fixture', '--no-skills', '--no-themes', '--no-approve'], {
  cwd: home, cols, rows, env: { ...process.env, SPIKE_LOG: logFile, PI_CODING_AGENT_DIR: join(home, 'agent'), HOME: home, USERPROFILE: home } });
p.onData(d => term.write(d));
const ENTER = String.fromCharCode(13), BACKSPACE = String.fromCharCode(127);
const dump = title => {
  console.log(`\n===== ${title} (${cols}x${rows}, ${term.buffer.active.type} buffer) =====`);
  for (let y = 0; y < rows; y++) { const line = term.buffer.active.getLine(y)?.translateToString(true) ?? ''; if (line.trim() || y < 4) console.log(String(y).padStart(2) + '|' + line); }
};
const cursor = () => { const b = term.buffer.active; return `row=${b.cursorY} col=${b.cursorX}`; };

await sleep(4000); dump('startup');
p.write('abc'); await sleep(500);
console.log(`\ncursor after typing "abc": ${cursor()}`);
dump('after typing abc');
p.write(BACKSPACE.repeat(3)); await sleep(300);
if (process.env.SPIKE_RELOAD) { p.write('/reload'); await sleep(300); p.write(ENTER); await sleep(4000); dump('after /reload'); }
else { p.write('hello panel'); await sleep(300); p.write(ENTER); await sleep(2500); dump('after one chat turn'); }
console.log(`\n--- extension log ---\n${existsSync(logFile) ? readFileSync(logFile, 'utf8') : '(none)'}`);
p.kill(); process.exit(0);
