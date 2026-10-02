import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse((await readFile(join(root, 'docs/sources.json'), 'utf8')).replace(/^\uFEFF/, ''));
const adaptations = JSON.parse(await readFile(join(root, 'docs/adaptations.json'), 'utf8'));
const changes = new Map(adaptations.files.map(file => [file.path, file]));
const removed = new Map((adaptations.removedFiles ?? []).map(file => [file.path, file]));
assert.equal(removed.size, (adaptations.removedFiles ?? []).length, 'duplicate removed path');
assert.equal(changes.size, adaptations.files.length, 'duplicate adaptation path');
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
let verified = 0, sourceFiles = 0;
const checkOriginal = process.argv.includes('--originals');
const importedPaths = new Set(manifest.modules.flatMap(module => module.files.map(file => `modules/${module.module}/${file.path}`)));
const addedPaths = new Set();
for (const file of adaptations.addedFiles ?? []) {
  assert.ok(/^(modules|tests)\//.test(file.path) && !file.path.split('/').includes('..') && !file.path.includes('\\'), `unsafe added path ${file.path}`);
  assert.ok(!addedPaths.has(file.path) && !importedPaths.has(file.path), `duplicate/imported added path ${file.path}`);
  assert.ok(file.reason?.trim(), `undocumented added file ${file.path}`);
  addedPaths.add(file.path);
  assert.equal(await digest(join(root, file.path)), file.sha256, `added integration file changed without provenance: ${file.path}`);
}
console.log(`[sources] ${addedPaths.size} added integration files verified separately from immutable imports.`);
for (const module of manifest.modules) {
  console.log(`[sources] Checking ${module.module} (${module.files.length} imported files)...`);
  for (const file of module.files) {
    const path = `modules/${module.module}/${file.path}`, change = changes.get(path), gone = removed.get(path);
    if (gone) {
      assert.ok(!change && gone.reason?.trim(), `removed file needs a reason and no adaptation: ${path}`);
      assert.equal(gone.originalSha256, file.sha256, `removal origin mismatch ${path}`);
      await assert.rejects(digest(join(root, path)), { code: 'ENOENT' }, `removed file still exists: ${path}`);
      removed.delete(path); verified++; continue;
    }
    if (change) {
      assert.equal(change.originalSha256, file.sha256, `adaptation origin mismatch ${path}`);
      assert.ok(change.reason && change.reason.trim(), `undocumented adaptation ${path}`);
      changes.delete(path);
    }
    assert.equal(await digest(join(root, path)), change?.sha256 ?? file.sha256, `snapshot changed without reviewed adaptation: ${path}`);
    if (checkOriginal) {
      assert.equal(await digest(join(module.sourcePath, file.path)), file.sha256, `original changed: ${module.sourcePath}/${file.path}`);
      sourceFiles++;
    }
    verified++;
  }
  if (checkOriginal) {
    assert.equal(await digest(join(module.sourcePath, 'package.json')), module.sourceManifestSha256);
    assert.equal(await digest(join(module.sourcePath, 'package-lock.json')), module.sourceLockSha256);
  }
}
assert.equal(removed.size, 0, `removal references a non-imported path: ${[...removed.keys()]}`);
assert.equal(changes.size, 0, `adaptation references a non-imported path: ${[...changes.keys()]}`);
console.log(`[sources] ${verified} snapshot files verified, ${adaptations.files.length} documented adaptations; ${sourceFiles} original files checked. No automatic source synchronization.`);
const native = JSON.parse(await readFile(join(root, 'docs/native-modules.json'), 'utf8'));
const nativePaths = new Set();
for (const module of native.modules) {
  console.log(`[sources] Checking native module ${module.module} (not an imported snapshot)...`);
  assert.ok(module.origin && module.license, `missing native provenance ${module.module}`);
  assert.ok(module.files.some(file => file.path === module.entry), `untracked native entry ${module.module}`);
  for (const file of module.files) {
    assert.ok(file.path.startsWith(`modules/${module.module}/`) && !file.path.split('/').includes('..'), `unsafe native path ${file.path}`);
    assert.ok(!nativePaths.has(file.path), `duplicate native path ${file.path}`);
    nativePaths.add(file.path);
    assert.equal(await digest(join(root, file.path)), file.sha256, `native module changed without updated provenance: ${file.path}`);
  }
}
console.log(`[sources] ${nativePaths.size} native module files verified separately from imported source snapshots.`);
