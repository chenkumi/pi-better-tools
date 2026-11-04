// Scans relative imports that cross directory boundaries under modules/ and shared/.
// Usage: node tools/module-coupling/scan.mjs [--json]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+|require\(\s*)['"]([^'"]+)['"]/g;
const SKIP = new Set(['node_modules', 'plan', '.pi', 'dist']);
const SOURCE = /\.(?:ts|mts|mjs|js)$/;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path); else if (SOURCE.test(name)) yield path;
  }
}

const posix = path => path.split(sep).join('/');
const isTest = rel => /(^|\/)(tests?|fixtures)\//.test(rel) || /\.test\./.test(rel);

/** Returns { edges, symbols }: edges are cross-unit relative imports (unit = modules/<name> or shared). */
export function scan(root = ROOT) {
  const edges = [];
  const symbols = new Map();
  const units = [];
  for (const name of readdirSync(join(root, 'modules'))) units.push({ unit: name, dir: join(root, 'modules', name) });
  try { if (statSync(join(root, 'shared')).isDirectory()) units.push({ unit: 'shared', dir: join(root, 'shared') }); } catch { /* shared/ is optional */ }
  for (const { unit, dir } of units) {
    for (const file of walk(dir)) {
      const rel = posix(relative(root, file));
      const text = readFileSync(file, 'utf8');
      const kind = isTest(rel) ? 'test' : 'src';
      for (const [, spec] of text.matchAll(IMPORT)) {
        if (!spec.startsWith('.')) continue;
        const target = posix(relative(root, normalize(resolve(dirname(file), spec))));
        const [top, second] = target.split('/');
        const targetUnit = top === 'modules' ? second : top;
        if (targetUnit === unit && top === 'modules') continue;
        if (top === 'shared' && unit === 'shared') continue;
        edges.push({ from: unit, to: targetUnit, kind, file: rel, target });
      }
      for (const [, key] of text.matchAll(/Symbol\.for\(\s*['"]([^'"]+)['"]/g)) {
        if (!symbols.has(key)) symbols.set(key, new Set());
        symbols.get(key).add(`${unit}:${kind}`);
      }
    }
  }
  return { edges, symbols: Object.fromEntries([...symbols].map(([k, v]) => [k, [...v].sort()])) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = scan();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    const pairs = new Map();
    for (const e of result.edges.filter(e => e.kind === 'src')) {
      const key = `${e.from} -> ${e.to}`;
      pairs.set(key, (pairs.get(key) ?? new Set()).add(e.file));
    }
    for (const [key, files] of [...pairs].sort()) console.log(`${key} (${files.size} files)`);
    console.log(`\nSymbol.for keys: ${Object.keys(result.symbols).length}`);
  }
}
