import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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
const historicalDeltas = [];
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
      if (change.historicalDeltaAudit !== undefined) {
        assert.equal(change.historicalDeltaAudit, 'unavailable', `invalid historical audit status ${path}`);
        assert.ok(change.localSnapshotReview?.trim(), `historical delta needs local snapshot review ${path}`);
        historicalDeltas.push(path);
      }
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
    assert.equal(await digest(join(module.sourcePath, module.sourceLockFile ?? 'package-lock.json')), module.sourceLockSha256);
  }
}
assert.equal(removed.size, 0, `removal references a non-imported path: ${[...removed.keys()]}`);
assert.equal(changes.size, 0, `adaptation references a non-imported path: ${[...changes.keys()]}`);
console.log(`[sources] ${verified} local snapshot hashes verified, ${adaptations.files.length} documented adaptations; ${sourceFiles} original files checked. No automatic source synchronization.`);
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
    if (file.historicalDeltaAudit !== undefined) {
      assert.equal(file.historicalDeltaAudit, 'unavailable', `invalid native historical audit status ${file.path}`);
      assert.ok(file.localSnapshotReview?.trim() && file.reason?.trim(), `native historical delta needs local review and reason ${file.path}`);
      assert.match(file.previousRecordedSha256 ?? '', /^[a-f0-9]{64}$/, `native historical delta needs previous hash ${file.path}`);
      historicalDeltas.push(file.path);
    }
    assert.equal(await digest(join(root, file.path)), file.sha256, `native module changed without updated provenance: ${file.path}`);
  }
}
console.log(`[sources] ${nativePaths.size} native module files verified separately from imported source snapshots.`);
const suite = adaptations.blackholeVendoring?.npmSuite ?? adaptations.localSourceNpmSuite;
assert.ok(suite?.packages?.length === 2, 'active local-source suite must contain two npm dependencies');
assert.deepEqual(suite.packages.map(dependency => dependency.name).sort(), ['@ff-labs/pi-fff', 'pi-open-tui']);
const packageManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
assert.equal(packageManifest.dependencies['pi-blackhole'], undefined, 'Blackhole is vendored, not an npm runtime dependency');
assert.equal(lock.packages['node_modules/pi-blackhole'], undefined, 'removed Blackhole npm identity must not remain locked');
assert.ok(!packageManifest.pi.extensions.some(entry => entry.startsWith('./node_modules/pi-blackhole/')), 'Blackhole must not load twice');
const suiteNames = new Set();
for (const dependency of suite.packages) {
  assert.ok(!suiteNames.has(dependency.name), `duplicate suite dependency ${dependency.name}`);
  suiteNames.add(dependency.name);
  assert.equal(packageManifest.dependencies[dependency.name], dependency.version);
  const locked = lock.packages[`node_modules/${dependency.name}`];
  assert.equal(locked?.version, dependency.version);
  assert.equal(locked?.integrity, dependency.integrity);
  assert.equal(locked?.resolved, dependency.resolved);
  const dependencyRoot = join(root, 'node_modules', dependency.name);
  const installed = JSON.parse(await readFile(join(dependencyRoot, 'package.json'), 'utf8'));
  assert.equal(installed.version, dependency.version);
  assert.equal(installed.license, dependency.license);
  assert.ok(installed.pi.extensions.includes(dependency.entry), `unrecognized dependency entry ${dependency.name}`);
  assert.ok(packageManifest.pi.extensions.includes(`./node_modules/${dependency.name}/${dependency.entry.replace(/^\.\//, '')}`));
  assert.ok((await stat(resolve(dependencyRoot, dependency.entry))).isFile());
}
const finalIntegration = adaptations.localSourceSuiteFinalIntegration;
assert.ok(finalIntegration?.rootFiles?.length, 'final suite integration hashes are required');
const finalPaths = new Set();
for (const file of finalIntegration.rootFiles) {
  assert.ok(!file.path.startsWith('/') && !file.path.includes('\\') && !file.path.split('/').includes('..'), `unsafe final integration path ${file.path}`);
  assert.ok(!finalPaths.has(file.path), `duplicate final integration path ${file.path}`);
  finalPaths.add(file.path);
  assert.equal(await digest(join(root, file.path)), file.sha256, `final suite integration changed without provenance: ${file.path}`);
}
console.log(`[sources] ${suiteNames.size} pinned npm dependencies and ${finalPaths.size} final root integration hashes verified; older provenance snapshots remain historical.`);
if (historicalDeltas.length) {
  console.warn(`[sources] WARNING: ${historicalDeltas.length} recorded historical deltas have unavailable earlier contents; local hash integrity is verified, not historical-diff equivalence:\n${historicalDeltas.join('\n')}`);
}
