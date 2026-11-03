import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerCheckpoint } from '../src/checkpoint/hooks.ts';
import { ANCHOR_TOOL, CHECKPOINT_TYPE, CONTINUE_TYPE } from '../src/checkpoint/messages.ts';
import { createTracker, DEADLINE_MARGIN_RATIO, REQUEST_TOKENS, type TurnFacts } from '../src/checkpoint/tracker.ts';
import { progressCheckpointTool } from '../src/checkpoint/tool.ts';
import { buildItems, type Entry } from '../src/compact/items.ts';
import { keptChars, limitKept } from '../src/compact/hook.ts';

const W = 100_000;
const turn = (tokens: number | null, over: Partial<TurnFacts> = {}): TurnFacts => ({ tokens, contextWindow: W, hasText: false, anchored: false, toolCalls: 1, ...over });

test('a checkpoint is requested once the context grew by the ratio since the base, then the base moves so it does not repeat', () => {
  const tracker = createTracker();
  assert.equal(tracker.turnEnd(turn(10_000), 0.5), 'none', 'the first known size is the base');
  assert.equal(tracker.turnEnd(turn(59_000), 0.5), 'none');
  assert.equal(tracker.turnEnd(turn(60_000), 0.5), 'checkpoint');
  assert.equal(tracker.turnEnd(turn(90_000), 0.5), 'none', 'a request that is ignored does not repeat while requested');
});

test('assistant text and an anchor call both reset the count; unknown sizes and tool-less turns never request', () => {
  const tracker = createTracker();
  tracker.turnEnd(turn(10_000), 0.5);
  assert.equal(tracker.turnEnd(turn(55_000, { hasText: true }), 0.5), 'none');
  assert.equal(tracker.turnEnd(turn(100_000), 0.5), 'none', '45k since the text is below the ratio');
  assert.equal(tracker.turnEnd(turn(106_000, { anchored: true, toolCalls: 0 }), 0.5), 'none');
  assert.equal(tracker.turnEnd(turn(150_000), 0.5), 'none', '44k since the anchor');
  assert.equal(tracker.turnEnd(turn(null), 0.5), 'none');
  assert.equal(tracker.turnEnd(turn(200_000, { toolCalls: 0 }), 0.5), 'none', 'a turn without tool calls ends the run anyway');
});

test('a smaller size (compaction) becomes the new base instead of counting as growth', () => {
  const tracker = createTracker();
  tracker.turnEnd(turn(80_000), 0.5);
  assert.equal(tracker.turnEnd(turn(20_000), 0.5), 'none');
  assert.equal(tracker.turnEnd(turn(60_000), 0.5), 'none');
  assert.equal(tracker.turnEnd(turn(70_000), 0.5), 'checkpoint');
  tracker.compacted();
  assert.equal(tracker.turnEnd(turn(15_000), 0.5), 'none', 'after compaction the next known size is the base');
});

test('a text-only report that ends the run is followed by exactly one continuation; an anchor call or further work needs none', () => {
  const textRun = createTracker();
  textRun.turnEnd(turn(10_000), 0.5); textRun.turnEnd(turn(70_000), 0.5);
  textRun.turnEnd(turn(71_000, { hasText: true, toolCalls: 0 }), 0.5);
  assert.equal(textRun.shouldContinue(), true);
  assert.equal(textRun.shouldContinue(), false, 'one continuation per report');

  const anchor = createTracker();
  anchor.turnEnd(turn(10_000), 0.5); anchor.turnEnd(turn(70_000), 0.5);
  anchor.turnEnd(turn(71_000, { anchored: true, toolCalls: 0 }), 0.5);
  assert.equal(anchor.shouldContinue(), false, 'the tool result already returns to the model');

  const working = createTracker();
  working.turnEnd(turn(10_000), 0.5); working.turnEnd(turn(70_000), 0.5);
  working.turnEnd(turn(71_000, { hasText: true, toolCalls: 2 }), 0.5);
  assert.equal(working.shouldContinue(), false, 'the report came with more tool calls');

  const unrequested = createTracker();
  unrequested.turnEnd(turn(10_000, { hasText: true, toolCalls: 0 }), 0.5);
  assert.equal(unrequested.shouldContinue(), false, 'an ordinary final answer is never continued');
});

// ------------------------------------------------------------------------------------------------------------ deadline trigger
// Pi compacts above THRESHOLD = window - reserve; the deadline zone is the last 12% of the window before it. The interval ratio is
// 1 in these tests, so the interval trigger (growth of a full window) never fires and only the deadline can.
const THRESHOLD = W - 16_384;
const ZONE = THRESHOLD - DEADLINE_MARGIN_RATIO * W;
const dl = (tokens: number | null, over: Partial<TurnFacts> = {}): TurnFacts => turn(tokens, { threshold: THRESHOLD, ...over });

test('the deadline asks once the size enters the last stretch before Pi compacts, and only then', () => {
  const tracker = createTracker();
  assert.equal(tracker.turnEnd(dl(10_000), 1), 'none');
  assert.equal(tracker.turnEnd(dl(ZONE - 1), 1), 'none', 'just before the zone');
  assert.equal(tracker.turnEnd(dl(ZONE), 1), 'checkpoint', 'the first turn in the zone');
  assert.equal(tracker.turnEnd(dl(ZONE + 1000), 1), 'none', 'an unanswered request does not repeat');
});

test('the deadline never asks when Pi would compact before the model could answer, or when the threshold is unknown', () => {
  const late = createTracker();
  late.turnEnd(dl(10_000), 1);
  assert.equal(late.turnEnd(dl(THRESHOLD - REQUEST_TOKENS + 1), 1), 'none', 'the request itself would push the estimate over the threshold');
  assert.equal(late.turnEnd(dl(THRESHOLD + 2000), 1), 'none', 'already over the threshold');
  const edge = createTracker();
  edge.turnEnd(dl(10_000), 1);
  assert.equal(edge.turnEnd(dl(THRESHOLD - REQUEST_TOKENS), 1), 'checkpoint', 'the request still fits exactly');
  for (const threshold of [null, undefined]) {
    const unknown = createTracker();
    unknown.turnEnd(turn(10_000, { threshold }), 1);
    assert.equal(unknown.turnEnd(turn(ZONE + 100, { threshold }), 1), 'none', `threshold ${threshold}`);
  }
  const ending = createTracker();
  ending.turnEnd(dl(10_000), 1);
  assert.equal(ending.turnEnd(dl(ZONE + 100, { toolCalls: 0 }), 1), 'none', 'a turn without tool calls ends the run anyway');
  assert.equal(createTracker().turnEnd(dl(null), 1), 'none', 'an unknown size');
});

test('a report from the last stretch makes another one unnecessary; an older report, or ordinary text, does not', () => {
  const fresh = createTracker();
  fresh.turnEnd(dl(10_000), 1);
  assert.equal(fresh.turnEnd(dl(ZONE + 500, { anchored: true }), 1), 'none');
  assert.equal(fresh.turnEnd(dl(ZONE + 3000), 1), 'none', 'the anchor inside the zone is the savepoint');

  const stale = createTracker();
  stale.turnEnd(dl(10_000), 1);
  assert.equal(stale.turnEnd(dl(ZONE - 5000, { anchored: true }), 1), 'none');
  assert.equal(stale.turnEnd(dl(ZONE + 100), 1), 'checkpoint', 'the last report is older than the zone');

  const chatty = createTracker();
  chatty.turnEnd(dl(10_000), 1);
  assert.equal(chatty.turnEnd(dl(ZONE - 1000, { hasText: true }), 1), 'none');
  assert.equal(chatty.turnEnd(dl(ZONE + 100), 1), 'checkpoint', 'text before the zone is no savepoint');

  const inside = createTracker();
  inside.turnEnd(dl(10_000), 1);
  assert.equal(inside.turnEnd(dl(ZONE + 100, { hasText: true }), 1), 'none', 'a turn with text is not asked');
  assert.equal(inside.turnEnd(dl(ZONE + 400), 1), 'checkpoint', 'ordinary text inside the zone is not a savepoint either');
});

test('text that answers a request counts as the savepoint', () => {
  const tracker = createTracker();
  tracker.turnEnd(dl(10_000), 1);
  assert.equal(tracker.turnEnd(dl(ZONE + 100), 1), 'checkpoint');
  assert.equal(tracker.turnEnd(dl(ZONE + 900, { hasText: true }), 1), 'none', 'the answer');
  assert.equal(tracker.turnEnd(dl(ZONE + 4000), 1), 'none', 'answered, so nothing more is asked in this stretch');
});

test('a compaction starts a new cycle: the report no longer counts, and an unanswered request does not block the next one', () => {
  const answered = createTracker();
  answered.turnEnd(dl(10_000), 1);
  assert.equal(answered.turnEnd(dl(ZONE + 100, { anchored: true }), 1), 'none');
  answered.compacted();
  assert.equal(answered.turnEnd(dl(null), 1), 'none');
  assert.equal(answered.turnEnd(dl(30_000), 1), 'none');
  assert.equal(answered.turnEnd(dl(ZONE + 100), 1), 'checkpoint', 'the next cycle asks again');

  const ignored = createTracker();
  ignored.turnEnd(dl(10_000), 1);
  assert.equal(ignored.turnEnd(dl(ZONE + 100), 1), 'checkpoint');
  ignored.compacted();
  ignored.turnEnd(dl(30_000), 1);
  assert.equal(ignored.turnEnd(dl(ZONE + 100), 1), 'checkpoint', 'the model ignored the request, which must not silence the next cycle');
});

test('a new user request does not forget a report: the context did not shrink', () => {
  const tracker = createTracker();
  tracker.turnEnd(dl(10_000), 1);
  tracker.turnEnd(dl(ZONE + 100, { anchored: true }), 1);
  tracker.reset();
  tracker.turnEnd(dl(ZONE + 2000), 1);
  assert.equal(tracker.turnEnd(dl(ZONE + 4000), 1), 'none');
});

test('the interval trigger is unchanged by the deadline: it still fires on growth, with or without a threshold', () => {
  const tracker = createTracker();
  tracker.turnEnd(dl(10_000), 0.5);
  assert.equal(tracker.turnEnd(dl(60_000), 0.5), 'checkpoint', 'growth of half a window while still far from the zone');
});

// -------------------------------------------------------------------------------------------------------------------- hooks
type Handler = (event: any, ctx: any) => any;
function load(active: string[]) {
  const handlers = new Map<string, Handler>();
  registerCheckpoint({ on: (name: string, handler: Handler) => { handlers.set(name, handler); }, getActiveTools: () => active } as unknown as ExtensionAPI);
  return handlers;
}
function withAgentDir<T>(file: string | undefined, run: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'auto-compact-cp-')), previous = process.env.PI_CODING_AGENT_DIR;
  if (file !== undefined) writeFileSync(join(dir, 'auto-compact.json'), file);
  process.env.PI_CODING_AGENT_DIR = dir;
  try { return run(); }
  finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(dir, { recursive: true, force: true }); }
}
const MODEL = { provider: 'p', id: 'm', contextWindow: W };
function loadWithSettings(settings: unknown, active: string[] = ['bash']) {
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

test('the turn boundary appends a checkpoint message and asks to continue; the anchor wording appears only when the anchor tool is active', () => withAgentDir(undefined, () => {
  for (const [active, anchorWording] of [[[ANCHOR_TOOL, 'bash'], true], [['bash'], false]] as const) {
    const handlers = load([...active]);
    handlers.get('session_start')!({}, {});
    assert.equal(endTurn(handlers, 10_000, assistant(call('bash'))), undefined);
    const out = endTurn(handlers, 70_000, assistant(call('bash')));
    assert.equal(out.continue, true);
    assert.equal(out.entries.length, 1);
    assert.equal(out.entries[0].type, 'custom_message'); assert.equal(out.entries[0].customType, CHECKPOINT_TYPE); assert.equal(out.entries[0].display, false);
    assert.equal(String(out.entries[0].content).includes(ANCHOR_TOOL), anchorWording);
  }
}));

test('a text report that ends the run gets one continuation message at the settle boundary; an anchor report does not', () => withAgentDir(undefined, () => {
  const textual = load(['bash']);
  textual.get('session_start')!({}, {});
  endTurn(textual, 10_000, assistant(call('bash'))); endTurn(textual, 70_000, assistant(call('bash')));
  endTurn(textual, 71_000, assistant(text('Done so far: A. Next: B.')));
  const settle = textual.get('agent_before_settle')!({ entries: [] }, ctx(71_000));
  assert.equal(settle.continue, true); assert.equal(settle.entries[0].customType, CONTINUE_TYPE);
  assert.equal(textual.get('agent_before_settle')!({ entries: [] }, ctx(71_000)), undefined);

  const anchored = load([ANCHOR_TOOL]);
  anchored.get('session_start')!({}, {});
  endTurn(anchored, 10_000, assistant(call('bash'))); endTurn(anchored, 70_000, assistant(call('bash')));
  endTurn(anchored, 71_000, assistant(call(ANCHOR_TOOL)));
  assert.equal(anchored.get('agent_before_settle')!({ entries: [] }, ctx(71_000)), undefined);
}));

test('a new user request resets the count, and an invalid settings file turns the checkpoint off without a message', () => {
  withAgentDir(undefined, () => {
    const handlers = load(['bash']);
    handlers.get('session_start')!({}, {});
    endTurn(handlers, 10_000, assistant(call('bash')));
    handlers.get('before_agent_start')!({ messageType: 'user' }, {});
    assert.equal(endTurn(handlers, 70_000, assistant(call('bash'))), undefined, '70k is the new base after the reset');
    handlers.get('before_agent_start')!({ messageType: 'custom' }, {});
    assert.equal(endTurn(handlers, 130_000, assistant(call('bash'))).continue, true, 'our own custom message does not reset');
  });
  withAgentDir('{ "checkpointRatio": 5 }', () => {
    const handlers = load(['bash']);
    handlers.get('session_start')!({}, {});
    endTurn(handlers, 10_000, assistant(call('bash')));
    assert.equal(endTurn(handlers, 99_000, assistant(call('bash'))), undefined);
  });
  withAgentDir('{ "checkpointRatio": 0.1 }', () => {
    const handlers = load(['bash']);
    handlers.get('session_start')!({}, {});
    endTurn(handlers, 10_000, assistant(call('bash')));
    assert.equal(endTurn(handlers, 21_000, assistant(call('bash'))).continue, true, 'the configured ratio applies');
  });
});

test('the hook asks shortly before Pi\'s threshold, using Pi\'s settings: reserve, per-model override, compaction off, unreadable settings', () => withAgentDir('{ "checkpointRatio": 1 }', () => {
  const run = (settings: unknown, tokens: number) => {
    const handlers = loadWithSettings(settings);
    handlers.get('session_start')!({}, {});
    endTurn(handlers, 10_000, assistant(call('bash')), MODEL);
    return endTurn(handlers, tokens, assistant(call('bash')), MODEL);
  };
  const zone = (reserve: number) => W - reserve - DEADLINE_MARGIN_RATIO * W;
  const out = run({}, zone(16_384) + 1);
  assert.equal(out.continue, true); assert.equal(out.entries[0].customType, CHECKPOINT_TYPE);
  assert.equal(run({}, zone(16_384) - 1), undefined, 'the default reserve puts the zone at about 71.6k');
  assert.equal(run({ compaction: { reserveTokens: 5000 } }, zone(16_384) + 1), undefined, 'a smaller reserve moves the zone later');
  assert.equal(run({ compaction: { reserveTokens: 5000 } }, zone(5000) + 1).continue, true);
  assert.equal(run({ compaction: { reserveTokens: 5000, modelOverrides: { 'p/m': { reserveTokens: 30_000 } } } }, zone(30_000) + 1).continue, true, 'the override of this model wins');
  assert.equal(run({ compaction: { enabled: false } }, zone(16_384) + 1), undefined, 'Pi does not compact, so there is no deadline');
  assert.equal(run({ compaction: { reserveTokens: -1 } }, zone(16_384) + 1), undefined, 'a value Pi rejects is not guessed at');
  assert.equal(run(new Error('boom'), zone(16_384) + 1), undefined, 'unreadable settings');
}));

test('the interval trigger still works when the host exposes no settings, and a deadline request is answered like any other', () => withAgentDir(undefined, () => {
  const handlers = load(['bash']);
  handlers.get('session_start')!({}, {});
  endTurn(handlers, 10_000, assistant(call('bash')));
  assert.equal(endTurn(handlers, 70_000, assistant(call('bash'))).continue, true);
}));

test('after a compaction the answered checkpoint messages leave the model context; the unanswered one and everything else stay', () => withAgentDir(undefined, () => {
  const handlers = load(['bash']);
  const custom = (customType: string) => ({ role: 'custom', customType, content: 'x', display: false });
  const messages = [{ role: 'user', content: 'q' }, assistant(call('bash')), custom(CHECKPOINT_TYPE), assistant(text('report')), custom('other'), custom(CONTINUE_TYPE), assistant(call('bash')), custom(CHECKPOINT_TYPE)];
  assert.equal(handlers.get('context')!({ messages }, ctx(1, [{ type: 'message' }])), undefined, 'without a compaction nothing is removed');
  const out = handlers.get('context')!({ messages }, ctx(1, [{ type: 'compaction' }]));
  assert.deepEqual(out.messages.map((m: { role: string; customType?: string }) => m.customType ?? m.role), ['user', 'assistant', 'assistant', 'other', 'assistant', CHECKPOINT_TYPE]);
}));

// -------------------------------------------------------------------------------------------------------------------- compaction
let seq = 0;
const entry = (message: Record<string, unknown>): Entry => ({ type: 'message', id: `e${++seq}`, parentId: null, timestamp: 't', message });
const asAssistant = (...blocks: unknown[]) => entry({ role: 'assistant', content: blocks });
const result = (id: string, name: string, value: string) => entry({ role: 'toolResult', toolCallId: id, toolName: name, content: [text(value)], isError: false });
const userEntry = (value: string) => entry({ role: 'user', content: [text(value)] });
const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({ type: 'toolCall', id, name, arguments: args });

test('an anchor call is an assistant message for the summary: its report is text, and neither the call nor its result is listed', () => {
  const entries = [userEntry('go'), asAssistant(toolCall('a1', 'bash', { command: 'ls' })), result('a1', 'bash', 'ok'),
    asAssistant(text('checking'), toolCall('p1', ANCHOR_TOOL, { summary: 'Parser done, tests next.' })), result('p1', ANCHOR_TOOL, 'Progress recorded. Continue the task.'),
    { type: 'custom_message', id: 'c1', customType: CHECKPOINT_TYPE, content: 'ignore me', display: false } as Entry];
  const items = buildItems(entries, () => undefined);
  assert.deepEqual(items.map(item => item.kind), ['user', 'assistant', 'assistant']);
  assert.equal(items[2]!.text, 'checking\nParser done, tests next.');
  assert.deepEqual(items[2]!.calls, []);
  assert.ok(!items.some(item => item.kind === 'orphan' || item.kind === 'note'), 'no orphan result, no checkpoint note');
});

test('the L1 ceiling is pure budget: an anchor or text point never pulls the cut later than the earliest cut point that fits', () => {
  const big = (id: string) => asAssistant(toolCall(id, 'bash', { command: 'x'.repeat(100) }));
  const entries = [userEntry('go'), big('b1'), result('b1', 'bash', 'r'.repeat(100)), big('b2'), result('b2', 'bash', 'r'.repeat(100)), asAssistant(toolCall('p', ANCHOR_TOOL, { summary: 'report' })), result('p', ANCHOR_TOOL, 'recorded'), big('b3'), result('b3', 'bash', 'r'.repeat(100))];
  const sizeFrom = (i: number) => entries.slice(i).reduce((n, e) => n + keptChars(e), 0);
  assert.equal(limitKept(entries, 0, sizeFrom(3) + 1), 3, 'the bare tool call at index 3 fits and is the cut, although the anchor at 5 is a savepoint');
  const bare = entries.map((e, i) => (i === 5 ? big('p') : e));
  assert.equal(limitKept(bare, 0, bare.slice(3).reduce((n, e) => n + keptChars(e), 0) + 1), 3, 'without any savepoint the result is the same');
});

test('the anchor tool is active by default, takes one required report, validates it and answers with a short fixed text', async () => {
  assert.equal(progressCheckpointTool.name, ANCHOR_TOOL);
  assert.equal((progressCheckpointTool as { defaultActive?: boolean }).defaultActive, true);
  const schema = progressCheckpointTool.parameters as { required?: string[]; additionalProperties?: boolean };
  assert.deepEqual(schema.required, ['summary']); assert.equal(schema.additionalProperties, false);
  const out = await progressCheckpointTool.execute('t', { summary: 'x' } as never, undefined, undefined, {} as never);
  assert.match(String((out.content[0] as { text: string }).text), /Continue the task/);
  assert.equal(typeof progressCheckpointTool.renderCall, 'function'); assert.equal(typeof progressCheckpointTool.renderResult, 'function');
});
