// Explicit standalone identity probe; not silently skipped by Vitest.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadGitFileTags, gitEnv } from '../../src/extract/git-status.ts';
import { collectFilesTouched } from '../../src/extract/file-touch.ts';
import { extractFiles } from '../../src/extract/files.ts';
import { normalize } from '../../src/core/normalize.ts';
import { compile } from '../../src/core/summarize.ts';
const home = mkdtempSync(join(tmpdir(), 'blackhole-alias-proof-'));
try {
  Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata') });
  const root = join(home, 'repo'), cwd = join(root, 'subdir'); mkdirSync(cwd, { recursive: true });
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: gitEnv(), timeout: 5000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  git(['init']); writeFileSync(join(cwd, 'deleted.ts'), 'deleted\n'); git(['add', 'subdir/deleted.ts']); unlinkSync(join(cwd, 'deleted.ts'));
  writeFileSync(join(cwd, 'fresh.ts'), 'UNCHANGED_FIXTURE\r\n');
  const longRoot = git(['rev-parse', '--show-toplevel']).trim(), longCwd = `${longRoot}/subdir`;
  console.log(JSON.stringify({ platform: process.platform, cwd, gitRoot: longRoot, longCwd }));
  // A fixture proof only: both names refer to the fixture directory/file, not a text guess.
  const shortStat = statSync(cwd, { bigint: true }), longStat = statSync(longCwd, { bigint: true });
  assert.equal(shortStat.dev, longStat.dev); assert.equal(shortStat.ino, longStat.ino); assert.notEqual(shortStat.ino, 0n);
  if (cwd.replaceAll('\\', '/') === longCwd) throw new Error('ALIAS_PROBE_BLOCKED: this environment exposes no distinct native alias; no skip/pass claimed');
  const original = readFileSync(join(cwd, 'fresh.ts')), hash = createHash('sha256').update(original).digest('hex');
  const messages = [{ role: 'assistant', content: [{ type: 'toolCall', id: 'w', name: 'write', arguments: { path: 'fresh.ts', content: 'UNCHANGED_FIXTURE\r\n' } }, { type: 'toolCall', id: 'r', name: 'read', arguments: { path: 'deleted.ts' } }], timestamp: 1 },
    { role: 'toolResult', toolCallId: 'w', toolName: 'write', isError: false, content: [{ type: 'text', text: 'Successfully wrote fixture' }], timestamp: 2 },
    { role: 'toolResult', toolCallId: 'r', toolName: 'read', isError: false, content: [{ type: 'text', text: 'recorded prior read' }], timestamp: 3 }];
  const tags = loadGitFileTags(cwd), touched = collectFilesTouched(messages, cwd), blocks = normalize(messages);
  const files = extractFiles(blocks, { modifiedFiles: ['fresh.ts'], readFiles: ['deleted.ts'] }, touched, tags, cwd, true);
  const summary = compile({ messages, touchMessages: messages, cwd, gitTags: tags, fileOps: { modifiedFiles: ['fresh.ts'], readFiles: ['deleted.ts'] } });
  console.log(JSON.stringify({ producerTags: [...tags], created: [...files.created], modified: [...files.modified], read: [...files.read], annotations: [...(files.gitTags ?? [])], summary }));
  assert.deepEqual(readFileSync(join(cwd, 'fresh.ts')), original); assert.equal(createHash('sha256').update(readFileSync(join(cwd, 'fresh.ts'))).digest('hex'), hash);
  assert.ok(files.created.has('fresh.ts'), 'real producer→consumer must recognize native alias as Created');
  assert.equal(files.gitTags?.get('fresh.ts'), 'new'); assert.equal(files.gitTags?.get('deleted.ts'), 'deleted');
  assert.match(summary, /fresh\.ts \(new\)/); assert.match(summary, /deleted\.ts \(deleted\)/);
  console.log('Native alias producer→extractFiles→compile passed; fixture bytes/hash unchanged.');
} finally { rmSync(home, { recursive: true, force: true }); }
