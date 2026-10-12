import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { isolatedEnv } from '../../../tests/helpers/environment.mjs';
const require = createRequire(import.meta.url), pty = require('node-pty');
const cli = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'bundle/cli.js');
const extension = fileURLToPath(new URL('./fixtures/jobs-tui.ts', import.meta.url));
for (const mode of ['regular', 'fullscreen']) {
  test(`Pi1.1.0 actual ${mode} terminal: five jobs above editor, More/details, draft/focus, updates and resize`, { timeout: 60000 }, async () => {
    console.log(`[jobs-tui] Starting isolated ${mode} CLI with zero provider calls`);
    const root = await mkdtemp(join(tmpdir(), 'pi-jobs-tui-')), agent = join(root, '.pi/agent'), journal = join(root, 'observations.jsonl');
    await mkdir(agent, { recursive: true }); await writeFile(join(agent, 'settings.json'), JSON.stringify({ compaction: { enabled: false }, cacheWarming: 'off', defaultProjectTrust: 'never' })); await writeFile(join(agent, 'auth.json'), '{}'); await writeFile(journal, '');
    let terminal, exited = false, output = '';
    const pending = new Set(); let exitResolve; const exit = new Promise(resolve => { exitResolve = resolve; });
    const awaitExit = async (ms = 10000) => { let timer; try { return await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CLI did not exit')), ms); })]); } finally { clearTimeout(timer); } };
    const read = async () => { const data = await readFile(journal, 'utf8'); return data.split('\n').filter(Boolean).map(s => JSON.parse(s)); };
    const watcher = watch(journal, () => { for (const refresh of pending) void refresh(); });
    async function until(predicate, label) {
      return new Promise((resolve, reject) => {
        let reading = false, again = false, settled = false;
        const timer = setTimeout(() => { settled = true; pending.delete(refresh); reject(new Error(`Timed out waiting for ${label}; terminal tail: ${output.slice(-3000)}`)); }, 15000);
        const refresh = async () => {
          if (settled) return;
          if (reading) { again = true; return; } reading = true;
          try { const records = await read(); const found = records.find(predicate); if (found) { settled = true; clearTimeout(timer); pending.delete(refresh); resolve(found); } }
          catch (error) { settled = true; clearTimeout(timer); pending.delete(refresh); reject(error); }
          finally { reading = false; if (again && !settled) { again = false; void refresh(); } }
        };
        pending.add(refresh); void refresh();
      });
    }
    async function resize(columns, rows) {
      const before = (await read()).length; terminal.resize(columns, rows);
      await until((r, index) => index >= before && r.event === 'widget' && r.width === columns && r.rows === rows, `resize ${columns}x${rows}`);
    }
    async function snapshot() {
      const before = (await read()).length;
      terminal.write('\x19');
      return until((r, index) => r.event === 'snapshot' && index >= before, 'new snapshot');
    }
    try {
      terminal = pty.spawn(process.execPath, [cli, '--no-session', '--no-tools', '-ne', '-ns', '-np', '--no-themes', '-e', extension, '--tui-mode', mode], { cwd: root, cols: 100, rows: 30, name: 'xterm-256color', env: { ...isolatedEnv(root), TERM: 'xterm-256color', JOBS_TUI_EVIDENCE: journal } });
      terminal.onData(data => { output = (output + data).slice(-200000); }); terminal.onExit(event => { exited = true; exitResolve(event); });
      await until(r => r.event === 'ready', 'fixture session start');
      const initial = await snapshot(); assert.equal(initial.mode, mode); assert.equal(initial.overlay, false);
      const moreIndex = initial.lines.findIndex(s => s.includes('More…')), jobsIndex = initial.lines.findIndex(s => s.includes('Jobs · 6 active'));
      assert.ok(jobsIndex >= 0 && moreIndex > jobsIndex, JSON.stringify(initial));
      const widget = (await read()).filter(r => r.event === 'widget').at(-1); assert.equal(widget.placement, 'aboveEditor'); assert.equal(widget.lines.length, 12); assert.equal(widget.lines.filter(s => /[●◷◐] (?:SA|SH)/.test(s)).length, 5);
      terminal.write('draft_keep'); const typed = await snapshot(); assert.equal(typed.draft, 'draft_keep');
      assert.ok(typed.lines.findIndex(s => s.includes('draft_keep')) > moreIndex, 'actual host mounts panel above the editor');
      if (mode === 'fullscreen') {
        const row = typed.screenLines.findIndex(s => s.includes('More…')) + 1;
        assert.ok(row > 0 && row <= typed.rows, 'mouse coordinates use actual fullscreen frame, not scrollback document');
        terminal.write(`\x1b[<0;3;${row}M\x1b[<0;3;${row}m`);
      } else terminal.write('\x14');
      await until(r => r.event === 'opening', 'More opened'); const opened = await snapshot(); assert.equal(opened.overlay, true); assert.equal(opened.draft, 'draft_keep');
      assert.match(opened.overlayLines.join('\n'), /Active \/ Recent finished/); assert.ok(opened.overlayLines.length <= 20);
      terminal.write('\x1b[B\r'); const details = await snapshot(); assert.match(details.overlayLines.join('\n'), /Job details/);
      terminal.write('\x02'); await until(r => r.event === 'updated', 'metadata update'); const updated = await snapshot(); assert.equal(updated.overlay, true); assert.equal(updated.draft, 'draft_keep');
      assert.match(updated.overlayLines.join('\n'), /reported 1\.2k tok\*/); assert.equal((await read()).filter(r => r.event === 'opening').length, 1, 'background render does not reopen overlay');
      await resize(40, 12);
      const smallDetail = await snapshot(); assert.equal(smallDetail.overlay, true); assert.ok(smallDetail.overlayLines.length <= 10); assert.match(smallDetail.overlayLines.join('\n'), /Esc Back/);
      terminal.write('\x1b[6~'); const scrolled = await snapshot(); assert.match(scrolled.overlayLines.join('\n'), /Long detail/);
      await resize(120, 40);
      const largeDetail = await snapshot(); assert.equal(largeDetail.overlay, true); assert.ok(largeDetail.overlayLines.length <= 20); assert.equal(largeDetail.draft, 'draft_keep');
      terminal.write('\x1b[27u'); const back = await snapshot(); assert.equal(back.overlay, true); assert.match(back.overlayLines.join('\n'), /Active \/ Recent finished/);
      terminal.write('\x1b[27u'); await until(r => r.event === 'closed', 'Esc closes More'); terminal.write('_after'); const restored = await snapshot(); assert.equal(restored.overlay, false); assert.equal(restored.draft, 'draft_keep_after'); assert.equal(restored.focus, typed.focus);
      await resize(40, 12); const narrow = await snapshot(); assert.equal(narrow.columns, 40); assert.equal(narrow.rows, 12);
      const narrowWidget = (await read()).filter(r => r.event === 'widget' && r.width === 40 && r.rows === 12).at(-1); assert.ok(narrowWidget); assert.equal(narrowWidget.lines.length, 4); assert.match(narrowWidget.lines.at(-1), /\+5 active/);
      await resize(120, 40); const wide = await snapshot(); assert.equal(wide.columns, 120); assert.equal(wide.draft, 'draft_keep_after');
      assert.ok(output.includes('Jobs'), 'real PTY receives rendered TUI output'); assert.equal((await read()).filter(r => r.event.startsWith('forbidden-')).length, 0);
      const reopenIndex = (await read()).length; terminal.write('\x14'); await until((r, index) => r.event === 'opening' && index >= reopenIndex, 'reopen for owner-dispose');
      assert.equal((await snapshot()).overlay, true); terminal.write('\x07'); await until(r => r.event === 'disposed-owner', 'disposed-owner close');
      terminal.write('_disposed'); const disposed = await snapshot(); assert.equal(disposed.overlay, false); assert.equal(disposed.draft, 'draft_keep_after_disposed'); assert.equal(disposed.focus, typed.focus);
      terminal.write('\x04'); const final = await awaitExit(); assert.equal(final.exitCode, 0);
      console.log(`[jobs-tui] ${mode}: actual layout/More/focus/resize passed, providerCalls=0`);
    } catch (error) {
      console.error(`[jobs-tui] ${mode} failed: ${error.stack}`);
      console.error(`[jobs-tui] Last observations: ${JSON.stringify((await read()).slice(-2))}`);
      throw error;
    } finally {
      watcher.close();
      if (terminal && !exited) { terminal.write('\x04'); try { await awaitExit(2000); } catch { terminal.kill(); await awaitExit(); } }
      // node-pty beta Windows natural-exit cleanup closes only outSocket; release this test's
      // owned input pipe/worker AFTER actual exit. No second native kill on an exited ConPTY.
      if (exited && process.platform === 'win32') { terminal?._agent?._inSocket?.destroy(); terminal?._agent?._conoutSocketWorker?.dispose(); }
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}
