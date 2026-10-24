import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedEnv } from '../../../../tests/helpers/environment.mjs';

const require = createRequire(import.meta.url), pty = require('node-pty');
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const host = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
const cli = join(host, 'bundle/cli.js');
const observer = fileURLToPath(new URL('./tui-observer.ts', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');

export async function startArm(directory, enabled, mode, options = {}) {
  const home = join(directory, enabled ? 'B' : 'A'), cwd = join(home, 'workspace');
  const agent = join(home, '.pi/agent'), journal = join(home, 'journal.jsonl');
  await mkdir(join(cwd, 'docs'), { recursive: true }); await mkdir(agent, { recursive: true });
  await writeFile(join(agent, 'auth.json'), '{}');
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false },
    cacheWarming: 'off', enableInstallTelemetry: false, defaultProjectTrust: 'never' }));
  await writeFile(join(cwd, 'seed.txt'), 'before'); await writeFile(join(cwd, 'control.txt'), 'unchanged');
  await writeFile(join(cwd, 'docs/sources.json'), JSON.stringify({ modules: [] }));
  await writeFile(join(cwd, 'docs/native-modules.json'), JSON.stringify({ modules: [] }));
  await writeFile(join(cwd, 'docs/adaptations.json'), JSON.stringify({ files: [], addedFiles: [], localSourceSuiteFinalIntegration: {
    rootFiles: [{ path: 'seed.txt', sha256: hash('before') }, { path: 'control.txt', sha256: hash('unchanged') }] } }));
  await writeFile(journal, '');
  let terminal, exited = false, output = '', resolveExit;
  const exit = new Promise(done => { resolveExit = done; });
  const pending = new Set();
  const records = async () => (await readFile(journal, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const watcher = watch(journal, () => { for (const refresh of pending) void refresh(); });
  const until = (predicate, label) => new Promise((done, reject) => {
    let reading = false, again = false, settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); pending.delete(refresh); error ? reject(error) : done(value); };
    const refresh = async () => {
      if (settled) return;
      if (reading) { again = true; return; } reading = true;
      try { const found = (await records()).find(predicate); if (found) finish(null, found); }
      catch (error) { finish(error); }
      finally { reading = false; if (again && !settled) { again = false; void refresh(); } }
    };
    const timer = setTimeout(() => finish(new Error(`${label}: no evidence; PTY tail: ${output.slice(-4000)}`)), 30000);
    pending.add(refresh); void refresh();
  });
  const awaitExit = async () => {
    let timer;
    try { return await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned CLI exit unconfirmed')), 15000); })]); }
    finally { clearTimeout(timer); }
  };
  const save = async () => {
    await writeFile(join(home, 'terminal.raw.txt'), output);
    return { home, cwd, records: await records(), output };
  };
  const close = async () => {
    watcher.close();
    if (terminal && !exited) terminal.write('\x04');
    let result;
    try { result = terminal ? await awaitExit() : null; }
    catch (error) { if (terminal && !exited) terminal.kill(); await awaitExit(); throw error; }
    finally {
      // node-pty Windows: release only this owned ConPTY's input handles AFTER exit.
      if (exited && process.platform === 'win32') { terminal?._agent?._inSocket?.destroy(); terminal?._agent?._conoutSocketWorker?.dispose(); }
    }
    if (terminal) assert.equal(result.exitCode, 0, JSON.stringify(result));
    return result;
  };
  try {
    const extensions = [options.observer ?? observer, join(root, 'modules/file-tools/src/index.ts'), join(root, 'modules/note-tools/src/index.ts'),
      ...(enabled ? [join(root, 'modules/file-audit/src/index.ts')] : [])];
    terminal = pty.spawn(process.execPath, [cli, '--offline', '--no-approve', '--no-session', '--no-extensions', '--no-skills',
      '--no-themes', '--no-context-files', '--no-prompt-templates', '--tools', options.tools ?? 'read,write,edit,note',
      ...extensions.flatMap(path => ['-e', path]), '--model', 'audit-ab-offline/fixture', '--thinking', 'off', '--tui-mode', mode], {
      cwd, cols: 160, rows: 50, name: 'xterm-256color', env: { ...isolatedEnv(home), TERM: 'xterm-256color', FILE_AUDIT_AB_JOURNAL: journal },
    });
    terminal.onData(data => { output = (output + data).slice(-2000000); });
    terminal.onExit(event => { exited = true; resolveExit(event); });
    const ready = await until(row => row.event === 'ready', 'real TUI startup');
    assert.equal(ready.mode, 'tui'); assert.equal(ready.auditLoaded, enabled);
    const snapshot = async label => {
      terminal.write(`/ab-observe ${label}\r`);
      const result = await until(row => row.event === 'snapshot' && row.label === label, `snapshot ${label}`);
      assert.equal(result.mode, mode); assert.equal(result.columns, 160);
      return result;
    };
    const prompt = async label => {
      terminal.write(`${label}\r`);
      const result = await until(row => row.event === 'settled' && row.scenario === label, `settled ${label}`);
      assert.equal(result.aborted, false);
      return result;
    };
    const command = async (args, pattern, name = 'file-audit') => {
      const before = (await records()).length;
      terminal.write(`/${name} ${args}\r`);
      return until((row, index) => index >= before && row.event === 'notification' && pattern.test(row.message), `command ${args}`);
    };
    return { home, cwd, enabled, terminal, records, prompt, command, snapshot, close, save };
  } catch (error) {
    await save(); await close(); throw error;
  }
}

// The observer records the explicit semantic payload after onPayload hooks, plus
// the untouched transcript separately. Only fixture roots/note filenames are
// normalized here; audit strings, prompt sections and tool schemas are NEVER removed.
export function requestText(request, home, normalize) {
  const value = JSON.stringify(request.payload);
  if (!normalize) return value;
  // Tool results can embed the resolved path inside nested JSON text, so cover several escape depths (deepest first).
  let escapedHome = home;
  const homeForms = [];
  for (let depth = 0; depth < 3; depth++) { escapedHome = JSON.stringify(escapedHome).slice(1, -1); homeForms.unshift(escapedHome); }
  let text = value;
  for (const form of homeForms) text = text.split(form).join('<HOME>');
  return text
    .split(home.replaceAll('\\', '/')).join('<HOME>')
    .replace(/TASK-\d{8}T\d{9}Z\.md/g, 'TASK-<UTC>.md');
}

export async function runComparison(mode, order, evidenceDir, tokenizer) {
  const directory = await mkdtemp(join(tmpdir(), `file-audit-tui-${mode}-`));
  const observations = {};
  const beat = setInterval(() => console.log(`[file-audit-ab] ${mode}: real PTY experiment still running...`), 10000);
  let success = false;
  try {
    for (const enabled of order) {
      const label = enabled ? 'B' : 'A';
      console.log(`[file-audit-ab] ${mode}/${label}: starting isolated Pi TUI, audit=${enabled}`);
      const arm = await startArm(directory, enabled, mode);
      try {
        await arm.prompt('AB_BASELINE');
        const before = await arm.snapshot('baseline');
        let status, scan, capacity, expired;
        if (enabled) {
          status = await arm.command('status', /Candidates: 3/);
          assert.match(status.message, /modified: seed\.txt/);
          assert.match(status.message, /read: control\.txt/);
          assert.match(status.message, /created: tasks[\\/]TASK-/);
          assert.doesNotMatch(status.message, /missing\.txt/);
          scan = await arm.command('check', /Selected: 3; checked: 2/);
          for (const pattern of [/mismatch=1/, /matched=1/, /untracked=1/, /mismatch: seed\.txt/, /untracked: tasks[\\/]TASK-/]) assert.match(scan.message, pattern);
          const rendered = await arm.snapshot('audit-report');
          // Fullscreen render() is the editor layout; getScreenLines() is the
          // actual complete frame (including its separately managed message pane).
          const screen = (mode === 'fullscreen' ? rendered.screenLines : rendered.lines).join('\n');
          assert.match(screen, /Selected: 3; checked: 2/);
          assert.match(screen, /mismatch: seed\.txt/);
          assert.equal(rendered.requests, before.requests, 'manual commands must not request a model');
        }
        await arm.prompt('AB_AFTER_CHECK');
        await arm.snapshot('follow-up');
        if (enabled) await arm.command('limits --max-files 2', /max-files: 2/);
        await arm.prompt('AB_CAPACITY');
        if (enabled) {
          capacity = await arm.command('status', /Candidates: 2/);
          assert.match(capacity.message, /capacity=[1-9]\d*/);
          assert.match(capacity.message, /beta\.txt/); assert.match(capacity.message, /gamma\.txt/);
          assert.doesNotMatch(capacity.message, /(?:seed|control|alpha)\.txt|created: tasks[\\/]/);
          await arm.command('limits --window 1', /window: 1/);
        }
        await arm.prompt('AB_NOOP');
        if (enabled) {
          expired = await arm.command('status', /Candidates: 0/);
          assert.match(expired.message, /expired=[1-9]\d*/);
        }
        await arm.snapshot('final');
        assert.equal(await readFile(join(arm.cwd, 'seed.txt'), 'utf8'), 'after');
        const notes = await readdir(join(arm.cwd, 'tasks')); assert.equal(notes.length, 1);
        assert.equal(await readFile(join(arm.cwd, 'tasks', notes[0]), 'utf8'), '# A/B note\n\nDeterministic fixture body.');
        for (const name of ['alpha', 'beta', 'gamma']) assert.equal(await readFile(join(arm.cwd, `${name}.txt`), 'utf8'), name);
        const final = await arm.close();
        const saved = await arm.save();
        assert.ok(saved.records.some(row => row.event === 'shutdown'));
        assert.equal(saved.records.filter(row => row.event === 'network-attempt').length, 0);
        const requests = saved.records.filter(row => row.event === 'request'); assert.equal(requests.length, 12);
        assert.ok(requests[0].payload.systemPrompt.length > 100, 'system prompt must be measured');
        assert.deepEqual(requests[0].payload.tools.map(tool => tool.name).sort(), ['edit', 'note', 'read', 'write']);
        assert.ok(saved.output.includes('AB_BASELINE_DONE'), 'actual terminal output contains rendered model completion');
        if (enabled) {
          assert.ok(saved.output.includes('File Audit'), 'actual PTY contains audit notification');
          assert.ok(saved.output.includes('Selected: 3; checked: 2'), 'actual PTY receives the complete check report');
        }
        else assert.equal(saved.records.filter(row => row.event === 'notification' && row.message.includes('File Audit')).length, 0);
        observations[label] = { ...saved, requests, status: status?.message, scan: scan?.message, capacity: capacity?.message, expired: expired?.message,
          exitCode: final.exitCode, networkCalls: 0 };
        console.log(`[file-audit-ab] ${mode}/${label}: 12 scripted requests, network=0, real CLI exited 0`);
      } finally { try { await arm.close(); } finally { await arm.save(); } }
    }
    const A = observations.A, B = observations.B;
    const perRequest = A.requests.map((request, index) => {
      const texts = [requestText(request, A.home, true), requestText(B.requests[index], B.home, true)];
      assert.equal(texts[1], texts[0], `normalized provider context/tools differ at ${mode} request ${index + 1}`);
      assert.doesNotMatch(texts[1], /File Audit|recent incremental inspection|Observation starts:/);
      const raw = [requestText(request, A.home, false), requestText(B.requests[index], B.home, false)];
      const count = text => tokenizer ? tokenizer.encode(text).length : null;
      return { nth: index + 1, scenario: request.scenario, normalizedSha256: hash(texts[0]),
        normalizedBytes: Buffer.byteLength(texts[0]), rawBytesA: Buffer.byteLength(raw[0]), rawBytesB: Buffer.byteLength(raw[1]),
        estimatedRawTokensA: count(raw[0]), estimatedRawTokensB: count(raw[1]),
        estimatedNormalizedTokensA: count(texts[0]), estimatedNormalizedTokensB: count(texts[1]) };
    });
    const sum = key => tokenizer ? perRequest.reduce((value, row) => value + row[key], 0) : null;
    const result = { mode, order: order.map(on => on ? 'B' : 'A'), callsA: A.requests.length, callsB: B.requests.length,
      extraCalls: 0, externalCalls: 0, normalizedPayloadsEqual: true,
      tokenizer: tokenizer ? 'js-tiktoken@1.0.21 o200k_base; serialized semantic messages/tools estimate, NOT billed usage' : null,
      rawTokenEstimateA: sum('estimatedRawTokensA'), rawTokenEstimateB: sum('estimatedRawTokensB'),
      normalizedTokenEstimateA: sum('estimatedNormalizedTokensA'), normalizedTokenEstimateB: sum('estimatedNormalizedTokensB'),
      status: B.status, scan: B.scan, capacity: B.capacity, expired: B.expired,
      exitCodes: [A.exitCode, B.exitCode], perRequest };
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true });
      for (const label of ['A', 'B']) {
        await writeFile(join(evidenceDir, `${mode}-${label}.journal.jsonl`), observations[label].records.map(row => JSON.stringify(row)).join('\n') + '\n');
        await writeFile(join(evidenceDir, `${mode}-${label}.terminal.raw.txt`), observations[label].output);
      }
      await writeFile(join(evidenceDir, `${mode}-summary.json`), JSON.stringify(result, null, 2));
    }
    success = true;
    return result;
  } finally {
    clearInterval(beat);
    if (success) { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); console.log(`[file-audit-ab] ${mode}: owned CLI exits confirmed; isolated workspaces removed`); }
    else console.error(`[file-audit-ab] Failure evidence retained at ${directory}`);
  }
}

export async function loadTokenizer() {
  const path = process.env.FILE_AUDIT_AB_TOKENIZER;
  if (!path) return null;
  const entry = resolve(path);
  const metadata = JSON.parse(await readFile(join(dirname(entry), '../package.json'), 'utf8'));
  assert.equal(metadata.name, 'js-tiktoken'); assert.equal(metadata.version, '1.0.21');
  const { getEncoding } = await import(pathToFileURL(entry).href);
  return getEncoding('o200k_base');
}
