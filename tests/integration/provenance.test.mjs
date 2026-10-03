import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execute = promisify(execFile);
const hash = text => createHash('sha256').update(text).digest('hex');
const original = 'original fixture\n', current = 'locally inspected fixture\n';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'pi-provenance-test-'));
  try {
    for (const directory of ['scripts', 'docs', 'modules/fixture', 'modules/native', 'original']) {
      await mkdir(join(root, directory), { recursive: true });
    }
    await copyFile(new URL('../../scripts/verify-sources.mjs', import.meta.url), join(root, 'scripts/verify-sources.mjs'));
    await writeFile(join(root, 'modules/fixture/index.ts'), current);
    await writeFile(join(root, 'modules/native/index.ts'), current);
    await writeFile(join(root, 'original/index.ts'), original);
    await writeFile(join(root, 'original/package.json'), '{}\n');
    await writeFile(join(root, 'original/package-lock.json'), '{}\n');
    const sources = { modules: [{ module: 'fixture', sourcePath: join(root, 'original'),
      sourceManifestSha256: hash('{}\n'), sourceLockSha256: hash('{}\n'),
      files: [{ path: 'index.ts', sha256: hash(original) }] }] };
    const adaptations = { files: [{ path: 'modules/fixture/index.ts', originalSha256: hash(original), sha256: hash(current),
      reason: 'Fixture only: historical diff unavailable.', historicalDeltaAudit: 'unavailable', localSnapshotReview: 'Inspected current fixture.' }],
      addedFiles: [], removedFiles: [] };
    const native = { modules: [{ module: 'native', origin: 'Test fixture', license: 'MIT', entry: 'modules/native/index.ts',
      files: [{ path: 'modules/native/index.ts', sha256: hash(current), previousRecordedSha256: hash(original),
        reason: 'Fixture historical record.', historicalDeltaAudit: 'unavailable', localSnapshotReview: 'Inspected current fixture.' }] }] };
    const save = async () => {
      for (const [name, data] of [['sources', sources], ['adaptations', adaptations], ['native-modules', native]]) {
        await writeFile(join(root, `docs/${name}.json`), JSON.stringify(data));
      }
    };
    await save();
    await run({ root, sources, adaptations, native, save,
      verify: (...args) => execute(process.execPath, [join(root, 'scripts/verify-sources.mjs'), ...args], { timeout: 10000 }) });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('local snapshot verification reports historical limits and still checks accessible original bytes', async () => {
  await fixture(async ({ verify }) => {
    const { stdout, stderr } = await verify('--originals');
    assert.match(stdout, /1 original files checked/);
    assert.match(stdout, /1 native module files verified/);
    assert.match(stderr, /WARNING: 2 recorded historical deltas/);
    assert.match(stderr, /not historical-diff equivalence/);
    assert.match(stderr, /modules\/fixture\/index\.ts/);
    assert.match(stderr, /modules\/native\/index\.ts/);
  });
});

for (const module of ['fixture', 'native']) {
  test(`historical status cannot bypass tampered ${module} snapshot hashes`, async () => {
    await fixture(async ({ root, verify }) => {
      await writeFile(join(root, `modules/${module}/index.ts`), 'tampered\n');
      await assert.rejects(verify(), error => error.code === 1 && /changed without/.test(error.stderr));
    });
  });
}

test('unavailable originals do not excuse missing review metadata or invalid audit status', async () => {
  await fixture(async ({ adaptations, save, verify }) => {
    delete adaptations.files[0].localSnapshotReview;
    await save();
    await assert.rejects(verify(), error => error.code === 1 && /needs local snapshot review/.test(error.stderr));
    adaptations.files[0].localSnapshotReview = 'Inspected.';
    adaptations.files[0].historicalDeltaAudit = 'pretend-equivalent';
    await save();
    await assert.rejects(verify(), error => error.code === 1 && /invalid historical audit status/.test(error.stderr));
  });
});

test('native historical records retain the previous hash and review reason', async () => {
  await fixture(async ({ native, save, verify }) => {
    delete native.modules[0].files[0].previousRecordedSha256;
    await save();
    await assert.rejects(verify(), error => error.code === 1 && /needs previous hash/.test(error.stderr));
  });
});

test('original-source verification rejects a changed immutable source', async () => {
  await fixture(async ({ root, verify }) => {
    await writeFile(join(root, 'original/index.ts'), 'changed original\n');
    await assert.rejects(verify('--originals'), error => error.code === 1 && /original changed/.test(error.stderr));
  });
});

test('adaptation origin must still match the immutable import manifest', async () => {
  await fixture(async ({ adaptations, save, verify }) => {
    adaptations.files[0].originalSha256 = hash('incorrect origin');
    await save();
    await assert.rejects(verify(), error => error.code === 1 && /adaptation origin mismatch/.test(error.stderr));
  });
});
