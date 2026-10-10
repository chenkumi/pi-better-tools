// D01: Blackhole must not read project-layer config (.pi/pi-blackhole-config.json, legacy .pi/settings.json)
// when the host says the project is untrusted. Asserts the CORRECT behaviour; RED while the defect exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHost, log, withLimit } from './fixtures/real-host.mjs';

const GLOBAL_VALUE = 15000, PROJECT_VALUE = 7777;

async function statusFor({ trusted, layer }) {
  const files = layer === 'modern'
    ? { '.pi/pi-blackhole-config.json': JSON.stringify({ observeAfterTokens: PROJECT_VALUE }) }
    : { '.pi/settings.json': JSON.stringify({ 'pi-blackhole': { observeAfterTokens: PROJECT_VALUE } }) };
  // Legacy fallback is only reachable when the unified global file is unusable (scaffold otherwise always creates it),
  // so the legacy variant starts from a corrupt global config; the positive control proves the path is live.
  const host = await makeHost({ projectTrusted: trusted, files, globalBlackholeConfig: layer === 'legacy' ? '{ not json' : undefined });
  try {
    assert.deepEqual(host.loadErrors(), []);
    const notes = [];
    const uiContext = new Proxy({ notify: m => notes.push(m) }, { get: (t, k) => k in t ? t[k] : () => undefined });
    await host.session.bindExtensions({ uiContext, mode: 'json', onError: e => notes.push(`ERR ${e.error}`) });
    log(`D01 ${layer} trusted=${trusted}: running /blackhole-memory status`);
    await withLimit(host.session.prompt('/blackhole-memory status'), 60000, 'status command');
    const status = notes.find(n => n.includes('Observer:'));
    assert.ok(status, `no status output: ${JSON.stringify(notes)}`);
    assert.equal(host.settings.isProjectTrusted(), trusted);
    return Number(/triggers at ([\d,]+)/.exec(status)[1].replace(/,/g, ''));
  } finally { await host.cleanup(); }
}

for (const layer of ['modern', 'legacy']) {
  test(`D01 positive control (${layer}): trusted project layer applies`, async () => {
    assert.equal(await statusFor({ trusted: true, layer }), PROJECT_VALUE);
  });
  test(`D01 (${layer}): untrusted project config must NOT be read`, async () => {
    assert.equal(await statusFor({ trusted: false, layer }), GLOBAL_VALUE,
      `untrusted project ${layer} layer overrode observeAfterTokens to ${PROJECT_VALUE}`);
  });
}
