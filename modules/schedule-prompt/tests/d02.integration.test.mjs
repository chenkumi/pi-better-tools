// D02: in an untrusted project (--no-approve, projectTrusted=false) a project-local .pi/schedule-prompts.json must not start jobs,
// and an in-process child session must not load project-local resources the parent refused.
// Level: real Pi 1.1.0 CLI (rpc, --no-approve), real extension runner, real scheduler and real child session; offline scripted provider.
// The negative observation uses a bounded window (jobs have 1s intervals); it ends early as soon as any job activity is seen.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { installGlobalExtensions, job, log, makeSandbox, probePath, providerFile, readJsonl, readStore, scheduleEntry, startPi, waitUntil, writeStore } from './_harness.mjs';

async function scenario() {
  const sb = await makeSandbox('sp-d02');
  const marker = join(sb.home, 'project-extension-loaded.txt');
  await installGlobalExtensions(sb, [providerFile]);
  // Project-local extension that the untrusted parent must not load, and a child must not load either.
  await mkdir(join(sb.cwd, '.pi/extensions'), { recursive: true });
  await writeFile(join(sb.cwd, '.pi/extensions/project-marker.ts'),
    `import { writeFileSync } from 'node:fs';
export default function () { writeFileSync(process.env.REPRO_MARKER!, 'project extension loaded'); }
`);
  await writeStore(sb, [
    job({ id: 'inline-job', name: 'inline', prompt: 'INLINE_PROMPT_FROM_UNTRUSTED_PROJECT' }),
    job({ id: 'model-job', name: 'child', prompt: 'child task', model: 'repro-offline/fixture', extensions: true }),
  ]);
  const pi = startPi(sb, { label: 'D02', approve: false, extensions: [probePath, scheduleEntry], env: { REPRO_MARKER: marker },
    script: Array.from({ length: 8 }, () => ({ content: [{ type: 'text', text: 'ok' }] })) });
  await pi.send({ id: 'state', type: 'get_state' });
  assert.ok(await pi.waitFor(e => e.type === 'response' && e.id === 'state', 30000, 'rpc ready'), 'host must be up (harness sanity)');
  // Bounded observation window: stop early once any job fired (which is the defect) or after 6s.
  const fired = await waitUntil(async () => (await readStore(sb)).jobs.some(j => (j.runCount ?? 0) > 0 || j.lastStatus), 6000, 'any job activity in untrusted project');
  const markerLoaded = !!(await waitUntil(() => readFile(marker, 'utf8').then(() => true, () => false), fired ? 5000 : 300, 'project marker extension in child'));
  const events = await readJsonl(pi.paths.events);
  await pi.finish();
  assert.equal(events.find(e => e.type === 'start')?.trusted, false, 'precondition: host reports the project as untrusted (ctx.isProjectTrusted() === false)');
  const jobs = (await readStore(sb)).jobs;
  const requests = await readJsonl(pi.paths.requests);
  log(`jobs=${JSON.stringify(jobs.map(j => ({ n: j.name, s: j.lastStatus, r: j.runCount })))} provider requests=${requests.length} markerLoaded=${markerLoaded}`);
  return { sb, fired: !!fired, markerLoaded, jobs, requests };
}

test('D02a: untrusted project: project schedule jobs must not be started/fired', { timeout: 120000 }, async () => {
  const r = await scenario();
  try {
    assert.ok(!r.fired && r.requests.length === 0 && r.jobs.every(j => !j.lastStatus),
      `jobs from an untrusted project .pi/schedule-prompts.json must not run; statuses=${JSON.stringify(r.jobs.map(j => [j.name, j.lastStatus, j.runCount]))}, provider requests=${r.requests.length}`);
  } finally { await r.sb.cleanup(); }
});

test('D02b: untrusted project: scheduled child session must not load project-local extensions', { timeout: 120000 }, async () => {
  const r = await scenario();
  try {
    assert.ok(!r.markerLoaded, 'child session (extensions=true) loaded .pi/extensions from a project the parent did not trust');
  } finally { await r.sb.cleanup(); }
});
