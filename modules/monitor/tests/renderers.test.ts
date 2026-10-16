import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { visibleWidth } from '@earendil-works/pi-tui';
import { monitorRenderers, renderMonitorEvent } from '../src/renderers.ts';
const theme: any = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, getBgAnsi: () => '' };
test('Monitor renderer reports close only when sourceClosed evidence exists', () => {
  const renderer = monitorRenderers('status').renderResult!;
  const render = (details: any) => renderer({ content: [{ type: 'text', text: 'receipt' }], details }, { expanded: false } as any, theme, {} as any).render(120).join('\n');
  assert.doesNotMatch(render({ monitorId: 'MON', state: 'failed', cleanupPending: false, cleanupEvidence: { sourceClosed: false } }), /Source close observed/);
  assert.match(render({ monitorId: 'MON', state: 'completed', cleanupPending: false, cleanupEvidence: { sourceClosed: true } }), /Source close observed/);
});

const payload = (wakeAgent = false) => ({ schemaVersion: 1, batchSequence: 1,
  monitors: [{ monitorId: '01MONITORFULLID', source: 'command', state: 'completed', wakeAgent, cleanupPending: false, cleanupEvidence: { sourceClosed: true, exitCode: 0 }, omitted: 0 }],
  events: Array.from({ length: 5 }, (_, i) => ({ eventId: `EVENT-${i}`, monitorId: '01MONITORFULLID', sequence: i + 1, kind: 'command', text: `LINE-${i} 中文\t\x1b[31mred\x1b[0m\u202e`, partial: i === 4 })),
  partial: true, submission: { state: 'submitted', hostAcknowledgment: 'unknown' },
});
const renderEvent = (details: any, expanded = false, width = 120, content = 'RAW_JSON_MUST_NOT_APPEAR') => renderMonitorEvent({ details, content } as any, { expanded } as any, theme)!;
test('Monitor event panel is compact/expandable, sanitized, bounded and does not mutate model data', () => {
  const details = payload(), before = JSON.stringify(details);
  const compact = renderEvent(details).render(120).join('\n');
  assert.match(compact, /Monitor observations/); assert.match(compact, /Display only/);
  assert.match(compact, /Source close observed; descendant state unknown/);
  assert.doesNotMatch(compact, /LINE-0|01MONITORFULLID|RAW_JSON|schemaVersion|\x1b|\u202e/);
  const expanded = renderEvent(details, true).render(120).join('\n');
  assert.match(expanded, /LINE-0/); assert.match(expanded, /01MONITORFULLID/); assert.match(expanded, /partial/);
  for (const width of [0, 1, 2, 12, 40, 80]) {
    const lines = renderEvent(details, true).render(width);
    assert.ok(lines.length <= 300);
    for (const line of lines) assert.ok(visibleWidth(stripVTControlCharacters(line)) <= width, `width ${width}`);
  }
  assert.equal(JSON.stringify(details), before);
});
test('Monitor event wake/unknown/cleanup/snapshot metadata is truthful, including legacy bodies', () => {
  assert.match(renderEvent(payload(true)).render(120).join('\n'), /Agent turn requested/);
  const details: any = payload(); delete details.monitors[0].wakeAgent;
  details.monitors[0].state = 'failed'; details.monitors[0].cleanupEvidence.sourceClosed = false;
  details.events = [{ monitorId: '01MONITORFULLID', kind: 'shell_job', snapshot: { status: 'running', exitCode: 3, output: 'safe snapshot' } }];
  const shown = renderEvent(details, true).render(120).join('\n');
  assert.match(shown, /wake mode unavailable/); assert.match(shown, /Source close not confirmed/); assert.match(shown, /status: running/);
  assert.doesNotMatch(shown, /Source close observed/);
  const legacy = renderEvent(undefined, true, 120, 'Returned data\n' + JSON.stringify(details)).render(120).join('\n');
  assert.match(legacy, /status: running/);
  assert.match(renderEvent(undefined, false, 120, '{bad json').render(120).join('\n'), /Insufficient Monitor event data/);
  const huge = payload(); huge.events[0].text = 'x\n'.repeat(20000);
  assert.ok(renderEvent(huge, true).render(10).length <= 300);
});
