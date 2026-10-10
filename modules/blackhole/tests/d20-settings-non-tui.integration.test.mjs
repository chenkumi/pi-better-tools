// D20: "/blackhole settings" must never hang. Real AgentSession + real extension runner + real Blackhole command.
// - Non-TUI (RPC/json/print): ctx.ui.custom must not be opened; the command returns supported text.
//   The RPC custom() stub copies Pi 1.1.0 modes/rpc/rpc-mode.js (`async custom() { return undefined; }`, factory never runs).
// - TUI with a custom() that resolves undefined without running the factory, or rejects, must also settle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHost, log, withLimit } from './fixtures/real-host.mjs';

async function run(mode, custom) {
  const host = await makeHost();
  try {
    assert.deepEqual(host.loadErrors(), []);
    const notes = [];
    let customCalls = 0;
    const uiContext = {
      notify: (message, type) => notes.push({ message, type }),
      select: async () => undefined, confirm: async () => false, input: async () => undefined,
      setStatus() {}, setWidget() {}, setWorkingMessage() {}, setTitle() {}, setEditorText() {}, setFooter() {}, setHeader() {},
      onTerminalInput: () => () => {},
      async custom(factory) { customCalls++; return custom(factory); },
    };
    await host.session.bindExtensions({ uiContext, mode, onError: e => notes.push({ message: `ERR ${e.error}`, type: 'error' }) });
    log(`D20 running /blackhole settings (mode=${mode}, limit 15000ms)`);
    await withLimit(host.session.prompt('/blackhole settings'), 15000, '/blackhole settings');
    return { notes, customCalls };
  } finally { await host.cleanup(); }
}

for (const mode of ['rpc', 'json', 'print']) {
  test(`D20 /blackhole settings in ${mode} does not open custom UI and returns supported text`, async () => {
    const { notes, customCalls } = await run(mode, async () => undefined);
    assert.equal(customCalls, 0, 'ctx.ui.custom must not be called outside the TUI');
    const text = notes.map(n => n.message).join('\n');
    assert.match(text, /only available in the TUI/);
    assert.match(text, /\/blackhole om-off/);
  });
}

test('D20 TUI: custom() resolving undefined without running the factory settles (no forever-pending)', async () => {
  const { customCalls } = await run('tui', async () => undefined);
  assert.ok(customCalls >= 1, 'validity: TUI mode must reach ctx.ui.custom');
});

test('D20 TUI: custom() rejection settles and is reported', async () => {
  const { notes, customCalls } = await run('tui', async () => { throw new Error('custom exploded'); });
  assert.ok(customCalls >= 1);
  assert.ok(notes.some(n => n.type === 'error' && /custom exploded/.test(n.message)), JSON.stringify(notes));
});
