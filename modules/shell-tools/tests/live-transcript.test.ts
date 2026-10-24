import assert from 'node:assert/strict';
import test from 'node:test';
import { stripVTControlCharacters as plain } from 'node:util';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { JobsOverlay, panelSignature, type PanelJob } from '../src/job-view.js';
import { LiveTranscript, safeOutputText, OutputTranscript, TranscriptView } from '../src/live-transcript.js';

initTheme('dark', false);
const theme: any = { fg: (_: string, s: string) => s, getBgAnsi: () => '', bg: (_: string, s: string) => s };
const tui: any = { terminal: { rows: 40 }, requestRender() {} };
const assistant = (content: unknown[], extra: object = {}) => ({ role: 'assistant', content, stopReason: 'toolUse', ...extra });
const feed = (t: LiveTranscript) => {
  t.ingest({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'please list files' }] } });
  t.ingest({ type: 'message_start', message: assistant([]) });
  t.ingest({ type: 'message_update', message: assistant([{ type: 'text', text: 'Looking now' }]) });
  t.ingest({ type: 'message_end', message: assistant([{ type: 'text', text: 'Looking now' }, { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } }]) });
  t.ingest({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } });
  t.ingest({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: 'a.txt' }] } });
};

test('events become one conversation: streaming assistant message is replaced in place, never duplicated', () => {
  const t = new LiveTranscript(); feed(t);
  const { items, tools } = t.snapshot();
  assert.deepEqual(items.map(i => i.kind), ['user', 'assistant']);
  assert.equal((items[1] as any).streaming, false);
  assert.equal(tools.get('c1')?.result?.isError, false);
});

test('view renders with the host message components (user, assistant text, tool call and result)', () => {
  const t = new LiveTranscript(); feed(t);
  const text = plain(new TranscriptView(t, tui, process.cwd()).render(80).join('\n'));
  assert.match(text, /please list files/); assert.match(text, /Looking now/); assert.match(text, /ls/); assert.match(text, /a\.txt/);
});

test('release drops the copy, notifies once, and later events are ignored', () => {
  const t = new LiveTranscript(); let calls = 0; t.subscribe(() => calls++); feed(t);
  const before = calls; t.release();
  assert.equal(calls, before + 1); assert.equal(t.isReleased, true); assert.equal(t.snapshot().items.length, 0);
  t.ingest({ type: 'message_start', message: assistant([]) });
  assert.equal(t.snapshot().items.length, 0); assert.equal(calls, before + 1);
  assert.equal(t.subscribe(() => calls++)(), undefined); // subscribing after release is inert
});

test('observer or malformed input never throws into the caller', () => {
  const t = new LiveTranscript(); t.subscribe(() => { throw new Error('boom'); });
  assert.doesNotThrow(() => { t.ingest(null); t.ingest({ type: 'message_start' }); feed(t); });
});

test('overlay detail shows the live conversation, m toggles metadata, and falls back after release', () => {
  const transcript = new LiveTranscript(); feed(transcript);
  const job: PanelJob = { kind: 'fork', jobId: 'F1', label: 'fork', title: 't', state: 'running', active: true, activity: 'running', usageState: 'pending', details: ['Metadata line'], transcripts: [{ label: 'fork', transcript }] };
  let renders = 0;
  const overlay = new JobsOverlay(() => [job], theme, () => renders++, () => {}, () => 30, tui, process.cwd());
  overlay.render(100); overlay.handleInput('\r');
  let text = plain(overlay.render(100).join('\n'));
  assert.match(text, /please list files/); assert.match(text, /Live conversation/); assert.doesNotMatch(text, /Metadata line/);
  overlay.handleInput('m'); text = plain(overlay.render(100).join('\n'));
  assert.match(text, /Metadata line/); assert.doesNotMatch(text, /please list files/);
  overlay.handleInput('m'); transcript.release();
  assert.ok(renders > 0, 'release refreshes the open overlay');
  text = plain(overlay.render(100).join('\n'));
  assert.match(text, /Metadata line/); assert.doesNotMatch(text, /Live conversation/);
  overlay.dispose();
});

test('subagent registry: task events build a live copy, and finish/run end release it', async () => {
  const { BackgroundJobs } = await import('../../subagents/extensions/subagent/background.ts');
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), pending = new Promise<void>(resolve => { release = resolve; });
  const jobs = new BackgroundJobs(() => {});
  let copy: LiveTranscript | undefined;
  try {
    jobs.submit('owner', '/cwd', jobs.epoch, ['worker'], async (_signal, _ids, live, finish, _attach, _interaction, _progress, events) => {
      live(0, 'session', '/live.partial');
      events(0, { type: 'message_start', message: { role: 'user', content: 'do it' } });
      enter(); await pending;
      finish(0, { status: 'completed' }, 'completed');
    }, ['title']);
    await entered;
    const [panel] = jobs.panelJobs('owner', '/cwd');
    const copySource = panel.transcripts?.[0]?.transcript;
    if (!copySource || copySource.mode !== 'conversation') throw new Error('a subagent task copy is a conversation, not an output tail');
    copy = copySource;
    assert.ok(!copy.isReleased); assert.equal(copy.snapshot().items.length, 1);
    release();
    await jobs.shutdown();
    assert.equal(copy.isReleased, true, 'copy is released once the task is terminal');
  } finally { release(); await jobs.shutdown(); }
});

test('shell output copy keeps only the bounded tail and drops everything on release', () => {
  const out = new OutputTranscript(32);
  let calls = 0; out.subscribe(() => calls++);
  out.append(Buffer.from('first chunk '));
  out.append(Buffer.from('second chunk longer than the retained cap'));
  const snap = out.snapshot();
  assert.equal(snap.truncated, true);
  assert.ok(Buffer.byteLength(snap.text) <= 32);
  assert.match(snap.text, /cap$/);
  assert.ok(calls >= 2, 'each append notifies subscribers');
  out.release();
  assert.equal(out.isReleased, true); assert.equal(out.snapshot().text, '');
  out.append(Buffer.from('late'));
  assert.equal(out.snapshot().text, '');
  assert.equal(out.subscribe(() => calls++)(), undefined);
});

test('shell output view renders plain text and strips terminal controls', () => {
  const out = new OutputTranscript();
  out.append(Buffer.from('\u001b[31mred line\u001b[0m\nsecond\n'));
  const raw = new TranscriptView(out, tui, process.cwd()).render(80).join('\n');
  assert.doesNotMatch(raw, /\u001b\[31m/);
  assert.match(plain(raw), /red line/); assert.match(plain(raw), /second/);
});

test('shell job detail shows the live output copy and falls back to metadata once released', () => {
  const out = new OutputTranscript(); out.append(Buffer.from('building target\n'));
  const job: PanelJob = { kind: 'shell', jobId: 'SH1', label: 'bash', title: 'make', state: 'running', active: true, activity: 'Running', usageState: 'na', details: ['Command preview: make'], transcripts: [{ label: 'output', transcript: out }] };
  const overlay = new JobsOverlay(() => [job], theme, () => {}, () => {}, () => 30, tui, process.cwd());
  overlay.render(100); overlay.handleInput('\r');
  let text = plain(overlay.render(100).join('\n'));
  assert.match(text, /building target/); assert.match(text, /Live output/); assert.match(text, /Ctrl\+O Expand/);
  out.release();
  text = plain(overlay.render(100).join('\n'));
  assert.match(text, /Command preview/); assert.doesNotMatch(text, /Live output/);
  overlay.dispose();
});

test('Ctrl+O expands tool results inside the live view and collapses them again', () => {
  const transcript = new LiveTranscript();
  transcript.ingest({ type: 'message_start', message: assistant([]) });
  transcript.ingest({ type: 'message_end', message: assistant([{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'seq 1 20' } }]) });
  transcript.ingest({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: Array.from({ length: 20 }, (_, i) => `result line ${i + 1}`).join('\n') }] } });
  const job: PanelJob = { kind: 'fork', jobId: 'F2', label: 'fork', title: 't', state: 'running', active: true, activity: 'running', usageState: 'pending', details: ['Metadata line'], transcripts: [{ label: 'fork', transcript }] };
  const overlay = new JobsOverlay(() => [job], theme, () => {}, () => {}, () => 40, tui, process.cwd());
  overlay.render(120); overlay.handleInput('\r');
  let text = plain(overlay.render(120).join('\n'));
  assert.match(text, /tokens|result line 1/);
  assert.match(text, /more lines, Ctrl\+O to expand/); assert.doesNotMatch(text, /result line 20/);
  overlay.handleInput('\u000f'); // Ctrl+O, the host's "Toggle tool output" key
  text = plain(overlay.render(120).join('\n'));
  assert.match(text, /result line 20/); assert.doesNotMatch(text, /to expand/);
  overlay.handleInput('\u000f');
  text = plain(overlay.render(120).join('\n'));
  assert.match(text, /more lines, Ctrl\+O to expand/); assert.doesNotMatch(text, /result line 20/);
  overlay.dispose();
});

test('panel signature tracks live copies by version, never by payload', () => {
  const out = new OutputTranscript();
  const job: PanelJob = { kind: 'shell', jobId: 'SH2', label: 'bash', title: 'make', state: 'running', active: true, activity: 'Running', usageState: 'na', details: [], transcripts: [{ label: 'output', transcript: out }] };
  const before = panelSignature([job]);
  out.append(Buffer.from('more output'));
  assert.notEqual(panelSignature([job]), before);
  assert.doesNotMatch(panelSignature([job]), /Buffer|more output/);
});

test('overlay: m does nothing without a live view, footer has no empty segment, selecting another job resets metadata mode', () => {
  const transcript = new LiveTranscript(); feed(transcript);
  const plainJob: PanelJob = { kind: 'shell', jobId: 'S1', label: 'bash', title: 'a', state: 'completed', active: false, activity: 'done', usageState: 'na', details: ['Plain detail'] };
  const liveJob: PanelJob = { kind: 'fork', jobId: 'F2', label: 'fork', title: 'b', state: 'running', active: true, activity: 'running', usageState: 'pending', details: ['Live meta'], transcripts: [{ label: 'fork', transcript }] };
  const overlay = new JobsOverlay(() => [liveJob, plainJob], theme, () => {}, () => {}, () => 30, tui, process.cwd());
  overlay.render(100); overlay.handleInput('\x1b[B'); overlay.render(100); overlay.handleInput('\r');
  let text = plain(overlay.render(100).join('\n'));
  assert.match(text, /Plain detail/); assert.doesNotMatch(text, /·\s+·/);
  overlay.handleInput('m'); text = plain(overlay.render(100).join('\n'));
  assert.doesNotMatch(text, /Conversation\/Metadata/, 'm on a job without a live view must not flip hidden state');
  overlay.handleInput('\x1b'); overlay.render(100); overlay.handleInput('\x1b[A'); overlay.render(100); overlay.handleInput('\r');
  assert.match(plain(overlay.render(100).join('\n')), /please list files/, 'a later live job starts in conversation mode');
  overlay.dispose();
});

test('subagent registry: shutdown releases live copies even if the runner never settles', async () => {
  const { BackgroundJobs } = await import('../../subagents/extensions/subagent/background.ts');
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const jobs = new BackgroundJobs(() => {});
  jobs.submit('owner', '/cwd', jobs.epoch, ['worker'], async (_s, _i, live, _f, _a, _x, _p, events) => {
    live(0, 'session', '/live.partial'); events(0, { type: 'message_start', message: { role: 'user', content: 'x' } }); enter();
    await new Promise<void>(() => {});
  }, ['t']);
  await entered;
  const copy = jobs.panelJobs('owner', '/cwd')[0]!.transcripts![0]!.transcript;
  assert.equal(copy.isReleased, false);
  await jobs.shutdown(50);
  assert.equal(copy.isReleased, true);
});

test('shell output view neutralises cursor-moving controls and bidi overrides while keeping line structure', () => {
  const out = new OutputTranscript();
  out.append(Buffer.from('safe line\rFORGED\u0007\b\nbidi \u202egnirts\u2066 end\u061c\u200f\ttab\r\nlast\n'));
  const text = plain(new TranscriptView(out, tui, process.cwd()).render(80).join('\n'));
  assert.doesNotMatch(text, /[\r\u0007\b\u202e\u2066\u061c\u200f]/);
  assert.match(text, /safe line\s*\n?\s*FORGED/); assert.match(text, /last/);
  assert.equal(safeOutputText('a\rb\r\nc'), 'a\nb\nc');
});

test('overlay: replacing the live transcript of the same job rebuilds the view instead of throwing', () => {
  const first = new LiveTranscript(), second = new LiveTranscript();
  first.ingest({ type: 'message_start', message: { role: 'user', content: 'from task one' } });
  second.ingest({ type: 'message_start', message: { role: 'user', content: 'from task two' } });
  let current = first;
  const job = (): PanelJob => ({ kind: 'subagents', jobId: 'B1', label: 'batch', title: 't', state: 'running', active: true, activity: 'running', usageState: 'pending', details: [], transcripts: [{ label: 'task', transcript: current }] });
  const overlay = new JobsOverlay(() => [job()], theme, () => {}, () => {}, () => 30, tui, process.cwd());
  overlay.render(100); overlay.handleInput('\r');
  assert.match(plain(overlay.render(100).join('\n')), /from task one/);
  first.release(); current = second;
  let text = '';
  assert.doesNotThrow(() => { text = plain(overlay.render(100).join('\n')); });
  assert.match(text, /from task two/); assert.doesNotMatch(text, /from task one/);
  overlay.dispose();
});

test('subagent registry: creating the first live copy notifies the panel so the open view can switch from metadata', async () => {
  const { BackgroundJobs } = await import('../../subagents/extensions/subagent/background.ts');
  let enter!: () => void, release!: () => void, emitted!: () => void, hold!: () => void, changes = 0;
  const entered = new Promise<void>(resolve => { enter = resolve; }), pending = new Promise<void>(resolve => { release = resolve; });
  const afterEvents = new Promise<void>(resolve => { emitted = resolve; }), held = new Promise<void>(resolve => { hold = resolve; });
  const jobs = new BackgroundJobs(() => {}, undefined, () => { changes++; });
  try {
    jobs.submit('owner', '/cwd', jobs.epoch, ['worker'], async (_s, _i, live, _f, _a, _x, _p, events) => {
      live(0, 'session', '/live.partial'); enter(); await pending;
      events(0, { type: 'message_start', message: { role: 'user', content: 'x' } });
      events(0, { type: 'message_start', message: { role: 'assistant', content: [] } });
      emitted(); await held;
    }, ['t']);
    await entered;
    assert.equal(jobs.panelJobs('owner', '/cwd')[0]!.transcripts, undefined);
    const before = changes;
    release(); await afterEvents;
    assert.equal(jobs.panelJobs('owner', '/cwd')[0]!.transcripts?.length, 1);
    assert.equal(changes, before + 1, 'exactly one panel notification, at creation of the copy (not per event)');
  } finally { release(); hold(); await jobs.shutdown(50); }
});

test('opening a live view from the list replaces the list: Esc closes the overlay; metadata-only details still go back', () => {
  const transcript = new LiveTranscript(); feed(transcript);
  const live: PanelJob = { kind: 'fork', jobId: 'F3', label: 'fork', title: 'a', state: 'running', active: true, activity: 'running', usageState: 'pending', details: ['Live meta'], transcripts: [{ label: 'fork', transcript }] };
  const finished: PanelJob = { kind: 'shell', jobId: 'S3', label: 'bash', title: 'b', state: 'completed', active: false, activity: 'done', usageState: 'na', details: ['Finished meta'] };
  let closed = 0;
  const overlay = new JobsOverlay(() => [live, finished], theme, () => {}, () => { closed++; }, () => 30, tui, process.cwd());
  overlay.render(100); overlay.handleInput('\r');
  assert.match(plain(overlay.render(100).join('\n')), /Esc Close/);
  overlay.handleInput('m'); overlay.render(100);
  overlay.handleInput('\x1b');
  assert.equal(closed, 1, 'Esc in a running job detail closes the whole overlay, even while showing metadata');
  const second = new JobsOverlay(() => [live, finished], theme, () => {}, () => { closed++; }, () => 30, tui, process.cwd());
  second.render(100); second.handleInput('\x1b[B'); second.render(100); second.handleInput('\r');
  assert.match(plain(second.render(100).join('\n')), /Finished meta/);
  second.handleInput('\x1b');
  assert.equal(closed, 1, 'finished job detail goes back to the list instead of closing');
  assert.match(plain(second.render(100).join('\n')), /Active \/ Recent finished/);
  overlay.dispose(); second.dispose();
});
