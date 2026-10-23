import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '@earendil-works/pi-coding-agent';
import { loadTokenizer, runComparison } from './fixtures/tui-ab.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const scope = process.env.PI_BETTER_TOOLS_EVIDENCE_SCOPE;
if (scope && !/^[\w-]+$/.test(scope)) throw new Error('Invalid A/B evidence scope');
const evidence = scope ? join(root, 'plan/evidence', scope, 'tui-ab') : null;
const tokenizer = await loadTokenizer();

for (const [mode, order] of [['regular', [false, true]], ['fullscreen', [true, false]]]) {
  test(`Pi 1.4.0 ${mode} PTY: File Audit A/B diagnostics, bounded tracking and provider-context overhead`, { timeout: 240000 }, async () => {
    assert.equal(VERSION, '1.4.0');
    const result = await runComparison(mode, order, evidence, tokenizer);
    assert.equal(result.extraCalls, 0); assert.equal(result.externalCalls, 0);
    assert.equal(result.normalizedPayloadsEqual, true);
    if (tokenizer) assert.equal(result.normalizedTokenEstimateB - result.normalizedTokenEstimateA, 0);
    console.log(`[file-audit-ab] SUMMARY ${JSON.stringify(result)}`);
  });
}
