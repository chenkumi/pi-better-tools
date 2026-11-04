import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Real Pi CLI processes (a root and its Fork / Subagent child), an offline provider and isolated HOME / agentDir / workspace.
// The three extensions are loaded from the agent directory's settings, so every child loads them the way a user's Pi would.
const here = dirname(fileURLToPath(import.meta.url));
const entry = relative => fileURLToPath(new URL(relative, import.meta.url));
const extensions = [entry('../../fork/src/index.ts'), entry('../../subagents/extensions/subagent/index.ts'), entry('../src/index.ts'), join(here, 'fixtures/children-provider.ts')];
const cli = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'bundle/cli.js');
const DEADLINE_MS = 150_000;
const newline = String.fromCharCode(10);

async function run(kind) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-auto-compact-children-')));
  const config = join(root, 'config'), ws = join(root, 'ws'), sessions = join(root, 'sessions');
  try {
    for (const dir of [config, ws, sessions]) await mkdir(dir, { recursive: true });
    await writeFile(join(config, 'auth.json'), '{}');
    // The 100k-token offline window never reaches the default 200k minimum of the interval checkpoint.
    await writeFile(join(config, 'auto-compact.json'), JSON.stringify({ checkpointMinTokens: 1 }));
    await writeFile(join(config, 'settings.json'), JSON.stringify({ extensions, compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off', defaultProjectTrust: 'never' }));
    await writeFile(join(ws, 'probe.txt'), 'probe');
    const env = {};
    for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, { PI_CODING_AGENT_DIR: config, HOME: root, USERPROFILE: root, APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'), PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' });
    const proc = spawn(process.execPath, [cli, '--mode', 'rpc', '--offline', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-themes', '--model', 'children-offline/m', '--thinking', 'off', '--session-dir', sessions],
      { cwd: ws, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '', buffer = '';
    const events = [];
    const exit = new Promise(resolve => proc.once('close', resolve));
    proc.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384); });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      buffer += chunk;
      for (let at = buffer.indexOf(newline); at >= 0; at = buffer.indexOf(newline)) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); try { events.push(JSON.parse(line)); } catch { /* not an event */ } }
    });
    const deadline = setTimeout(() => proc.kill('SIGKILL'), DEADLINE_MS);
    proc.stdin.write(JSON.stringify({ id: 'p1', type: 'prompt', message: kind === 'fork' ? 'DO_FORK please' : 'DO_SUBAGENT please' }) + newline);
    // The child's result reaches the root as a message of its own; wait for it and for the root to settle after it.
    const isResult = e => e.type === 'message_end' && (kind === 'fork' ? e.message?.customType === 'fork-result' : e.message?.role === 'toolResult' && e.message.toolName === 'subagent');
    const done = () => { const at = events.findIndex(isResult); return at >= 0 && events.slice(at).some(e => e.type === 'agent_settled'); };
    await new Promise((resolve, reject) => {
      const timer = setInterval(() => { if (done()) { clearInterval(timer); resolve(); } }, 100);
      exit.then(code => { clearInterval(timer); if (!done()) reject(new Error(`Pi exited (${code}) before the root settled${newline}${stderr}`)); });
      setTimeout(() => { clearInterval(timer); reject(new Error(`deadline${newline}${stderr}`)); }, DEADLINE_MS).unref();
    });
    clearTimeout(deadline);
    proc.stdin.end();
    await Promise.race([exit, new Promise(resolve => setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 20_000))]);
    const files = [];
    const walk = async dir => { for (const item of await readdir(dir, { withFileTypes: true })) { const path = join(dir, item.name); if (item.isDirectory()) await walk(path); else if (item.name.endsWith('.jsonl')) files.push(path); } };
    await walk(root);
    const sessionsRead = [];
    for (const file of files) sessionsRead.push({ file, entries: (await readFile(file, 'utf8')).split(newline).filter(Boolean).map(line => JSON.parse(line)) });
    return { sessions: sessionsRead, stderr };
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}); }
}

for (const [kind, marker] of [['fork', 'FORK_CHECKPOINT_TASK'], ['subagent', 'SUBAGENT_CHECKPOINT_TASK']]) {
  test(`Pi 1.5.0 Pi Auto Compact checkpoint in a real ${kind} child process: the child loads the extension and answers through the anchor tool`, { timeout: DEADLINE_MS + 60_000 }, async () => {
    const { sessions, stderr } = await run(kind);
    // The root session holds the call that carries the marker too; the child's own session is the other file that contains it as a user message.
    const candidates = sessions.filter(({ entries }) => JSON.stringify(entries).includes(marker));
    const child = candidates.find(({ entries }) => entries.some(e => e.type === 'custom_message' && e.customType === 'pi-auto-compact:checkpoint'));
    assert.ok(child, `a ${kind} child session with a checkpoint request (sessions seen: ${candidates.length}, files: ${sessions.length})${newline}${stderr}`);
    const checkpoints = child.entries.filter(e => e.type === 'custom_message' && e.customType === 'pi-auto-compact:checkpoint');
    assert.equal(checkpoints.length, 1, 'exactly one request for one threshold');
    assert.match(String(checkpoints[0].content), /Call progress_checkpoint now/, 'the anchor tool was active in the child, so the request names it');
    const anchors = child.entries.filter(e => e.type === 'message' && e.message.role === 'assistant' && e.message.content.some(b => b.type === 'toolCall' && b.name === 'progress_checkpoint'));
    assert.equal(anchors.length, 1);
    const result = child.entries.find(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.toolName === 'progress_checkpoint');
    assert.ok(result && !result.message.isError, 'the anchor tool ran in the child');
    assert.ok(!child.entries.some(e => e.type === 'custom_message' && e.customType === 'pi-auto-compact:continue'), 'an anchor report needs no continuation');
    const last = child.entries.filter(e => e.type === 'message' && e.message.role === 'assistant').at(-1).message;
    assert.match(JSON.stringify(last.content), /CHILD_DONE/, 'the child went on to finish its work');
  });
}
