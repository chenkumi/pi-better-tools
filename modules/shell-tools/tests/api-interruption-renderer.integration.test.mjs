import assert from 'node:assert/strict';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { visibleWidth } from '@earendil-works/pi-tui';
import { createPiFixture } from './helpers/pi-fixture.mjs';

// Real loader, extension hooks and the host ToolExecutionComponent; no provider/command execution.
test('real Pi card becomes neutral after API recovery, while real errors and normal framing remain intact', async () => {
  const fixture = await createPiFixture();
  try {
    const { session, cwd } = await fixture.createSession({ tools: ['bash', 'read'] });
    const { ToolExecutionComponent } = await import(new URL('./modes/interactive/components/tool-execution.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href);
    const runner = session.extensionRunner;
    const base = fixture.sdk.createReadToolDefinition(cwd);
    const definition = runner.resolveToolRenderers('read', () => base);
    assert.equal(definition.renderShell, 'self');
    let renders = 0;
    const ui = { requestRender() { renders++; } };
    const args = { path: 'never-executed.txt' };
    const card = new ToolExecutionComponent('read', 'old', args, { showImages: false }, definition, ui, cwd);
    const plain = () => stripVTControlCharacters(card.render(80).join('\n'));
    const error = { role: 'assistant', stopReason: 'error', errorMessage: 'API disconnected', content: [{ type: 'toolCall', id: 'old', name: 'read', arguments: args }] };
    assert.equal(await runner.emitMessageEnd({ type: 'message_end', message: error }), undefined);
    const result = { content: [{ type: 'text', text: 'API disconnected' }], isError: true };
    const before = JSON.stringify(result);
    card.updateResult(result); assert.match(plain(), /API interrupted/); assert.match(plain(), /not executed/);
    assert.equal(JSON.stringify(result), before);
    const payload = { any: 'offline marker' };
    await runner.emitBeforeProviderRequest(payload); assert.match(plain(), /Resuming API request/);
    await runner.emitMessageEnd({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'recovered response' }] } });
    assert.match(plain(), /API response recovered/); assert.ok(renders > 0, 'event-driven card invalidation');
    card.setExpanded(true); assert.match(plain(), /Provider diagnostic: API disconnected/);
    for (const width of [4, 12, 24, 80]) for (const row of card.render(width)) assert.ok(visibleWidth(row) <= width, `overflow ${width}`);
    // Observe the entire Box, not just its textual result: real error ANSI must be absent.
    const { theme } = await import(new URL('./modes/interactive/theme/theme.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href);
    assert.notEqual(theme.getBgAnsi('toolPendingBg'), theme.getBgAnsi('toolErrorBg'));
    assert.ok(card.render(80).join('\n').includes(theme.getBgAnsi('toolPendingBg')));
    assert.ok(!card.render(80).join('\n').includes(theme.getBgAnsi('toolErrorBg')));
    card.markExecutionStarted(); card.updateResult(result);
    assert.ok(card.render(80).join('\n').includes(theme.getBgAnsi('toolErrorBg')), 'actual execution failure stays red');
    assert.doesNotMatch(plain(), /API response recovered/);
    // Unaffected cards have the same host padding/content/image pipeline and result lifecycle.
    const original = new ToolExecutionComponent('read', 'normal', args, { showImages: false, outputPad: 2 }, base, ui, cwd);
    const wrapped = new ToolExecutionComponent('read', 'normal', args, { showImages: false, outputPad: 2 }, definition, ui, cwd);
    original.markExecutionStarted(); wrapped.markExecutionStarted();
    const success = { content: [{ type: 'text', text: 'one\ntwo' }], isError: false, durationMs: 10 };
    original.updateResult(success); wrapped.updateResult(success);
    for (const expanded of [false, true]) {
      original.setExpanded(expanded); wrapped.setExpanded(expanded);
      assert.deepEqual(wrapped.render(80).map(stripVTControlCharacters), original.render(80).map(stripVTControlCharacters));
    }
    await session.reload();
    assert.deepEqual(session.agent.state.tools.map(t => t.name).sort(), ['bash', 'read']);
  } finally { fixture.cleanup(); }
});
