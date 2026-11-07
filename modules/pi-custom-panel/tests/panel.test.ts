import assert from 'node:assert/strict';
import test from 'node:test';
import { stripVTControlCharacters as plain } from 'node:util';
import { visibleWidth } from '@earendil-works/pi-tui';
import { PanelEditor, PROMPT } from '../src/editor.ts';
import { contextSegment, formatCwd, renderFooter, type FooterModel } from '../src/footer.ts';
import { formatTokens, sumUsage } from '../src/usage.ts';
import panel from '../src/index.ts';
import { closeBottomPanel, openBottomPanel } from '../../../shared/src/bottom-panel/index.ts';

const paint = (_color: string, text: string) => text;
const usage = (input: number, output: number, cacheRead: number, cost: number) => ({ input, output, cacheRead, cacheWrite: 0, cost: { total: cost } });
const model = (extra: Partial<FooterModel> = {}): FooterModel => ({
  cwd: 'C:\\work\\proj', branch: 'main', modelId: 'deepseek-v4.1-flash', reasoning: true, thinkingLevel: 'high', contextPercent: 12.5, contextWindow: 272000, contextTokens: 34000,
  autoCompact: true, entries: [], statuses: new Map(), ...extra,
});

test('usage totals follow the host footer: every entry kind, latest cache hit rate, bad values ignored', () => {
  const totals = sumUsage([
    { type: 'message', message: { role: 'assistant', usage: usage(100, 10, 300, 0.01) } },
    { type: 'message', message: { role: 'assistant', usage: usage(50, 5, 150, 0.02) } },
    { type: 'message', message: { role: 'toolResult', usage: usage(1, 1, 0, 0.001) } },
    { type: 'usage', usage: usage(2, 2, 0, 0) }, { type: 'compaction', usage: usage(3, 3, 0, 0) }, { type: 'message', message: { role: 'user' } },
    null, 'x', { type: 'message', message: { role: 'assistant', usage: { input: 'NaN', cost: 5 } } },
  ]);
  assert.deepEqual([totals.input, totals.output, totals.cacheRead], [156, 21, 450]);
  assert.ok(Math.abs(totals.cost - 0.031) < 1e-9);
  assert.equal(totals.cacheHitRate, undefined, 'the last assistant entry has no prompt tokens');
  assert.equal(sumUsage([{ type: 'message', message: { role: 'assistant', usage: usage(100, 1, 300, 0) } }]).cacheHitRate, 75);
  assert.deepEqual([formatTokens(999), formatTokens(1500), formatTokens(35000), formatTokens(2_500_000)], ['999', '1.5k', '35k', '2.5M']);
});

test('footer: location and context bar on row one, model and usage on row two, speed label placed by the footer', () => {
  const entries = [{ type: 'message', message: { role: 'assistant', usage: usage(35000, 8900, 255000, 0.011) } }];
  const lines = renderFooter(model({ provider: 'opencode-go', entries, home: 'C:\\work', statuses: new Map([['gpt-speed', '\x1b[36mSpeed: Fast\x1b[0m']]) }), 130, paint).map(plain);
  assert.equal(lines.length, 2);
  assert.ok(lines.every(line => visibleWidth(line) === 130), 'both rows fill the full width, as in the design');
  assert.match(lines[0]!, /^\uf07c {2}~\\proj · main +\uf0c9 {2}\[▓▓░░░░░░░░░░\] 12\.5% 34k\/272k \(auto\)$/);
  assert.match(lines[1]!, /^\uf121 {2}opencode-go · deepseek-v4\.1-flash · \uf0eb {2}high +\uf1e6 {2}Fast \| \uf093 {2}35k \| \uf019 {2}8\.9k \| \u{1f5f2} 87\.9% \| \$ 0\.011$/u);
});

test('footer: no speed label means no separator; other statuses go to their own row; narrow widths never overflow', () => {
  const lines = renderFooter(model({ statuses: new Map([['b', 'second'], ['a', 'first\nline']]) }), 80, paint).map(plain);
  assert.equal(lines.length, 3);
  assert.match(lines[1]!, / \uf093 {2}0 \| \uf019 {2}0 \| \$ 0\.000$/, 'a fresh session still shows zero usage');
  assert.doesNotMatch(lines[1]!, /\| \uf093/, 'no speed label, no leading separator');
  assert.equal(lines[2], 'first line second');
  for (const width of [10, 24, 40]) for (const line of renderFooter(model({ entries: [{ type: 'usage', usage: usage(1e6, 1e6, 0, 9) }] }), width, paint)) assert.ok(visibleWidth(line) <= width, `${width}: ${plain(line)}`);
});

test('footer: context bar colours show urgency; unknown usage after compaction; auto-compact off', () => {
  const used = (percent: number | null, truecolor = false) => {
    const colours: string[] = [], text = (color: string, value: string) => { colours.push(color); return value; };
    const out = contextSegment(model({ contextPercent: percent }), text, truecolor);
    return { colours, out };
  };
  // Theme colours stand in for the gradient without truecolor: the filled cells step green, yellow, red.
  const low = used(10), mid = used(71), high = used(95);
  assert.ok(!low.colours.includes('warning') && !low.colours.includes('error'));
  assert.ok(low.colours.includes('success') && !low.colours.includes('error'), 'a nearly empty bar is green only');
  assert.ok(mid.colours.includes('warning') && !mid.colours.includes('error'), 'text and icon turn warning above 70');
  assert.deepEqual(high.colours.filter(c => c === 'error').length > 0 && high.colours.includes('success') && high.colours.includes('warning'), true, 'a full bar sweeps green to red');
  // Truecolor draws a real gradient: first filled cell green-ish, last filled cell red-ish.
  const rgbs = [...used(100, true).out.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m▓/g)].map(m => m.slice(1).map(Number));
  assert.equal(rgbs.length, 12);
  assert.ok(rgbs[0]![1]! > rgbs[0]![0]! && rgbs[11]![0]! > rgbs[11]![1]!, 'green at the start, red at the end');
  assert.equal(contextSegment(model({ contextPercent: null, contextTokens: null, autoCompact: false }), paint), '\uf0c9  [░░░░░░░░░░░░] ?% ?/272k');
  assert.equal(formatCwd('C:\\other', 'C:\\work'), 'C:\\other');
});

test('footer: every text run is painted dim (one grey); only icons, the branch, the thinking level, the cache bolt and the $ sign carry colour', () => {
  const entries = [{ type: 'message', message: { role: 'assistant', usage: usage(35000, 8900, 255000, 0.011) } }];
  const painted: Array<[string, string]> = [];
  const spy = (color: string, text: string) => { painted.push([color, text]); return text; };
  renderFooter(model({ provider: 'p', entries, statuses: new Map([['gpt-speed', '\x1b[36mSpeed: Fast\x1b[0m']]) }), 130, spy);
  const textRuns = painted.filter(([, text]) => /[0-9A-Za-z$]/.test(text) && !/^[\uf000-\uf8ff]$/.test(text));
  assert.ok(textRuns.length > 8);
  for (const [color, text] of textRuns) if (!['░', '▓', '$', 'main'].includes(text) && color !== 'thinkingHigh') assert.ok(color === 'dim' || /^[\d.?]+%/.test(text), 'text "' + text + '" is ' + color);
  assert.equal(painted.find(([, text]) => text === 'main')?.[0], 'accent', 'the branch name is the main colour');
  assert.equal(painted.find(([, text]) => text === '$')?.[0], 'accent', 'the dollar sign is accent like the icons');
  assert.equal(painted.find(([, text]) => text === '\u{1f5f2}')?.[0], 'accent', 'the cache-hit bolt is accent like every icon');
  assert.equal(painted.find(([, text]) => text === '0.011')?.[0], 'dim', 'the amount stays grey');
  const icons = painted.filter(([, text]) => /^[\uf000-\uf8ff]$/.test(text));
  assert.ok(icons.length >= 6 && icons.every(([color]) => color === 'accent'));
  assert.equal(painted.find(([, text]) => text === 'Fast')?.[0], 'dim', 'the speed label is re-painted in the common grey, not its own colour');
});

test('footer: the thinking level word is painted in the level colour (the bulb stays accent like every icon)', () => {
  const painted: Array<[string, string]> = [];
  const spy = (color: string, text: string) => { painted.push([color, text]); return text; };
  for (const [level, color] of [['off', 'thinkingOff'], ['minimal', 'thinkingMinimal'], ['low', 'thinkingLow'], ['medium', 'thinkingMedium'], ['high', 'thinkingHigh'], ['xhigh', 'thinkingXhigh'], ['max', 'thinkingMax'], ['surprise', 'thinkingOff']]) {
    painted.length = 0;
    renderFooter(model({ provider: 'p', thinkingLevel: level }), 100, spy);
    const entry = painted.find(([, text]) => text === level);
    assert.equal(entry?.[0], color, level);
  }
  painted.length = 0;
  renderFooter(model({ reasoning: false }), 100, spy);
  assert.ok(!painted.some(([color]) => color.startsWith('thinking')), 'no reasoning, no thinking part');
});

test('footer: provider · model · thinking; thinking off is shown as "off"; no reasoning drops the thinking part', () => {
  assert.match(plain(renderFooter(model({ provider: 'opencode-go', thinkingLevel: 'off' }), 100, paint)[1]!), /opencode-go · deepseek-v4\.1-flash · \uf0eb {2}off/);
  assert.match(plain(renderFooter(model({ reasoning: false, provider: 'x' }), 100, paint)[1]!), /^\uf121 {2}x · deepseek-v4\.1-flash\s+\uf093 {2}0/);
});

test('editor: prompt glyph on the first text row only; borders, content and autocomplete rows are the host output', () => {
  const tui: any = { terminal: { rows: 40 }, requestRender() {} };
  const theme: any = { borderColor: (s: string) => s, selectList: { selectedPrefix: (s: string) => s, selectedText: (s: string) => s, description: (s: string) => s, scrollInfo: (s: string) => s, noMatch: (s: string) => s } };
  const editor = new PanelEditor(tui, theme, { matches: () => false, getKeys: () => [] } as any);
  editor.setPaddingX(0); // the host re-applies the user's editorPaddingX after construction
  editor.setText('hello\nworld');
  const lines = editor.render(40).map(plain);
  assert.equal(lines.length, 4);
  assert.match(lines[0]!, /^─+$/); assert.match(lines[3]!, /^─+$/);
  assert.ok(lines[1]!.startsWith(`${PROMPT}hello`), lines[1]);
  assert.ok(lines[2]!.startsWith('  world'), lines[2]);
  assert.ok(lines.every(line => visibleWidth(line) === 40));
});

test('editor keeps PgUp/PgDn away from the fullscreen viewport while a bottom panel is open', async () => {
  const tui: any = { terminal: { rows: 40 }, requestRender() {} };
  const theme: any = { borderColor: (s: string) => s, selectList: { selectedPrefix: (s: string) => s, selectedText: (s: string) => s, description: (s: string) => s, scrollInfo: (s: string) => s, noMatch: (s: string) => s } };
  const editor = new PanelEditor(tui, theme, { matches: () => false, getKeys: () => [] } as any);
  assert.equal(editor.capturesViewportInput, false);
  const ui = { setWidget() {}, onTerminalInput: () => () => {} } as any;
  const open = openBottomPanel(ui, { key: 'k', title: 't', create: () => ({ render: () => [], handleInput() {} }) });
  assert.equal(editor.capturesViewportInput, true);
  closeBottomPanel(); await open;
  assert.equal(editor.capturesViewportInput, false);
});

test('editor: border and prompt use the accent colour, whatever the host assigns; bash mode keeps the host colour', () => {
  const tui: any = { terminal: { rows: 40 }, requestRender() {} };
  const theme: any = { borderColor: (s: string) => '<host>' + s, selectList: { selectedPrefix: (s: string) => s, selectedText: (s: string) => s, description: (s: string) => s, scrollInfo: (s: string) => s, noMatch: (s: string) => s } };
  const editor = new PanelEditor(tui, theme, { matches: () => false, getKeys: () => [] } as any, {}, text => '<accent>' + text, text => '<white>' + text);
  editor.setText('hello');
  let lines = editor.render(20);
  assert.ok(lines[0]!.startsWith('<accent>─') && lines[2]!.startsWith('<accent>─'), 'top and bottom borders are accent');
  assert.ok(lines[1]!.startsWith('<white>' + PROMPT), 'the prompt glyph has its own colour');
  editor.borderColor = (s: string) => '<thinking-purple>' + s; // what the host does whenever the thinking level changes
  lines = editor.render(20);
  assert.ok(lines[0]!.startsWith('<accent>'), 'the host colour is ignored');
  editor.setText('!ls');
  lines = editor.render(20);
  assert.ok(lines[0]!.startsWith('<thinking-purple>'), 'a "!" command keeps the colour the host chose for bash mode');
  const plainEditor = new PanelEditor(tui, theme, { matches: () => false, getKeys: () => [] } as any);
  assert.ok(plainEditor.render(20)[0]!.startsWith('<host>'), 'without an accent painter the host colour is used');
});

test('extension: loading registers hooks only; tui mode installs footer and editor, shutdown restores both; other modes do nothing', () => {
  const handlers = new Map<string, (event: unknown, ctx: any) => void>();
  let toolRenderers = 0;
  panel({ on: (event: string, handler: any) => { handlers.set(event, handler); }, registerToolRenderer: () => { toolRenderers++; } } as any);
  assert.equal(toolRenderers, 1, 'one global tool renderer resolver is registered at load');
  assert.deepEqual([...handlers.keys()].sort(), ['session_shutdown', 'session_start']);
  const calls: string[] = [];
  const ui = { setFooter: (factory: unknown) => calls.push(`footer:${factory ? 'set' : 'clear'}`), setEditorComponent: (factory: unknown) => calls.push(`editor:${factory ? 'set' : 'clear'}`) };
  handlers.get('session_start')!({}, { mode: 'rpc', ui });
  handlers.get('session_shutdown')!({}, { mode: 'rpc', ui });
  assert.deepEqual(calls, []);
  handlers.get('session_start')!({}, { mode: 'tui', ui });
  handlers.get('session_shutdown')!({}, { mode: 'tui', ui });
  assert.deepEqual(calls, ['editor:set', 'footer:set', 'footer:clear', 'editor:clear']);
});

test('extension: shutdown closes a bottom panel the host dropped (reload or session switch), so panels can open again', async () => {
  const { openBottomPanel, isBottomPanelOpen } = await import('../../../shared/src/bottom-panel/index.ts');
  const handlers = new Map<string, any>();
  panel({ on: (event: string, handler: any) => { handlers.set(event, handler); }, registerToolRenderer() {} } as any);
  const widgets: unknown[] = [];
  const ui: any = { setWidget: (_key: string, content: unknown) => { widgets.push(content); }, onTerminalInput: () => () => undefined, setFooter() {}, setEditorComponent() {} };
  const result = openBottomPanel<number>(ui, { key: 'k', title: 't', create: () => ({ render: () => [], handleInput() {} }) });
  assert.ok(isBottomPanelOpen());
  handlers.get('session_shutdown')!({}, { mode: 'rpc', ui });
  assert.equal(await result, undefined);
  assert.equal(isBottomPanelOpen(), false);
});
