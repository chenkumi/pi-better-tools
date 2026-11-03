// Scores a finished workspace against expected.json. Exit code 0 only if everything passes.
//   node score.mjs --dir <out>   (the directory gen.mjs wrote: contains workspace/ and expected.json)
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const at = process.argv.indexOf('--dir');
const dir = at >= 0 ? process.argv[at + 1] : undefined;
if (!dir || dir.startsWith('--')) { console.error('usage: node score.mjs --dir <out>'); process.exit(2); }
const ws = resolve(dir, 'workspace'), expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'));
const pad = n => String(n).padStart(3, '0');
const results = [];

for (const item of expected.itemsExpected) {
  const problems = [];
  if (expected.mode === 'constraint') {
    const file = join(ws, 'src', `mod-${pad(item.n)}.mjs`);
    if (!existsSync(file)) problems.push('missing');
    else {
      const text = readFileSync(file, 'utf8');
      const ruled = item.n > (expected.rulesFrom ?? 0);
      if (ruled && text.split(/\r?\n/)[0] !== '// @bench-owner: team-lime') problems.push('rule1:header');
      const exported = [...text.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]);
      if (!exported.includes(`lime_${item.n}`) || (ruled && exported.some(name => !name.startsWith('lime_')))) problems.push('rule2:name');
      try { const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`); if (mod[`lime_${item.n}`]?.() !== item.key) problems.push('wrong-value'); } catch { problems.push('wrong-value'); }
    }
  } else {
    const file = join(ws, 'out', `result-${pad(item.n)}.json`);
    if (!existsSync(file)) problems.push('missing');
    else { try { if (JSON.parse(readFileSync(file, 'utf8')).sum !== item.sum) problems.push('wrong-sum'); } catch { problems.push('unparsable'); } }
  }
  results.push({ n: item.n, ok: problems.length === 0, problems });
}

const extra = [];
if (expected.mode === 'constraint') {
  for (const [rel, hash] of Object.entries(expected.legacy)) {
    const file = join(ws, rel);
    if (!existsSync(file) || createHash('sha256').update(readFileSync(file)).digest('hex') !== hash) extra.push(`rule3:legacy-changed ${rel}`);
  }
  const final = existsSync(join(ws, 'FINAL.md')) ? readFileSync(join(ws, 'FINAL.md'), 'utf8') : '';
  for (const [label, re] of [['header', /team-lime/i], ['prefix', /lime_/], ['legacy', /legacy/i]]) if (!re.test(final)) extra.push(`final:recall-${label}`);
}

const failed = results.filter(r => !r.ok), byProblem = {};
for (const r of failed) for (const p of r.problems) byProblem[p] = (byProblem[p] ?? 0) + 1;
const half = Math.ceil(results.length / 2);
console.log(`mode=${expected.mode} rulesFrom=${expected.rulesFrom ?? 0} items=${results.length} passed=${results.length - failed.length} failed=${failed.length}`);
console.log(`failures by kind: ${JSON.stringify(byProblem)}`);
console.log(`failures in first half: ${failed.filter(r => r.n <= half).length}, second half: ${failed.filter(r => r.n > half).length}  (rules forgotten after compaction show up as late failures)`);
console.log(`first failing items: ${failed.slice(0, 10).map(r => `${pad(r.n)}[${r.problems.join(',')}]`).join(' ') || 'none'}`);
console.log(`extra checks: ${extra.length ? extra.join('; ') : 'all passed'}`);
process.exit(failed.length === 0 && extra.length === 0 ? 0 : 1);
