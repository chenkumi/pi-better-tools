// D21: "/blackhole om-off" must patch only the global `memory` key. Spreading the merged effective config
// (defaults + global + PROJECT + env) into the global file pollutes global settings with project values.
// Real AgentSession + real Blackhole command, isolated agentDir. Asserts CORRECT behaviour; RED while the defect exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHost, log, withLimit } from './fixtures/real-host.mjs';

test('D21 om-off does not copy project-layer values into the global config file', async () => {
  const GLOBAL_OBSERVE = 20000, PROJECT_OBSERVE = 30000;
  const host = await makeHost({ env: { PI_BLACKHOLE_PASSIVE: 'false' },
    globalBlackholeConfig: { compaction: 'auto', memory: true, observeAfterTokens: GLOBAL_OBSERVE },
    files: { '.pi/pi-blackhole-config.json': JSON.stringify({ observeAfterTokens: PROJECT_OBSERVE }) } });
  try {
    assert.deepEqual(host.loadErrors(), []);
    const globalPath = join(host.agentDir, 'pi-blackhole/pi-blackhole-config.json');
    const before = JSON.parse(readFileSync(globalPath, 'utf8'));
    assert.equal(before.observeAfterTokens, GLOBAL_OBSERVE, 'precondition');
    const notes = [];
    const uiContext = new Proxy({ notify: (m, t) => notes.push(`${t}: ${m}`) }, { get: (t, k) => k in t ? t[k] : () => undefined });
    await host.session.bindExtensions({ uiContext, mode: 'json', onError: e => notes.push(`ERR ${e.error}`) });
    log('D21 running /blackhole om-off');
    await withLimit(host.session.prompt('/blackhole om-off'), 60000, 'om-off');
    assert.ok(notes.some(n => /Observational memory disabled/.test(n)), `om-off did not report success: ${JSON.stringify(notes)}`);
    const after = JSON.parse(readFileSync(globalPath, 'utf8'));
    assert.equal(after.memory, false, 'om-off must persist memory=false globally');
    assert.equal(after.observeAfterTokens, GLOBAL_OBSERVE,
      `project-layer observeAfterTokens leaked into the GLOBAL file; global now: ${JSON.stringify(after)}`);
    const added = Object.keys(after).filter(k => !(k in before));
    assert.deepEqual(added, ['memory'].filter(k => !(k in before)), `om-off wrote unrelated effective-config keys into the global file: ${added.join(', ')}`);
  } finally { await host.cleanup(); }
});
