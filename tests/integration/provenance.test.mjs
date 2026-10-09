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
      addedFiles: [], removedFiles: [],
      localSourceNpmSuite: { packages: ['pi-open-tui', '@ff-labs/pi-fff'].map(name => ({ name, version: '1.0.0', integrity: 'fixture-integrity', resolved: `https://unused.invalid/${name}`, entry: './index.ts', license: 'MIT' })) },
      localSourceSuiteFinalIntegration: { rootFiles: [{ path: 'root-fixture.txt', sha256: hash(current) }] } };
    const packageManifest = { dependencies: {}, pi: { extensions: [] } }, lock = { packages: {} };
    for (const dependency of adaptations.localSourceNpmSuite.packages) {
      packageManifest.dependencies[dependency.name] = dependency.version;
      packageManifest.pi.extensions.push(`./node_modules/${dependency.name}/index.ts`);
      lock.packages[`node_modules/${dependency.name}`] = { version: dependency.version, integrity: dependency.integrity, resolved: dependency.resolved };
      const dependencyRoot = join(root, 'node_modules', dependency.name);
      await mkdir(dependencyRoot, { recursive: true });
      await writeFile(join(dependencyRoot, 'index.ts'), current);
      await writeFile(join(dependencyRoot, 'package.json'), JSON.stringify({ version: dependency.version, license: 'MIT', pi: { extensions: ['./index.ts'] } }));
    }
    await writeFile(join(root, 'root-fixture.txt'), current);
    const native = { modules: [{ module: 'native', origin: 'Test fixture', license: 'MIT', entry: 'modules/native/index.ts',
      files: [{ path: 'modules/native/index.ts', sha256: hash(current), previousRecordedSha256: hash(original),
        reason: 'Fixture historical record.', historicalDeltaAudit: 'unavailable', localSnapshotReview: 'Inspected current fixture.' }] }] };
    const save = async () => {
      await writeFile(join(root, 'package.json'), JSON.stringify(packageManifest));
      await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock));
      for (const [name, data] of [['sources', sources], ['adaptations', adaptations], ['native-modules', native]]) {
        await writeFile(join(root, `docs/${name}.json`), JSON.stringify(data));
      }
    };
    await save();
    await run({ root, sources, adaptations, native, packageManifest, lock, save,
      verify: (...args) => execute(process.execPath, [join(root, 'scripts/verify-sources.mjs'), ...args], { timeout: 10000 }) });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('local snapshot verification reports historical limits and still checks accessible original bytes', async () => {
  await fixture(async ({ verify }) => {
    const { stdout, stderr } = await verify('--originals');
    assert.match(stdout, /1 original files checked/);
    assert.match(stdout, /1 native module files verified/);
    assert.match(stdout, /2 pinned npm dependencies and 1 final root integration hashes verified/);
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

test('suite lock identity, installed entry and final root hashes cannot drift silently', async () => {
  await fixture(async ({ root, lock, save, verify }) => {
    lock.packages['node_modules/pi-open-tui'].integrity = 'wrong-integrity';
    await save();
    await assert.rejects(verify(), error => error.code === 1 && /wrong-integrity/.test(error.stderr));
    lock.packages['node_modules/pi-open-tui'].integrity = 'fixture-integrity';
    await save();
    await rm(join(root, 'node_modules/pi-open-tui/index.ts'));
    await assert.rejects(verify(), error => error.code === 1 && /ENOENT/.test(error.stderr));
    await writeFile(join(root, 'node_modules/pi-open-tui/index.ts'), current);
    await writeFile(join(root, 'root-fixture.txt'), 'tampered root\n');
    await assert.rejects(verify(), error => error.code === 1 && /final suite integration changed without provenance/.test(error.stderr));
  });
});

test('adaptation origin must still match the immutable import manifest', async () => {
  await fixture(async ({ adaptations, save, verify }) => {
    adaptations.files[0].originalSha256 = hash('incorrect origin');
    await save();
    await assert.rejects(verify(), error => error.code === 1 && /adaptation origin mismatch/.test(error.stderr));
  });
});

test('source-specific pnpm lock identity is checked without requiring an npm source lock', async () => {
  await fixture(async ({ root, sources, save, verify }) => {
    const module = sources.modules[0];
    module.sourceLockFile = 'pnpm-lock.yaml';
    module.sourceLockSha256 = hash('fixture pnpm lock\n');
    await writeFile(join(root, 'original/pnpm-lock.yaml'), 'fixture pnpm lock\n');
    await rm(join(root, 'original/package-lock.json'));
    await save();
    assert.match((await verify('--originals')).stdout, /1 original files checked/);
    await writeFile(join(root, 'original/pnpm-lock.yaml'), 'changed pnpm lock\n');
    await assert.rejects(verify('--originals'), error => error.code === 1 && /ERR_ASSERTION/.test(error.stderr));
  });
});

test('active vendored suite supersedes historical npm Blackhole provenance without erasing it', async () => {
  await fixture(async ({ adaptations, save, verify }) => {
    adaptations.blackholeVendoring = { npmSuite: { packages: structuredClone(adaptations.localSourceNpmSuite.packages) } };
    adaptations.localSourceNpmSuite.packages.push({ name: 'pi-blackhole', version: '0.5.11' });
    await save();
    assert.match((await verify()).stdout, /2 pinned npm dependencies/);
    assert.equal(adaptations.localSourceNpmSuite.packages.length, 3);
  });
});

test('a vendored Blackhole cannot quietly regain an npm dependency or duplicate npm entry', async () => {
  await fixture(async ({ packageManifest, lock, save, verify }) => {
    packageManifest.dependencies['pi-blackhole'] = '0.5.11';
    await save();
    await assert.rejects(verify(), error => error.code === 1 && /Blackhole is vendored/.test(error.stderr));
    delete packageManifest.dependencies['pi-blackhole'];
    lock.packages['node_modules/pi-blackhole'] = { version: '0.5.11' };
    await save();
    await assert.rejects(verify(), error => error.code === 1 && /must not remain locked/.test(error.stderr));
    delete lock.packages['node_modules/pi-blackhole'];
    packageManifest.pi.extensions.push('./node_modules/pi-blackhole/dist/index.js');
    await save();
    await assert.rejects(verify(), error => error.code === 1 && /must not load twice/.test(error.stderr));
  });
});
