// H01 (Pi 1.1.0 host): after two compactions with an identical summary, session_compact must carry the
// entry just appended, not the older checkpoint with the same summary. RED while the host defect exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHost, log, withLimit } from './fixtures/real-host.mjs';

// KNOWN-UPSTREAM (Pi 1.1.0 host defect, dist/core/agent-session.js picks the first compaction entry with an equal
// summary instead of the appended one). Not fixable in this repo (node_modules must not be edited); `todo` keeps the
// real-host reproduction visible without failing the run. Blackhole's own safe failure (reject wrong receipt, keep
// pending) is covered by h01-wrong-receipt-safe-failure.test.ts. Remove `todo` once the host is upgraded and fixed.
test('H01 duplicate summary: session_compact references the newly appended compaction entry', { todo: 'known-upstream: Pi 1.1.0 host emits session_compact with the older same-summary checkpoint' }, async () => {
  const events = [];
  const factory = pi => {
    pi.on('session_before_compact', event => ({ compaction: { summary: 'DUPLICATE_SUMMARY', firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } }));
    pi.on('session_compact', event => { events.push(event); });
  };
  const host = await makeHost({ withBlackhole: false, extensionFactories: [factory],
    globalSettings: { compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 } } });
  try {
    assert.deepEqual(host.loadErrors(), []);
    await host.session.bindExtensions({ mode: 'json', onError: e => assert.fail(String(e.error)) });
    const compactions = () => host.sm.getEntries().filter(e => e.type === 'compaction');
    const addTurn = n => { host.user(`task ${n} ${'x'.repeat(400)}`); host.reply(`answer ${n} ${'y'.repeat(400)}`); };

    addTurn(1); addTurn(2); addTurn(3);
    log('H01 first compaction');
    await withLimit(host.session.compact(), 60000, 'first compact');
    const first = compactions().at(-1);
    addTurn(4); addTurn(5); addTurn(6);
    log('H01 second compaction (same summary)');
    await withLimit(host.session.compact(), 60000, 'second compact');
    const second = compactions().at(-1);

    assert.equal(compactions().length, 2);
    assert.notEqual(first.id, second.id);
    assert.equal(first.summary, second.summary, 'precondition: identical summaries');
    assert.equal(events.length, 2);
    assert.equal(events[0].compactionEntry.id, first.id, 'first event must reference first entry');
    assert.equal(events[1].compactionEntry.id, second.id,
      `second session_compact referenced ${events[1].compactionEntry.id} (older checkpoint) instead of newly appended ${second.id}`);
  } finally { await host.cleanup(); }
});
