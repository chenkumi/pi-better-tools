import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProducerFixtures } from './fixtures/producer.ts';
test('Blackhole handoff uses real producer details and actual Pi persisted custom_message entries', async () => {
  const fixtures = await buildProducerFixtures();
  for (const [name, entries] of Object.entries(fixtures)) {
    assert.ok(entries.length, name);
    for (const entry of entries as any[]) {
      assert.equal(entry.type, 'custom_message'); assert.equal(entry.customType, 'monitor_event'); assert.equal(entry.display, true); assert.ok(entry.id);
      assert.equal(entry.details.schemaVersion, 1); assert.equal(entry.details.submission.hostAcknowledgment, 'unknown'); assert.ok(entry.details.events.length <= 32);
      for (const event of entry.details.events) { assert.match(event.monitorId, /^[0-9A-HJKMNP-TV-Z]{26}$/); assert.ok(event.sequence > 0); }
    }
  }
  assert.ok((fixtures['cleanup-unknown'] as any[]).some(e => e.details.monitors.some((m: any) => m.cleanupPending && m.cleanupEvidence.sourceClosed === false)));
  for (const [mode, reason] of [['failure', 'source_error'], ['rate', 'rate_limit'], ['expiry', 'duration_exceeded']]) assert.ok((fixtures[mode!] as any[]).some(e => e.details.events.some((x: any) => x.kind === reason)));
});
