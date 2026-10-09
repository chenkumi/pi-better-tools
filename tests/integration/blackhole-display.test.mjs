import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from '../helpers/environment.mjs';
import { runCommand } from '../../modules/file-tools/scripts/test-process.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
test('Blackhole Pi 1.1.0 native cut retains the newest final and persists only the newest dropped display copy', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-blackhole-resume-'));
  try {
    const output = await runCommand('blackhole Pi 1.1.0 native-cut compact/resume', process.execPath,
      ['tests/fixtures/blackhole-display.mjs', root], { cwd: root, env: isolatedEnv(home), timeoutMs: 180000 });
    const result = JSON.parse(output.trim().split('\n').at(-1));
    assert.equal(result.contract, 'pi-owned-native-cut-display-v1'); assert.equal(result.host, '1.1.0');
    for (const key of ['nativeCut', 'persisted', 'resumed', 'rendered', 'duplicateSafe', 'displayOnly', 'noModelCopyDuplicate']) assert.equal(result[key], true, key);
    assert.deepEqual(result.counterSemantics, { modelStreamCalls: 'main-agent-streamFunction-invocations', actualExternalFetchCalls: 'global-fetch-attempts', providerCalls: 'compatibility-alias-of-actualExternalFetchCalls' });
    for (const key of ['modelStreamCalls', 'actualExternalFetchCalls', 'providerCalls']) assert.equal(result[key], 0, key);
    assert.equal(Object.hasOwn(result, 'compactAll'), false);
    assert.deepEqual(result.cases.map(row => row.scenario), ['retained-final', 'dropped-final']);
    for (const row of result.cases) {
      assert.equal(row.nativeCut, true); assert.equal(row.firstKeptEntryId, row.expectedFirstKeptEntryId); assert.ok(typeof row.firstKeptEntryId === 'string' && row.firstKeptEntryId.length > 0);
      assert.equal(row.tokensBefore, row.expectedTokensBefore); assert.ok(Number.isSafeInteger(row.tokensBefore) && row.tokensBefore > 0);
      assert.equal(row.keepRecentTokens, 8); assert.equal(row.reserveTokens, 256);
      for (const key of ['summaryInputExact', 'toolPairsComplete', 'currentFinalRetained', 'persisted', 'resumed', 'rawHistoryDiskExact', 'resumedCompactionExact', 'duplicateSafe', 'displayOnly', 'noModelCopyDuplicate']) assert.equal(row[key], true, key);
      assert.equal(row.currentFinalCopied, false); for (const key of ['modelStreamCalls', 'actualExternalFetchCalls', 'providerCalls']) assert.equal(row[key], 0, key);
    }
    assert.equal(result.cases[0].copies, 0); assert.equal(result.cases[0].rendered, false); assert.equal(result.cases[0].copiedSourceOutsideContext, false);
    assert.equal(result.cases[1].copies, 1); assert.equal(result.cases[1].rendered, true); assert.equal(result.cases[1].copiedSourceOutsideContext, true);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('ROOT W1 actual Agent.prompt proves the shared model counter and rejects wrong instance streamFn wiring', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-blackhole-stream-control-'));
  try {
    const output = await runCommand('actual Pi 1.1.0 Agent.prompt stream-counter control', process.execPath,
      ['tests/fixtures/blackhole-display.mjs', root, '--counter-control'], { cwd: root, env: isolatedEnv(home), timeoutMs: 180000 });
    const result = JSON.parse(output.trim().split('\n').at(-1));
    assert.equal(result.contract, 'pi-agent-stream-counter-control-v1'); assert.equal(result.host, '1.1.0');
    assert.deepEqual(result.counterSemantics, { modelStreamCalls: 'main-agent-streamFunction-invocations', actualExternalFetchCalls: 'global-fetch-attempts', providerCalls: 'compatibility-alias-of-actualExternalFetchCalls' });
    assert.deepEqual(result.controls.map(row => row.wiring), ['fixture-shared-installer', 'intentional-wrong-instance-field']);
    const [positive, negative] = result.controls;
    assert.equal(positive.modelStreamCalls, 1); assert.equal(positive.constructorBaselineCalls, 0); assert.equal(positive.failureReason, 'OFFLINE_MODEL_STREAM_FORBIDDEN');
    assert.equal(negative.modelStreamCalls, 0); assert.equal(negative.constructorBaselineCalls, 1); assert.equal(negative.failureReason, 'OFFLINE_CONSTRUCTOR_BASELINE_FORBIDDEN');
    for (const row of result.controls) {
      assert.equal(row.actualExternalFetchCalls, 0); assert.equal(row.providerCalls, 0); assert.equal(row.modelResponses, 0);
      assert.equal(row.stopReason, 'error'); assert.equal(row.publicPrompt, true); assert.equal(row.idle, true);
    }
  } finally { await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
