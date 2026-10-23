import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '@earendil-works/pi-coding-agent';
import { loadTokenizer } from './fixtures/tui-ab.mjs';
import { runWorkflow } from './fixtures/tui-workflow.mjs';

const scope = process.env.PI_BETTER_TOOLS_EVIDENCE_SCOPE;
if (scope && !/^[\w-]+$/.test(scope)) throw new Error('Invalid workflow evidence scope');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = scope ? join(root, 'plan/evidence', scope, 'workflow') : null;
const tokenizer = await loadTokenizer();
for (const [scenario, order] of [['clean', ['A', 'B', 'C']], ['late-overwrite', ['C', 'A', 'B']], ['evicted', ['B', 'C', 'A']]]) {
  test(`Pi 1.4.0 workflow ${scenario}: external writer, real target test and A/B/C delivery gates`, { timeout: 180000 }, async () => {
    assert.equal(VERSION, '1.4.0');
    const result = await runWorkflow(scenario, order, evidence, tokenizer);
    assert.equal(result.externalCalls, 0); assert.equal(result.normalizedPayloadsEqual, true);
    console.log(`[workflow] SUMMARY ${JSON.stringify({ scenario, order, estimatedTokensPerArm: result.estimatedNormalizedTokensPerArm,
      arms: Object.fromEntries(Object.entries(result.arms).map(([key, arm]) => [key, {
        gate: arm.initialGate, diagnostic: arm.diagnosticFound, falseDelivery: arm.falseDelivery,
        repaired: arm.repaired, cost: arm.cost, exitCode: arm.exitCode,
      }])) })}`);
  });
}
