import assert from 'node:assert/strict';
import test from 'node:test';
import { Text } from '@earendil-works/pi-tui';
import { ApiInterruptionState, interruptionRenderers, registerApiInterruptionRenderer } from '../src/api-interruption-renderer.js';

const theme: any = { fg: (_: string, s: string) => s, bg: (name: string, s: string) => `[${name}]${s}`, getBgAnsi: () => '' };
const error = (id = 'old') => ({ role: 'assistant', stopReason: 'error', errorMessage: 'API disconnected', content: [{ type: 'toolCall', id, name: 'read', arguments: {} }] });
const result = () => ({ content: [{ type: 'text', text: 'API disconnected' }], details: undefined });
const context = (id = 'old'): any => ({ toolCallId: id, state: {}, executionStarted: false, isPartial: false, isError: true, outputPad: 1, expanded: false, invalidate() {} });

test('interruption needs an actual request then successful response; normal messages alone are not recovery', () => {
  const s = new ApiInterruptionState(); s.message(error());
  assert.equal(s.records.get('old')?.phase, 'interrupted');
  s.message({ role: 'assistant', stopReason: 'stop' }); assert.equal(s.records.get('old')?.phase, 'interrupted');
  s.message(error()); s.request(); assert.equal(s.records.get('old')?.phase, 'resuming');
  s.message({ role: 'assistant', stopReason: 'toolUse' }); assert.equal(s.records.get('old')?.phase, 'recovered');
});

test('execution evidence, payload metadata, partials and unmatched text prevent hiding real failures', () => {
  const s = new ApiInterruptionState(); s.message(error()); const ctx = context();
  assert.ok(s.synthetic('old', result(), ctx));
  for (const c of [{ ...ctx, executionStarted: true }, { ...ctx, isPartial: true }, { ...ctx, isError: false }]) assert.equal(s.synthetic('old', result(), c), undefined);
  for (const r of [{ ...result(), details: {} }, { ...result(), structuredContent: {} }, { content: [{ type: 'text', text: 'exit 1' }] }]) assert.equal(s.synthetic('old', r, ctx), undefined);
  s.execution('old'); s.message(error()); assert.equal(s.synthetic('old', result(), ctx), undefined);
});

test('cancel, new input, retry failure and session switch never become recovery or success', () => {
  for (const boundary of ['cancel', 'input', 'settled']) {
    const s = new ApiInterruptionState(); s.message(error()); s.request();
    if (boundary === 'cancel') s.message({ role: 'assistant', stopReason: 'aborted' }); else s.boundary();
    s.request(); s.message({ role: 'assistant', stopReason: 'stop' }); assert.equal(s.records.get('old')?.phase, 'interrupted');
  }
  const s = new ApiInterruptionState(); s.message(error()); s.request(); s.message(error('second'));
  assert.equal(s.records.get('old')?.phase, 'interrupted'); s.reset(); assert.equal(s.records.size, 0);
  s.message({ ...error(), stopReason: 'aborted' }); assert.equal(s.records.size, 0);
});

test('historical branch restoration is conservative, excludes real tool results, and bounds memory', () => {
  const s = new ApiInterruptionState();
  s.reset([{ type: 'message', message: error() }, { type: 'message', message: { role: 'assistant', stopReason: 'stop' } }]);
  assert.equal(s.records.get('old')?.phase, 'interrupted');
  s.reset([{ type: 'message', message: error() }, { type: 'message', message: { role: 'toolResult', toolCallId: 'old', isError: true } }]); assert.equal(s.records.size, 0);
  for (let i = 0; i < 600; i++) s.message(error(String(i))); assert.equal(s.records.size, 512);
});

test('default shell framing becomes neutral without altering results; expanded diagnostics and original component reuse', () => {
  const s = new ApiInterruptionState(); const ctx = context(); const original = new Text('original', 0, 0); let calls = 0; let prior: any;
  const base: any = { renderCall: (_: any, _t: any, c: any) => { prior = c.lastComponent; return original; }, renderResult: () => { calls++; return new Text('real result', 0, 0); } };
  const wrapped = interruptionRenderers(base, s); const card = wrapped.renderCall!({}, theme, ctx); wrapped.renderResult!(result() as any, { expanded: false, isPartial: false }, theme, ctx);
  assert.match(card.render(100).join('\n'), /toolErrorBg/); assert.equal(calls, 1);
  s.message(error()); const unchanged = structuredClone(result()); wrapped.renderCall!({}, theme, ctx); assert.equal(prior, original);
  wrapped.renderResult!(unchanged as any, { expanded: false, isPartial: false }, theme, ctx);
  let text = card.render(100).join('\n'); assert.match(text, /toolPendingBg/); assert.doesNotMatch(text, /toolErrorBg/); assert.match(text, /not executed/); assert.equal(calls, 1);
  s.request(); s.message({ role: 'assistant', stopReason: 'stop' }); wrapped.renderResult!(unchanged as any, { expanded: true, isPartial: false }, theme, ctx);
  text = card.render(100).join('\n'); assert.match(text, /response recovered/); assert.match(text, /Provider diagnostic/); assert.deepEqual(unchanged, result());
  ctx.executionStarted = true; wrapped.renderResult!(unchanged as any, { expanded: false, isPartial: false }, theme, ctx); assert.match(card.render(100).join('\n'), /toolErrorBg/); assert.equal(calls, 2);
});

test('self-shell delegates unchanged except exact synthetic provider error; missing renderers remain untouched', () => {
  const s = new ApiInterruptionState(); const base: any = { renderShell: 'self', renderCall: () => new Text('call'), renderResult: () => new Text('actual error') };
  const wrapped = interruptionRenderers(base, s), ctx = context(); s.message(error());
  assert.match(wrapped.renderResult!(result() as any, { expanded: false, isPartial: false }, theme, ctx).render(100).join('\n'), /toolPendingBg/);
  ctx.executionStarted = true; assert.match(wrapped.renderResult!(result() as any, { expanded: false, isPartial: false }, theme, ctx).render(100).join('\n'), /actual error/);
  const missing = {}; assert.equal(interruptionRenderers(missing, s), missing);
});

test('registration only observes public events; no execution, prompt, tool selection or persistence changes', () => {
  const handlers = new Map<string, any>(); let resolver: any;
  registerApiInterruptionRenderer({ registerToolRenderer: (r: any) => { resolver = r; }, on: (name: string, fn: any) => { handlers.set(name, fn); } } as any);
  assert.equal(resolver('unknown', () => undefined), undefined);
  assert.deepEqual([...handlers.keys()], ['message_end', 'before_provider_request', 'tool_execution_start', 'tool_execution_end', 'input', 'agent_settled', 'session_start', 'session_shutdown']);
  const m = error(); assert.equal(handlers.get('message_end')({ message: m }), undefined); assert.deepEqual(m, error());
  for (const sessionManager of [{}, { getBranch() { throw new Error('disposed'); } }, { getBranch: () => null }]) {
    assert.doesNotThrow(() => handlers.get('session_start')({}, { sessionManager }), 'presentation must tolerate unavailable history');
  }
});
