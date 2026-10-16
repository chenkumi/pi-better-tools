import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
const out = resolve('review-evidence/20261014-modules/validation47');
const root = await fs.mkdtemp(join(tmpdir(), 'pi-review47-'));
process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
process.env.HOME = process.env.USERPROFILE = root;
await fs.mkdir(process.env.PI_CODING_AGENT_DIR);
await fs.writeFile(join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), '{}');
await fs.writeFile(join(process.env.PI_CODING_AGENT_DIR, 'auth.json'), '{}');
const { default: extension } = await import('../../../modules/file-tools/extensions/file-tools.ts');
const { sha256Token } = await import('../../../modules/file-tools/src/file-operations.ts');
const tools = [];
extension({ registerTool: t => tools.push(t), on: () => () => {} });
const write = tools.find(t => t.name === 'write');
const edit = tools.find(t => t.name === 'edit');
const results = { environment: { node: process.version, platform: process.platform }, seam: 'real registered tools, fs link ENOTSUP fault injection, event barrier before fallback write', samples: [], cleanup: false };
const originalLink = fs.link, originalOpen = fs.open;
const watchdog = setTimeout(() => { console.error('Probe total deadline exceeded'); process.exit(2); }, 110000);
let failure;
try {
  for (let i = 1; i <= 3; i++) {
    console.log(`Progress: iteration ${i}/3 fallback atomic publication`);
    const target = join(root, `fallback${i}.txt`), payload = 'complete payload';
    let release, enter;
    const entered = new Promise(r => enter = r), barrier = new Promise(r => release = r);
    fs.link = async (...args) => { if (args[1] === target) throw Object.assign(new Error('Injected unsupported hard link'), { code: 'ENOTSUP' }); return originalLink(...args); };
    fs.open = async (...args) => {
      const h = await originalOpen(...args);
      if (args[0] === target && args[1] === 'wx') {
        const originalWrite = h.writeFile.bind(h);
        h.writeFile = async (...a) => { enter(); await barrier; return originalWrite(...a); };
      }
      return h;
    };
    syncBuiltinESMExports();
    const pending = write.execute(`fallback${i}`, { path: target, content: payload, expectedHash: 'missing' }, undefined, undefined, { cwd: root });
    pending.catch(() => {});
    let seen;
    try { await Promise.race([entered, pending.then(() => { throw new Error('Fallback barrier was not entered'); })]); seen = await fs.readFile(target, 'utf8'); }
    finally { release(); }
    const response = await pending;
    fs.link = originalLink; fs.open = originalOpen; syncBuiltinESMExports();
    assert.equal(await fs.readFile(target, 'utf8'), payload);
    assert.equal(response.details.bytes, Buffer.byteLength(payload));
    const control = join(root, `control${i}.txt`);
    await write.execute(`control${i}`, { path: control, content: payload, expectedHash: 'missing' }, undefined, undefined, { cwd: root });
    let overwriteRejected = false;
    try { await write.execute(`exclusive${i}`, { path: target, content: 'must not replace', expectedHash: 'missing' }, undefined, undefined, { cwd: root }); }
    catch { overwriteRejected = true; }
    assert(overwriteRejected); assert.equal(await fs.readFile(target, 'utf8'), payload);
    results.samples.push({ id: 'G4-001', iteration: i, observedWhilePending: seen, final: payload, exclusiveNoOverwrite: overwriteRejected, hardLinkControlComplete: (await fs.readFile(control, 'utf8')) === payload });
    console.log(`Progress: iteration ${i}/3 bounded line-map cost and formatter`);
    for (const shape of ['short', 'long']) {
      const before = (shape === 'short' ? '\n' : 'x').repeat(1024 * 1024) + 'UNIQUE_MARKER';
      const path = join(root, `map-${shape}-${i}.txt`);
      await fs.writeFile(path, before);
      const memoryBefore = process.memoryUsage(), start = performance.now();
      const r = await edit.execute(`map${i}`, { path, expectedHash: sha256Token(before), edits: [{ oldText: 'UNIQUE_MARKER', newText: 'UPDATED_MARKER' }] }, undefined, undefined, { cwd: root });
      const elapsedMs = performance.now() - start;
      assert.equal(await fs.readFile(path, 'utf8'), before.replace('UNIQUE_MARKER', 'UPDATED_MARKER'));
      assert.match(r.content[0].text, /FILE_EDIT_SUCCESS/);
      results.samples.push({ id: 'G4-002', iteration: i, shape, bytes: Buffer.byteLength(before), elapsedMs, memoryBefore, memoryAfter: process.memoryUsage(), diskAndFeedbackCorrect: true });
      await fs.rm(path);
    }
    const path = join(root, `formatter${i}.txt`), updated = 'x\n'.repeat(200000) + 'z';
    await fs.writeFile(path, 'original');
    const start = performance.now();
    const r = await edit.execute(`format${i}`, { path, edits: [{ oldText: 'original', newText: updated }] }, undefined, undefined, { cwd: root });
    assert.equal(await fs.readFile(path, 'utf8'), updated);
    assert.equal(r.details.sha256After, sha256Token(updated));
    assert.equal(r.details.added, 200001);
    assert(r.content[0].text.split('\n').length <= 44);
    results.samples.push({ id: 'G4-003', iteration: i, bytes: Buffer.byteLength(updated), elapsedMs: performance.now() - start, feedbackBytes: Buffer.byteLength(r.content[0].text), diskAndFeedbackCorrect: true });
    await fs.rm(path);
    const remaining = await fs.readdir(root);
    assert(!remaining.some(p => p.startsWith('.pi-ft-')));
    results.samples.push({ id: 'cleanup-check', iteration: i, noOwnedTempFiles: true });
  }
} catch (e) { failure = e; results.failure = { message: e.message, stack: e.stack }; }
finally {
  fs.link = originalLink; fs.open = originalOpen; syncBuiltinESMExports();
  clearTimeout(watchdog);
  try { await fs.rm(root, { recursive: true, force: true }); results.cleanup = true; } catch (e) { results.cleanupError = e.message; failure ??= e; }
  await fs.writeFile(join(out, 'file-results.json'), JSON.stringify(results, null, 2));
}
console.log(`Progress: completed; samples=${results.samples.length}, cleanup=${results.cleanup}`);
if (failure) { console.error(failure); process.exitCode = 1; }
