import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const skillDir = fileURLToPath(new URL('../skills/pi-tools-config/', import.meta.url));
const index = readFileSync(resolve(skillDir, 'SKILL.md'), 'utf8');

test('pi-tools-config routes configuration needs by capability and keeps one reference per local module', () => {
  const metadata = /^---\nname: pi-tools-config\ndescription: >-\n((?:  [^\n]+\n)+)---/.exec(index);
  assert.ok(metadata, 'valid folded description frontmatter');
  const description = metadata[1].trim().split('\n').map(line => line.trim()).join(' ');
  assert.match(description, /^Use when users need to create, change, or troubleshoot configuration /);
  assert.match(description, /^[ -~]+$/);
  for (const capability of ['SQLite', 'MySQL', 'PostgreSQL/Postgres', 'SQL Server/MSSQL', 'pty_*', 'web_search', 'subagent', 'schedule_prompt']) assert.ok(description.includes(capability), `missing config capability: ${capability}`);
  assert.ok(description.includes('required connection configuration is missing or unknown.'));
  for (const capability of ['Chromium installation', 'PTY native', 'setup CLI diagnostics']) assert.ok(description.includes(capability));
  assert.ok(description.length <= 1024, 'host skill description limit');
  assert.ok(description.includes('Do not use for routine operations with already-configured tools or for implementing these features in application code.'));
  assert.doesNotMatch(description, /pi-better-tools/);
  const modules = readdirSync(new URL('../../', import.meta.url), { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(new URL(`../../${entry.name}/src/index.ts`, import.meta.url))).map(entry => entry.name).sort();
  const references = readdirSync(resolve(skillDir, 'references')).sort();
  assert.deepEqual(references, modules.map(name => `${name}.md`));
  const indexed = [...index.matchAll(/\]\(references\/([^)]+)\)/g)].map(match => match[1]).sort();
  assert.deepEqual(indexed, references, 'every module has exactly one index link');
});

test('installation references describe installed-instance commands without requiring a checkout', () => {
  const web = readFileSync(resolve(skillDir, 'references/web-tools.md'), 'utf8');
  const pty = readFileSync(resolve(skillDir, 'references/pty-terminal.md'), 'utf8');
  for (const text of [web, pty]) {
    assert.match(text, /pi-better-tools doctor/);
    assert.match(text, /setup\/cli\.mjs/);
    assert.match(text, /PATH/);
    assert.match(text, /npx/);
  }
  assert.match(web, /pi-better-tools browser install-deps/);
  assert.match(web, /waitForSelector/);
  assert.match(web, /PLAYWRIGHT_BROWSERS_PATH/);
  assert.match(web, /靜態 HTTP/);
  assert.match(pty, /pi-better-tools pty setup/);
  assert.match(pty, /consumer project/);
});

test('pi-tools-config remains self-contained when copied without the project', t => {
  const temp = mkdtempSync(join(tmpdir(), 'pi-tools-config-standalone-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const standalone = join(temp, 'skill');
  cpSync(skillDir, standalone, { recursive: true });
  const files = [resolve(standalone, 'SKILL.md'), ...readdirSync(resolve(standalone, 'references')).map(name => resolve(standalone, 'references', name))];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target) continue;
      assert.ok(!isAbsolute(target) && !/^[a-z][a-z0-9+.-]*:/i.test(target), `non-relative skill link: ${target}`);
      const destination = resolve(dirname(file), target);
      const fromRoot = relative(standalone, destination);
      assert.ok(!isAbsolute(fromRoot) && fromRoot.split(/[\\/]/)[0] !== '..', `link escapes skill directory: ${target}`);
      assert.ok(existsSync(destination), `broken standalone link in ${file}: ${target}`);
    }
    for (const match of text.matchAll(/```json\r?\n([\s\S]*?)```/g)) assert.doesNotThrow(() => JSON.parse(match[1]), `invalid JSON example in ${file}`);
  }
});
