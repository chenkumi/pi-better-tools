import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerCheckpoint } from '../src/checkpoint/hooks.ts';
import { checkpointBody, checkpointMark, checkpointTitle, hasSavedCheckpoint } from '../src/checkpoint/mark.ts';
import { CHECKPOINT_TOOL, CONTINUE_TYPE, DEADLINE_TYPE, deadlineText } from '../src/checkpoint/messages.ts';
import { createTracker, deadlineMargin, type TurnFacts } from '../src/checkpoint/tracker.ts';
import { progressCheckpointTool } from '../src/checkpoint/tool.ts';
import { buildItems, type Entry } from '../src/compact/items.ts';
import { keptChars, limitKept } from '../src/compact/hook.ts';

const W = 100_000;
const turn = (tokens: number | null, over: Partial<TurnFacts> = {}): TurnFacts => ({ tokens, contextWindow: W, checkpointed: false, toolCalls: 1, ...over });

// ------------------------------------------------------------------------------------------------------------ deadline trigger
// Pi compacts above THRESHOLD = window - reserve; the deadline zone is the last 12% of the window before it.
const THRESHOLD = W - 16_384;
const ZONE = THRESHOLD - deadlineMargin(W);
const dl = (tokens: number | null, over: Partial<TurnFacts> = {}): TurnFacts => turn(tokens, { threshold: THRESHOLD, ...over });

test('the deadline notice is sent once, when the size enters the last stretch before Pi compacts, and only then', () => {
  const tracker = createTracker();
  assert.equal(tracker.turnEnd(dl(10_000)), 'none');
  assert.equal(tracker.turnEnd(dl(ZONE - 1)), 'none', 'just before the zone');
  assert.equal(tracker.turnEnd(dl(ZONE)), 'deadline', 'the first turn in the zone');
  assert.equal(tracker.turnEnd(dl(ZONE + 1000)), 'none', 'once per compaction cycle, whether or not it was answered');
});

test('the deadline never fires once the size is over Pi\'s threshold, or when the threshold is unknown', () => {
  const late = createTracker();
  late.turnEnd(dl(10_000));
  assert.equal(late.turnEnd(dl(THRESHOLD)), 'none', 'at the threshold Pi compacts right after this response');
  assert.equal(late.turnEnd(dl(THRESHOLD + 2000)), 'none', 'already over the threshold');
  const edge = createTracker();
  edge.turnEnd(dl(10_000));
  assert.equal(edge.turnEnd(dl(THRESHOLD - 1)), 'deadline', 'just below the threshold');
  for (const threshold of [null, undefined]) {
    const unknown = createTracker();
    unknown.turnEnd(turn(10_000, { threshold }));
    assert.equal(unknown.turnEnd(turn(ZONE + 100, { threshold })), 'none', `threshold ${threshold}`);
  }
  const ending = createTracker();
  ending.turnEnd(dl(10_000));
  assert.equal(ending.turnEnd(dl(ZONE + 100, { toolCalls: 0 })), 'none', 'a turn without tool calls ends the run anyway');
  assert.equal(createTracker().turnEnd(dl(null)), 'none', 'an unknown size');
});

test('the deadline goes by the size the provider reported; Pi\'s estimate only stands in when none was reported', () => {
  const underEstimated = createTracker();
  underEstimated.turnEnd(dl(10_000));
  assert.equal(underEstimated.turnEnd(dl(ZONE - 2000, { reportedTokens: ZONE + 10 })), 'deadline', 'the estimate is still below the zone, the reported size is not');
  const overEstimated = createTracker();
  overEstimated.turnEnd(dl(10_000));
  assert.equal(overEstimated.turnEnd(dl(THRESHOLD + 5000, { reportedTokens: ZONE - 1 })), 'none', 'the reported size is below the zone, whatever the estimate says');
  assert.equal(overEstimated.turnEnd(dl(THRESHOLD + 5000, { reportedTokens: THRESHOLD + 1 })), 'none', 'the reported size is over the threshold');
  const none = createTracker();
  none.turnEnd(dl(10_000));
  assert.equal(none.turnEnd(dl(ZONE + 10, { reportedTokens: null })), 'deadline', 'no reported size: the estimate is used');
});

test('the deadline is skipped while the checkpoint tool is not active, and sent once it is', () => {
  const tracker = createTracker();
  tracker.turnEnd(dl(10_000));
  assert.equal(tracker.turnEnd(dl(ZONE + 100, { hasTool: false })), 'none');
  assert.equal(tracker.turnEnd(dl(ZONE + 400, { hasTool: true })), 'deadline');
});

test('earlier text does not replace the checkpoint: a turn with text and tool calls is asked, a final text turn is not', () => {
  const finalText = createTracker();
  finalText.turnEnd(dl(10_000));
  assert.equal(finalText.turnEnd(dl(ZONE + 200, { toolCalls: 0 })), 'none', 'a final text ends the run');
  assert.equal(finalText.turnEnd(dl(ZONE + 400)), 'deadline', 'the next tool turn in the zone');

  const chatty = createTracker();
  chatty.turnEnd(dl(10_000));
  assert.equal(chatty.turnEnd(dl(ZONE + 100, { toolCalls: 2 })), 'deadline', 'a sentence next to tool calls must not hide the zone');
  assert.equal(chatty.turnEnd(dl(ZONE + 900, { toolCalls: 1 })), 'none', 'still once');
});

test('a checkpoint the agent saved on its own in the zone turn needs no notice, and the notice is not sent later in that cycle', () => {
  const tracker = createTracker();
  tracker.turnEnd(dl(10_000));
  assert.equal(tracker.turnEnd(dl(ZONE + 100, { checkpointed: true, toolCalls: 2 })), 'none');
  assert.equal(tracker.turnEnd(dl(ZONE + 400)), 'none', 'already saved in this cycle');
  tracker.compacted();
  assert.equal(tracker.turnEnd(dl(ZONE + 100)), 'deadline', 'the next cycle asks again');
});

test('the checkpoint call answers the notice: a later text-only turn is an ordinary final answer', () => {
  const tracker = createTracker();
  tracker.turnEnd(dl(10_000));
  assert.equal(tracker.turnEnd(dl(ZONE + 100)), 'deadline');
  assert.equal(tracker.turnEnd(dl(ZONE + 300, { checkpointed: true, toolCalls: 1 })), 'none');
  assert.equal(tracker.shouldContinue(), false, 'a tool call returns to the model');
  tracker.turnEnd(dl(ZONE + 500, { toolCalls: 0 }));
  assert.equal(tracker.shouldContinue(), false, 'the notice is closed');
});

test('a new session forgets that the notice was sent; a new user request does not', () => {
  const tracker = createTracker();
  tracker.turnEnd(dl(10_000));
  assert.equal(tracker.turnEnd(dl(ZONE + 100)), 'deadline');
  tracker.reset();
  assert.equal(tracker.turnEnd(dl(ZONE + 300)), 'none', 'same session, context did not shrink');
  tracker.restart();
  assert.equal(tracker.turnEnd(dl(ZONE + 500)), 'deadline', 'another session starts a new cycle');

  const stale = createTracker();
  stale.turnEnd(dl(10_000));
  stale.turnEnd(dl(ZONE + 100));
  stale.restart();
  assert.equal(stale.turnEnd(dl(5_000, { toolCalls: 0 })), 'none');
  assert.equal(stale.shouldContinue(), false, 'an unanswered notice of the old session does not turn a text reply into its answer');
});

test('the first text-only turn after the deadline notice that ends the run gets one continuation, even after tool turns; a turn that calls tools does not', () => {
  const textOnly = createTracker();
  textOnly.turnEnd(dl(10_000));
  assert.equal(textOnly.turnEnd(dl(ZONE + 100)), 'deadline');
  assert.equal(textOnly.turnEnd(dl(ZONE + 900, { toolCalls: 0 })), 'none');
  assert.equal(textOnly.shouldContinue(), true);
  assert.equal(textOnly.shouldContinue(), false, 'one continuation per notice');

  const worked = createTracker();
  worked.turnEnd(dl(10_000));
  worked.turnEnd(dl(ZONE + 100));
  worked.turnEnd(dl(ZONE + 900, { toolCalls: 1 }));
  assert.equal(worked.shouldContinue(), false, 'a tool call returns to the model anyway');

  const silent = createTracker();
  silent.turnEnd(dl(10_000));
  silent.turnEnd(dl(ZONE + 100));
  silent.turnEnd(dl(ZONE + 900));
  silent.turnEnd(dl(ZONE + 1500, { toolCalls: 0 }));
  assert.equal(silent.shouldContinue(), true, 'the notice is answered by the first turn without tool calls, however many tool turns come first');
  assert.equal(silent.shouldContinue(), false, 'one continuation per notice');

  const saved = createTracker();
  saved.turnEnd(dl(10_000));
  saved.turnEnd(dl(ZONE + 100));
  saved.turnEnd(dl(ZONE + 900));
  saved.turnEnd(dl(ZONE + 1500, { toolCalls: 0 }));
  saved.shouldContinue();
  saved.turnEnd(dl(ZONE + 1600, { toolCalls: 0 }));
  assert.equal(saved.shouldContinue(), false, 'a later final text is an ordinary answer');

  const compacted = createTracker();
  compacted.turnEnd(dl(10_000));
  compacted.turnEnd(dl(ZONE + 100));
  compacted.turnEnd(dl(ZONE + 900));
  compacted.compacted();
  compacted.turnEnd(dl(20_000, { toolCalls: 0 }));
  assert.equal(compacted.shouldContinue(), false, 'a compaction closes the old notice');

  const newRequest = createTracker();
  newRequest.turnEnd(dl(10_000));
  newRequest.turnEnd(dl(ZONE + 100));
  newRequest.turnEnd(dl(ZONE + 900));
  newRequest.reset();
  newRequest.turnEnd(dl(ZONE + 1500, { toolCalls: 0 }));
  assert.equal(newRequest.shouldContinue(), false, 'a new user request closes the old notice');
});

test('a compaction starts a new cycle and the notice may be sent again; a new user request does not', () => {
  const tracker = createTracker();
  tracker.turnEnd(dl(10_000));
  assert.equal(tracker.turnEnd(dl(ZONE + 100)), 'deadline');
  tracker.reset();
  assert.equal(tracker.turnEnd(dl(ZONE + 2000)), 'none', 'the context did not shrink, so the notice stays sent');
  tracker.compacted();
  assert.equal(tracker.turnEnd(dl(null)), 'none');
  assert.equal(tracker.turnEnd(dl(30_000)), 'none');
  assert.equal(tracker.turnEnd(dl(ZONE + 100)), 'deadline', 'the next cycle asks again');
});

test('the margin cannot reach back past half of the threshold: a small window or a huge floor does not fire on the first turn', () => {
  const tracker = createTracker();
  const small = { threshold: 15_616, marginMinTokens: 20_000 };
  assert.equal(tracker.turnEnd(turn(2_000, { ...small, contextWindow: 32_000 })), 'none', 'tiny context, 20k floor on a 32k window');
  assert.equal(tracker.turnEnd(turn(7_807, { ...small, contextWindow: 32_000 })), 'none', 'just under half of the threshold');
  assert.equal(tracker.turnEnd(turn(7_808, { ...small, contextWindow: 32_000 })), 'deadline', 'half of the threshold');
  const huge = createTracker();
  assert.equal(huge.turnEnd(turn(10_000, { threshold: W - 16_384, marginMinTokens: 5_000_000 })), 'none', 'a huge floor');
  assert.equal(huge.turnEnd(turn((W - 16_384) / 2, { threshold: W - 16_384, marginMinTokens: 5_000_000 })), 'deadline');
});

// -------------------------------------------------------------------------------------------------------------------- hooks
type Handler = (event: any, ctx: any) => any;
function withAgentDir<T>(file: string | undefined, run: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'auto-compact-cp-')), previous = process.env.PI_CODING_AGENT_DIR;
  if (file !== undefined) writeFileSync(join(dir, 'auto-compact.json'), file);
  process.env.PI_CODING_AGENT_DIR = dir;
  try { return run(); }
  finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(dir, { recursive: true, force: true }); }
}
const MODEL = { provider: 'p', id: 'm', contextWindow: W };
function loadWithSettings(settings: unknown, active: string[] = [CHECKPOINT_TOOL, 'bash']) {
  const handlers = new Map<string, Handler>();
  registerCheckpoint({ on: (name: string, handler: Handler) => { handlers.set(name, handler); }, getActiveTools: () => active, getSettings: () => { if (settings instanceof Error) throw settings; return settings; } } as unknown as ExtensionAPI);
  return handlers;
}
const ctx = (tokens: number | null, branch: unknown[] = []) => ({ getContextUsage: () => ({ tokens, contextWindow: W, percent: 0 }), model: { contextWindow: W }, sessionManager: { getBranch: () => branch } });
const assistant = (...blocks: unknown[]) => ({ role: 'assistant', content: blocks });
const call = (name: string) => ({ type: 'toolCall', id: `id-${name}`, name, arguments: { summary: 'r' } });
const text = (value: string) => ({ type: 'text', text: value });
const endTurn = (handlers: Map<string, Handler>, tokens: number, message: unknown, model: unknown = { contextWindow: W }) =>
  handlers.get('turn_end')!({ message, entries: [], toolResults: [] }, { ...ctx(tokens), model });
const zoneStart = (reserve = 16_384) => W - reserve - deadlineMargin(W);

test('the hook asks shortly before Pi\'s threshold, using Pi\'s settings: reserve, per-model override, compaction off, unreadable settings', () => withAgentDir(undefined, () => {
  const run = (settings: unknown, tokens: number) => {
    const handlers = loadWithSettings(settings);
    handlers.get('session_start')!({}, {});
    endTurn(handlers, 10_000, assistant(call('bash')), MODEL);
    return endTurn(handlers, tokens, assistant(call('bash')), MODEL);
  };
  const out = run({}, zoneStart() + 1);
  assert.equal(out.continue, true); assert.equal(out.entries[0].customType, DEADLINE_TYPE); assert.equal(out.entries[0].display, false);
  assert.equal(out.entries[0].content, deadlineText());
  assert.match(String(out.entries[0].content), /compaction will happen soon[\s\S]*calling progress_checkpoint[\s\S]*next action/);
  assert.equal(run({}, zoneStart() - 1), undefined, 'the default reserve puts the zone at about 71.6k');
  assert.equal(run({ compaction: { reserveTokens: 5000 } }, zoneStart() + 1), undefined, 'a smaller reserve moves the zone later');
  assert.equal(run({ compaction: { reserveTokens: 5000 } }, zoneStart(5000) + 1).continue, true);
  assert.equal(run({ compaction: { reserveTokens: 5000, modelOverrides: { 'p/m': { reserveTokens: 30_000 } } } }, zoneStart(30_000) + 1).continue, true, 'the override of this model wins');
  assert.equal(run({ compaction: { enabled: false } }, zoneStart() + 1), undefined, 'Pi does not compact, so there is no deadline');
  assert.equal(run({ compaction: { reserveTokens: -1 } }, zoneStart() + 1), undefined, 'a value Pi rejects is not guessed at');
  assert.equal(run(new Error('boom'), zoneStart() + 1), undefined, 'unreadable settings');
}));

test('nothing is sent when the checkpoint tool is not active, or when the turn called it itself', () => withAgentDir(undefined, () => {
  const run = (active: string[], message: unknown) => {
    const handlers = loadWithSettings({}, active);
    handlers.get('session_start')!({}, {});
    endTurn(handlers, 10_000, assistant(call('bash')), MODEL);
    return endTurn(handlers, zoneStart() + 1, message, MODEL);
  };
  assert.equal(run(['bash'], assistant(call('bash'))), undefined, 'excluded by the host');
  assert.equal(run([CHECKPOINT_TOOL, 'bash'], assistant(call('bash'), call(CHECKPOINT_TOOL))), undefined, 'already saved in this turn');
  assert.ok(run([CHECKPOINT_TOOL], assistant(call('bash'))), 'a read-only agent can still save a checkpoint');
}));

test('an invalid settings file turns the notice off, and the removed interval keys are unknown keys', () => {
  for (const file of ['{ "l1Ratio": 5 }']) {
    withAgentDir(file, () => {
      const handlers = loadWithSettings({});
      handlers.get('session_start')!({}, {});
      endTurn(handlers, 10_000, assistant(call('bash')), MODEL);
      assert.equal(endTurn(handlers, zoneStart() + 1, assistant(call('bash')), MODEL), undefined, file);
    });
  }
});

test('a text answer to the notice that ends the run gets one continuation message at the settle boundary; a checkpoint call does not', () => withAgentDir(undefined, () => {
  const textual = loadWithSettings({});
  textual.get('session_start')!({}, {});
  endTurn(textual, 10_000, assistant(call('bash')), MODEL); endTurn(textual, zoneStart() + 1, assistant(call('bash')), MODEL);
  endTurn(textual, zoneStart() + 500, assistant(text('Done so far: A. Next: B.')), MODEL);
  const settle = textual.get('agent_before_settle')!({ entries: [] }, ctx(1));
  assert.equal(settle.continue, true); assert.equal(settle.entries[0].customType, CONTINUE_TYPE);
  assert.equal(textual.get('agent_before_settle')!({ entries: [] }, ctx(1)), undefined);

  const saved = loadWithSettings({});
  saved.get('session_start')!({}, {});
  endTurn(saved, 10_000, assistant(call('bash')), MODEL); endTurn(saved, zoneStart() + 1, assistant(call('bash')), MODEL);
  endTurn(saved, zoneStart() + 500, assistant(call(CHECKPOINT_TOOL)), MODEL);
  assert.equal(saved.get('agent_before_settle')!({ entries: [] }, ctx(1)), undefined);
}));

test('the hook reads the notice margin floor from the settings file: a bigger floor asks earlier, 0 leaves the 10% share', () => {
  const asks = (file: string | undefined, tokens: number) => withAgentDir(file, () => {
    const handlers = loadWithSettings({});
    handlers.get('session_start')!({}, {});
    endTurn(handlers, 10_000, assistant(call('bash')), MODEL);
    return endTurn(handlers, 10_000, { ...assistant(call('bash')), usage: { totalTokens: tokens } }, MODEL) !== undefined;
  });
  const threshold = W - 16_384;
  assert.equal(asks(undefined, threshold - 20_000), true, 'default floor 20k');
  assert.equal(asks(undefined, threshold - 20_001), false, 'just before the default zone');
  assert.equal(asks('{ "deadlineMarginMinTokens": 30000 }', threshold - 30_000), true, 'larger floor');
  assert.equal(asks('{ "deadlineMarginMinTokens": 0 }', threshold - 10_000), true, 'floor 0: the 10% share (10k of 100k)');
  assert.equal(asks('{ "deadlineMarginMinTokens": 0 }', threshold - 10_001), false, 'floor 0: before the 10% share');
});

test('the hook takes the size from the response usage (totalTokens, else the sum of the parts); an error, an abort or no usage fall back to Pi\'s estimate', () => withAgentDir(undefined, () => {
  const zone = zoneStart();
  const asks = (extra: Record<string, unknown>) => {
    const handlers = loadWithSettings({});
    handlers.get('session_start')!({}, {});
    endTurn(handlers, 10_000, assistant(call('bash')), MODEL);
    return endTurn(handlers, 10_000, { ...assistant(call('bash')), ...extra }, MODEL) !== undefined;
  };
  assert.equal(asks({ usage: { totalTokens: zone + 10 } }), true, 'totalTokens');
  assert.equal(asks({ usage: { input: zone, output: 20, cacheRead: 0, cacheWrite: 0 } }), true, 'sum of the parts');
  assert.equal(asks({ usage: { totalTokens: zone - 10 } }), false, 'reported size below the zone');
  assert.equal(asks({ usage: { totalTokens: zone + 10 }, stopReason: 'aborted' }), false, 'an aborted response reports nothing usable');
  assert.equal(asks({ usage: { totalTokens: zone + 10 }, stopReason: 'error' }), false, 'nor does an error');
  assert.equal(asks({ usage: { totalTokens: 0 } }), false, 'a zero usage is no usage');
  assert.equal(asks({}), false, 'no usage at all: the estimate (10k) decides');
}));

test('after a compaction the answered notice messages leave the model context; the unanswered one and everything else stay', () => withAgentDir(undefined, () => {
  const handlers = loadWithSettings({});
  const custom = (customType: string) => ({ role: 'custom', customType, content: 'x', display: false });
  const messages = [{ role: 'user', content: 'q' }, assistant(call('bash')), custom(DEADLINE_TYPE), assistant(text('report')), custom('other'), custom(CONTINUE_TYPE), custom(DEADLINE_TYPE), assistant(call('bash')), custom(DEADLINE_TYPE)];
  assert.equal(handlers.get('context')!({ messages }, ctx(1, [{ type: 'message' }])), undefined, 'without a compaction nothing is removed');
  const out = handlers.get('context')!({ messages }, ctx(1, [{ type: 'compaction' }]));
  assert.deepEqual(out.messages.map((m: { role: string; customType?: string }) => m.customType ?? m.role), ['user', 'assistant', 'assistant', 'other', 'assistant', DEADLINE_TYPE]);
}));

// -------------------------------------------------------------------------------------------------------------------- compaction
let seq = 0;
const entry = (message: Record<string, unknown>): Entry => ({ type: 'message', id: `e${++seq}`, parentId: null, timestamp: 't', message });
const asAssistant = (...blocks: unknown[]) => entry({ role: 'assistant', content: blocks });
const result = (id: string, name: string, value: string) => entry({ role: 'toolResult', toolCallId: id, toolName: name, content: [text(value)], isError: false });
const userEntry = (value: string) => entry({ role: 'user', content: [text(value)] });
const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({ type: 'toolCall', id, name, arguments: args });

test('a checkpoint call stays a normal tool call pair for the summary, and the notice entries are not items', () => {
  const entries = [userEntry('go'), asAssistant(text('checking'), toolCall('p1', CHECKPOINT_TOOL, { summary: '# Parser done\ntests next.' })), result('p1', CHECKPOINT_TOOL, 'Checkpoint saved. Continue the task.'),
    { type: 'custom_message', id: 'c1', customType: DEADLINE_TYPE, content: 'ignore me', display: false } as Entry];
  const items = buildItems(entries, () => undefined);
  assert.deepEqual(items.map(item => item.kind), ['user', 'assistant']);
  assert.equal(items[1]!.text, 'checking');
  assert.equal(items[1]!.calls.length, 1);
  assert.equal(items[1]!.calls[0]!.result?.text, 'Checkpoint saved. Continue the task.');
  assert.equal(checkpointTitle(items[1]!.calls[0]!.call.args), 'Parser done');
  assert.equal(checkpointMark('Parser done'), 'checkpoint: Parser done');
  assert.equal(checkpointBody({ summary: 'x' }), 'x');
});

test('hasSavedCheckpoint needs a checkpoint call with text and a successful result', () => {
  const ok = (id: string) => result(id, CHECKPOINT_TOOL, 'Checkpoint saved. Continue the task.');
  const failed = entry({ role: 'toolResult', toolCallId: 'p', toolName: CHECKPOINT_TOOL, content: [text('blocked')], isError: true });
  assert.equal(hasSavedCheckpoint([asAssistant(toolCall('p', CHECKPOINT_TOOL, { summary: 'x' })), ok('p')]), true);
  assert.equal(hasSavedCheckpoint([asAssistant(toolCall('p', CHECKPOINT_TOOL, { summary: 'x' }))]), false, 'no result');
  assert.equal(hasSavedCheckpoint([asAssistant(toolCall('p', CHECKPOINT_TOOL, { summary: 'x' })), failed]), false, 'failed call');
  assert.equal(hasSavedCheckpoint([asAssistant(toolCall('p', CHECKPOINT_TOOL, { summary: '  ' })), ok('p')]), false, 'empty summary');
  assert.equal(hasSavedCheckpoint([asAssistant(toolCall('p', 'bash', { summary: 'x' })), ok('p')]), false);
  assert.equal(hasSavedCheckpoint([userEntry('x')]), false);
});

test('the L1 ceiling is pure budget: a checkpoint never pulls the cut later than the earliest cut point that fits', () => {
  const big = (id: string) => asAssistant(toolCall(id, 'bash', { command: 'x'.repeat(100) }));
  const entries = [userEntry('go'), big('b1'), result('b1', 'bash', 'r'.repeat(100)), big('b2'), result('b2', 'bash', 'r'.repeat(100)), asAssistant(toolCall('p', CHECKPOINT_TOOL, { summary: 'report' })), result('p', CHECKPOINT_TOOL, 'recorded'), big('b3'), result('b3', 'bash', 'r'.repeat(100))];
  const sizeFrom = (i: number) => entries.slice(i).reduce((n, e) => n + keptChars(e), 0);
  assert.equal(limitKept(entries, 0, sizeFrom(3) + 1), 3, 'the bare tool call at index 3 fits and is the cut, although the checkpoint at 5 is a savepoint');
  const bare = entries.map((e, i) => (i === 5 ? big('p') : e));
  assert.equal(limitKept(bare, 0, bare.slice(3).reduce((n, e) => n + keptChars(e), 0) + 1), 3, 'without any savepoint the result is the same');
});

test('the checkpoint tool is active by default, takes one required text without a length limit, and answers with a short fixed text', async () => {
  assert.equal(progressCheckpointTool.name, CHECKPOINT_TOOL);
  assert.equal((progressCheckpointTool as { defaultActive?: boolean }).defaultActive, true);
  const schema = progressCheckpointTool.parameters as { required?: string[]; additionalProperties?: boolean; properties?: { summary?: { maxLength?: number; minLength?: number } } };
  assert.deepEqual(schema.required, ['summary']); assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties?.summary?.maxLength, undefined, 'no length limit');
  assert.equal(schema.properties?.summary?.minLength, 1);
  const out = await progressCheckpointTool.execute('t', { summary: 'x'.repeat(50_000) } as never, undefined, undefined, {} as never);
  assert.match(String((out.content[0] as { text: string }).text), /Continue the task/);
  assert.equal(typeof progressCheckpointTool.renderCall, 'function'); assert.equal(typeof progressCheckpointTool.renderResult, 'function');
});
