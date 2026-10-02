import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { isolatedEnv, runNpm } from './process.ts';

const version = process.argv[2] ?? '0.99.1';
if (!['0.85.1', '0.99.1'].includes(version)) throw new Error('Only audited pi versions 0.85.1 and 0.99.1 are accepted');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const before = await Promise.all(['package.json', 'package-lock.json'].map(f => digest(join(root, f))));
const temp = await mkdtemp(join(tmpdir(), `pi-web-compat-${version}-`));
try {
  const project = join(temp, 'project'), home = join(temp, 'home');
  await mkdir(project); await mkdir(home);
  const env = isolatedEnv(home);
  // HOME/LOCALAPPDATA isolation must not hide the explicitly installed matching
  // browser asset. Reuse only its binary cache, never a personal browser profile.
  const executable = chromium.executablePath();
  const cache = /^(.*)[\\/]chromium-\d+[\\/]/.exec(executable)?.[1];
  if (!cache || !existsSync(executable)) throw new Error('Matching Chromium is missing; run npm run browser:install first');
  env.PLAYWRIGHT_BROWSERS_PATH = cache;
  console.error(`Progress: copying isolated project for pi ${version}`);
  for (const path of ['src', 'tests', 'scripts', 'schemas', 'examples', 'README.md', 'LICENSE', 'package.json', 'package-lock.json', 'tsconfig.json']) {
    await cp(join(root, path), join(project, path), { recursive: true });
  }
  const packagePath = join(project, 'package.json');
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
  manifest.devDependencies['@earendil-works/pi-coding-agent'] = version;
  manifest.devDependencies['@earendil-works/pi-ai'] = version;
  await writeFile(packagePath, JSON.stringify(manifest, null, 2) + '\n');
  await runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: project, env, timeoutMs: 600000, label: `Installing isolated pi ${version}`, echo: true });
  const installed = JSON.parse(await readFile(join(project, 'node_modules/@earendil-works/pi-coding-agent/package.json'), 'utf8'));
  if (installed.version !== version) throw new Error(`Unexpected installed pi version: ${installed.version}`);
  for (const command of ['typecheck', 'test', 'test:integration', 'test:production']) {
    await runNpm(['run', command], { cwd: project, env, timeoutMs: command === 'test:production' ? 900000 : 300000, label: `pi ${version}: ${command}`, echo: true });
  }
  console.log(`Compatibility validation PASS: pi ${version}, ${process.platform}, Node ${process.version}`);
} finally {
  console.error('Progress: cleaning isolated compatibility directory');
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  const after = await Promise.all(['package.json', 'package-lock.json'].map(f => digest(join(root, f))));
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Root package manifests changed during isolated validation');
}
