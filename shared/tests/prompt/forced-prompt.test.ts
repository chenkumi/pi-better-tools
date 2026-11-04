import assert from 'node:assert/strict';
import test from 'node:test';
import { createForcedPromptAppender } from '../../src/prompt/index.ts';

const event = (forced: string | undefined, systemPrompt = forced ?? 'built') =>
  ({ systemPrompt, systemPromptOptions: { forceSystemPrompt: forced, sections: {} } }) as never;

test('a normal (sectioned) prompt is left alone', () => {
  assert.equal(createForcedPromptAppender()(event(undefined), 'S'), undefined);
});

test('a forced prompt gets the section appended once and updated in place', () => {
  const append = createForcedPromptAppender();
  assert.deepEqual(append(event('F'), 'A'), { systemPrompt: 'F\n\nA' });
  assert.equal(append(event('F', 'F\n\nA'), 'A'), undefined, 'unchanged text is not rewritten');
  assert.deepEqual(append(event('F\n\nA', 'F\n\nA'), 'B'), { systemPrompt: 'F\n\nB' }, 'the previous copy is replaced');
});

test('removing the section restores the forced prompt', () => {
  const append = createForcedPromptAppender();
  append(event('F'), 'A');
  assert.deepEqual(append(event('F\n\nA', 'F\n\nA'), undefined), { systemPrompt: 'F' });
});

test('each appender derives its result from the forced prompt itself', () => {
  const one = createForcedPromptAppender(), two = createForcedPromptAppender();
  const first = one(event('F'), 'A')!.systemPrompt;
  assert.deepEqual(two(event('F', first), 'B'), { systemPrompt: 'F\n\nB' }, 'each derives from the forced prompt itself');
});

test('known sections are stripped even when this instance never appended them', () => {
  const append = createForcedPromptAppender(['A']);
  assert.deepEqual(append(event('F\n\nA', 'F\n\nA'), 'A'), undefined, 'already present: nothing to change');
  assert.deepEqual(append(event('F\n\nA', 'F\n\nA'), undefined), { systemPrompt: 'F' });
});
