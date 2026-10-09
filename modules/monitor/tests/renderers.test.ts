import test from 'node:test';
import assert from 'node:assert/strict';
import { monitorRenderers } from '../src/renderers.ts';
const theme: any = { fg: (_color: string, text: string) => text };
test('Monitor renderer reports close only when sourceClosed evidence exists', () => {
  const renderer = monitorRenderers('status').renderResult!;
  const render = (details: any) => renderer({ content: [{ type: 'text', text: 'receipt' }], details }, { expanded: false } as any, theme, {} as any).render(120).join('\n');
  assert.doesNotMatch(render({ monitorId: 'MON', state: 'failed', cleanupPending: false, cleanupEvidence: { sourceClosed: false } }), /Source close observed/);
  assert.match(render({ monitorId: 'MON', state: 'completed', cleanupPending: false, cleanupEvidence: { sourceClosed: true } }), /Source close observed/);
});
