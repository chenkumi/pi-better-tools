// Generates a long-task workspace for compaction trials. Deterministic (seeded). Makes no model calls.
//   node gen.mjs --mode constraint|parallel --out <dir> [--items 60] [--fat 30000] [--seed 1] [--rules-from K] [--solve]
// --rules-from K (constraint only): PROMPT.md covers items 1..K with no rules; <out>/followup.md is a second user message that gives the
// rules and asks for items K+1..end. Run it as a second `pi -p --continue` so the rules are a real user message, not the first request.
// Writes <out>/workspace (the agent's cwd) and <out>/expected.json (kept outside the workspace). --solve fills in a correct
// solution, which is only for checking the scorer.
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const argv = process.argv.slice(2), args = {};
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) args[argv[i].slice(2)] = true; else { args[argv[i].slice(2)] = next; i++; }
}
const mode = args.mode, out = args.out;
if (!['constraint', 'parallel'].includes(mode) || typeof out !== 'string') { console.error('usage: node gen.mjs --mode constraint|parallel --out <dir> [--items N] [--fat chars] [--seed N] [--solve]'); process.exit(2); }
const items = Number(args.items ?? (mode === 'constraint' ? 60 : 12)), fat = Number(args.fat ?? (mode === 'constraint' ? 30000 : 25000)), seed = Number(args.seed ?? 1);
const FILES_PER_ITEM = mode === 'parallel' ? 6 : 1;
const rulesFrom = mode === 'constraint' ? Number(args['rules-from'] ?? 0) : 0;

function rng(s) { let a = s >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = rng(seed), pick = list => list[Math.floor(rand() * list.length)], hex = n => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rand() * 16)]).join('');
const WORDS = 'alpha ledger window handle buffer router socket parser index cursor module bridge signal vector kernel record stream filter schema bucket anchor token queue cache shard quorum lease epoch delta'.split(' ');
const line = () => Array.from({ length: 8 + Math.floor(rand() * 8) }, () => pick(WORDS)).join(' ');

const ws = join(out, 'workspace');
rmSync(out, { recursive: true, force: true });
for (const d of ['data', 'src', 'legacy', 'out']) mkdirSync(join(ws, d), { recursive: true });

/** One reference file: filler lines, decoys marked deprecated, and exactly one ACTIVE value in the middle. */
function refFile(name, activeValue) {
  const lines = [`# ${name}`, 'Only the line marked ACTIVE counts. Lines marked deprecated are stale and must be ignored.'];
  const isKey = String(activeValue).startsWith('KEY');
  const decoyAt = new Set(Array.from({ length: 3 + Math.floor(rand() * 3) }, () => Math.floor(rand() * 300)));
  let size = lines.join('\n').length, i = 0, placed = false;
  while (size < fat || !placed) {
    let next = line();
    if (decoyAt.has(i)) next = `value ${isKey ? `KEY-${hex(8)}` : Math.floor(rand() * 90000) + 10000} (deprecated)`;
    if (!placed && size > fat / 2) { next = `value ${activeValue} ACTIVE`; placed = true; }
    lines.push(next); size += next.length + 1; i++;
  }
  return lines.join('\n') + '\n';
}

const expected = { mode, items, seed, fat, rulesFrom, itemsExpected: [], legacy: {} };
for (let n = 1; n <= 3; n++) {
  const body = `// legacy file ${n}\nexport const legacy${n} = '${hex(12)}';\n`;
  writeFileSync(join(ws, 'legacy', `old-${n}.mjs`), body);
  expected.legacy[`legacy/old-${n}.mjs`] = createHash('sha256').update(body).digest('hex');
}

const pad = n => String(n).padStart(3, '0');
for (let n = 1; n <= items; n++) {
  if (mode === 'constraint') {
    const key = `KEY-${hex(8)}`;
    writeFileSync(join(ws, 'data', `ref-${pad(n)}.txt`), refFile(`ref-${pad(n)}`, key));
    expected.itemsExpected.push({ n, key });
  } else {
    const values = Array.from({ length: FILES_PER_ITEM }, () => Math.floor(rand() * 90000) + 10000);
    values.forEach((v, k) => writeFileSync(join(ws, 'data', `ref-${pad(n)}-${'abcdef'[k]}.txt`), refFile(`ref-${pad(n)}-${'abcdef'[k]}`, v)));
    expected.itemsExpected.push({ n, sum: values.reduce((a, b) => a + b, 0) });
  }
}

const checklist = Array.from({ length: items }, (_, i) => `- [ ] item ${pad(i + 1)}`).join('\n') + '\n';
let prompt, tasks;
const RULES = `1. The first line of every file you create must be exactly: // @bench-owner: team-lime
2. Every function you export must be named with the prefix lime_ (for example lime_7).
3. Never modify, delete or rename anything under legacy/. Reading it is fine.`;
const itemText = 'For item N (three digits, e.g. 007): read data/ref-NNN.txt, take the value marked ACTIVE (it looks like KEY-xxxxxxxx), and create src/mod-NNN.mjs that exports a function lime_N() returning that exact string (N without leading zeros).';
let followup;
if (mode === 'constraint' && rulesFrom > 0) {
  prompt = `# Long task: ${items} small modules, first part

Work through TASKS.md in order, item by item, for items 001 to ${pad(rulesFrom)} only, then stop. Do not ask me questions.
You must read each data file completely with the read tool before you use it (do not grep for the answer).
`;
  followup = `New project-wide rules, effective from now on (I will not repeat them):
${RULES}
These rules apply to everything you create or change from now on, not to the files you already made.
Now continue with items ${pad(rulesFrom + 1)} to ${pad(items)} of TASKS.md, same procedure as before, then create FINAL.md that lists, in your own words, the three rules above. Do not stop early and do not ask me questions.
`;
} else if (mode === 'constraint') {
  prompt = `# Long task: ${items} small modules

Work through TASKS.md in order, item by item, until every item is done. Do not stop early and do not ask me questions.
You must read each data file completely with the read tool before you use it (do not grep for the answer).

Rules that apply to EVERYTHING you create or change in this project, for the whole task (I will not repeat them):
${RULES}

When all items are done, create FINAL.md that lists, in your own words, the three rules above.
`;
}
if (mode === 'constraint') tasks = `# TASKS

${itemText}

${checklist}`;
else {
  prompt = `# Long task: ${items} sums over six reference files

Work through TASKS.md in order until every item is done. Do not stop early and do not ask me questions.
For each item, read ALL six of its data files in a single step (issue the six read calls together, in parallel), read each completely, then write the result file.
`;
  tasks = `# TASKS\n\nFor item N (three digits): the six files data/ref-NNN-a.txt ... ref-NNN-f.txt each contain one number marked ACTIVE. Write out/result-NNN.json as {"sum": <the sum of the six ACTIVE numbers>}.\n\n${checklist}`;
}
writeFileSync(join(ws, 'PROMPT.md'), prompt);
if (followup) writeFileSync(join(out, 'followup.md'), followup);
writeFileSync(join(ws, 'TASKS.md'), tasks);

if (args.solve) {
  if (mode === 'constraint') {
    for (const { n, key } of expected.itemsExpected) writeFileSync(join(ws, 'src', `mod-${pad(n)}.mjs`), `// @bench-owner: team-lime\nexport function lime_${n}() { return '${key}'; }\n`);
    writeFileSync(join(ws, 'FINAL.md'), 'Rules: files start with the team-lime owner header; exported functions use the lime_ prefix; legacy/ is never modified.\n');
  } else for (const { n, sum } of expected.itemsExpected) writeFileSync(join(ws, 'out', `result-${pad(n)}.json`), JSON.stringify({ sum }));
}
writeFileSync(join(out, 'expected.json'), JSON.stringify(expected, null, 1));
console.log(`generated ${mode}: ${items} items in ${ws} (${FILES_PER_ITEM} data file(s) per item, about ${fat} chars each; tasks file ${readFileSync(join(ws, 'TASKS.md'), 'utf8').length} chars)`);
