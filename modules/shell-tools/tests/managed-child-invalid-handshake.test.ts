import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeManagedChildGuard, isManagedForegroundChild } from '../src/managed-child.js';

const slot = globalThis as { __piSubagentsGuardExpected?: unknown };

// A handshake that is not JSON must not make an extension factory throw, and every consumer must reach the same
// conclusion (no handshake) instead of the first consumer failing and the later ones seeing nothing.
test('a non-JSON PI_SUBAGENTS_GUARD is ignored for every consumer and never inherited', () => {
  const saved = process.env.PI_SUBAGENTS_GUARD, savedSlot = slot.__piSubagentsGuardExpected;
  const warnings: string[] = [];
  const onWarning = (warning: Error) => { warnings.push(warning.message); };
  process.on('warning', onWarning);
  try {
    delete slot.__piSubagentsGuardExpected;
    process.env.PI_SUBAGENTS_GUARD = '{not-json';
    assert.doesNotThrow(() => consumeManagedChildGuard());
    assert.equal(process.env.PI_SUBAGENTS_GUARD, undefined, 'the variable is still consumed so grandchildren cannot inherit it');
    assert.equal(consumeManagedChildGuard(), undefined, 'a second consumer sees the same conclusion');
    assert.equal(isManagedForegroundChild(), false);
  } finally {
    process.off('warning', onWarning);
    if (saved === undefined) delete process.env.PI_SUBAGENTS_GUARD; else process.env.PI_SUBAGENTS_GUARD = saved;
    if (savedSlot === undefined) delete slot.__piSubagentsGuardExpected; else slot.__piSubagentsGuardExpected = savedSlot;
  }
});

test('a valid handshake is still consumed once and kept for later consumers', () => {
  const saved = process.env.PI_SUBAGENTS_GUARD, savedSlot = slot.__piSubagentsGuardExpected;
  try {
    delete slot.__piSubagentsGuardExpected;
    process.env.PI_SUBAGENTS_GUARD = JSON.stringify({ shellMode: 'foreground-v1', id: 'S1', cwd: '/w', startupPath: '/s' });
    assert.equal(isManagedForegroundChild(), true);
    assert.equal(process.env.PI_SUBAGENTS_GUARD, undefined);
    assert.equal((consumeManagedChildGuard() as { id: string }).id, 'S1');
  } finally {
    if (saved === undefined) delete process.env.PI_SUBAGENTS_GUARD; else process.env.PI_SUBAGENTS_GUARD = saved;
    if (savedSlot === undefined) delete slot.__piSubagentsGuardExpected; else slot.__piSubagentsGuardExpected = savedSlot;
  }
});
