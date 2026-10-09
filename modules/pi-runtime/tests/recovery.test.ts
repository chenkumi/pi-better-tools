import assert from 'node:assert/strict';
import { test } from 'node:test';
import runtime from '../src/index.js';
import { classifyError, diagnostic } from '../src/policy.js';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

const error = (message: string, timestamp = 1) => ({ role: 'assistant' as const, api: 'openai-responses' as const,
  provider: 'offline-runtime', model: 'local', timestamp, stopReason: 'error' as const, errorMessage: message,
  content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
function fixture(branch: any[] = []) {
  const events = new Map<string, Function>(), commands = new Map<string, any>();
  const entries = [...branch];
  const sent: any[] = [], notices: string[] = []; let sid = 'owner', idle = true, approved = false;
  let confirm: () => Promise<boolean> = async () => approved;
  const api = { on(name: string, fn: Function) { events.set(name, fn); }, registerCommand(name: string, command: any) { commands.set(name, command); },
    appendEntry(customType: string, data: any) { const entry = { type: 'custom', id: `s${entries.length}`, customType, data: structuredClone(data) }; branch.push(entry); entries.push(entry); },
    sendMessage(message: any, options: any) { sent.push({ message, options }); },
  } as unknown as ExtensionAPI;
  const controller = new AbortController();
  const ctx = { mode: 'tui', hasUI: true, cwd: '.', model: { provider: 'offline-runtime', id: 'local' }, signal: controller.signal,
    sessionManager: { getSessionId: () => sid, getSessionFile: () => 'isolated.jsonl', getBranch: () => branch, getEntries: () => entries, getLeafId: () => branch.at(-1)?.id },
    isIdle: () => idle, ui: { notify: (s: string) => notices.push(s), confirm: () => confirm() } } as unknown as ExtensionContext;
  runtime(api);
  const emit = (name: string, event: any = {}, context = ctx) => events.get(name)?.(event, context);
  emit('session_start');
  const begin = (source = 'interactive') => {
    const text = `Prompt ${entries.length}`;
    emit('input', { source, text }); emit('before_agent_start', { prompt: text }); emit('agent_start');
    const message = { role: 'user', content: [{ type: 'text', text }] };
    const entry = { type: 'message', id: `u${entries.length}`, message }; branch.push(entry); entries.push(entry);
    emit('message_end', { message });
  };
  const fail = (message: string, id = `e${branch.length}`) => {
    const response = error(message, branch.length + 1); const entry = { type: 'message', id, message: response }; branch.push(entry); entries.push(entry);
    emit('turn_end', { message: response, messageEntryId: id }); return response;
  };
  const settle = (extra: any[] = []) => emit('agent_before_settle', { outcome: 'error', entries: extra, context: { canContinue: false } });
  return { api, ctx, branch, entries, commands, sent, notices, controller, emit, begin, fail, settle,
    owner: (s: string) => { sid = s; }, idle: (b: boolean) => { idle = b; }, approved: (b: boolean) => { approved = b; },
    confirmation: (f: () => Promise<boolean>) => { confirm = f; }, reload: () => { runtime(api); emit('session_start'); } };
}

test('conservative classifier separates repairable, policy, host retries, context and hard errors', () => {
  assert.equal(classifyError(error('invalid_request_error: invalid tool arguments')), 'repairable');
  assert.equal(classifyError(error('cyber_policy: This content was flagged for possible cybersecurity risk. 503')), 'policy');
  assert.equal(classifyError(error('429 insufficient_quota')), 'terminal');
  assert.equal(classifyError(error('401 Invalid API key')), 'terminal');
  assert.equal(classifyError(error('503 service unavailable')), 'host');
  assert.equal(classifyError(error('maximum context length exceeded')), 'host');
  assert.equal(classifyError(error('unknown unexpected error')), 'review');
  assert.equal(classifyError({ ...error('invalid_request_error'), stopReason: 'aborted' }), 'ignore');
});
test('diagnostics are bounded, redact common credentials and fingerprint repeated errors', () => {
  const d = diagnostic(error('invalid_request_error: Bearer SECRET sk-secretTOKEN api_key=PRIVATE ' + 'x'.repeat(9000)), 'entry');
  assert.ok(d.message.length <= 2048); assert.doesNotMatch(d.message, /SECRET|sk-secretTOKEN|PRIVATE/);
  assert.equal(d.fingerprint, diagnostic(error('invalid_request_error: Bearer SECRET sk-secretTOKEN api_key=PRIVATE ' + 'x'.repeat(9000), 999), 'different').fingerprint);
});
test('repairable feedback composes boundary drafts, caps two recoveries and does not reset for extension input', () => {
  const f = fixture(); f.begin();
  for (let i = 0; i < 3; i++) {
    f.fail(`invalid_request_error: invalid argument ${i}`);
    const result = f.settle([{ type: 'custom', customType: 'other-extension', data: 'kept' }]);
    if (i < 2) { assert.equal(result.continue, true); assert.equal(result.entries.length, 2); assert.equal(result.entries[0].customType, 'other-extension'); }
    else assert.equal(result, undefined);
    f.begin('extension');
  }
  assert.equal(f.sent.length, 0, 'automatic recovery is an atomic boundary draft, not queued sendMessage');
  assert.equal(f.branch.filter(e => e.customType === 'pi-runtime-state').at(-1).data.used, 2);
  f.begin(); f.fail('invalid_request_error: invalid argument: new real user task'); assert.equal(f.settle().continue, true);
});
test('identical error and duplicate boundary do not produce a loop or duplicate spend', () => {
  const f = fixture(); f.begin(); f.fail('invalid_request_error: invalid argument: same');
  assert.equal(f.settle().continue, true); assert.equal(f.settle(), undefined);
  f.fail('invalid_request_error: invalid argument: same'); assert.equal(f.settle(), undefined);
  assert.equal(f.branch.filter(e => e.customType === 'pi-runtime-state').at(-1).data.used, 1);
});
test('policy and unknown errors never automatically resume; manual recovery requires UI and explicit approval', async () => {
  const f = fixture(); f.begin(); f.fail('cyber_policy: This content was flagged for possible cybersecurity risk.');
  assert.equal(f.settle(), undefined); assert.equal(f.sent.length, 0);
  const cmd = f.commands.get('runtime-recover');
  await cmd.handler('Testing my own local application; read-only scope.', f.ctx); assert.equal(f.sent.length, 0);
  f.approved(true);
  await cmd.handler('Testing my own local application; read-only scope.', { ...f.ctx, hasUI: false }); assert.equal(f.sent.length, 0);
  await cmd.handler('Testing my own local application; read-only scope.', f.ctx);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].options.triggerTurn, true);
  assert.match(f.sent[0].message.content, /Do not.*evad/i);
  await cmd.handler('Testing my own local application; read-only scope.', f.ctx); assert.equal(f.sent.length, 1);
});
test('abort, busy, foreign owner and shutdown invalidate recovery; confirmation cannot outlive ownership', async () => {
  const f = fixture(); f.begin(); f.fail('invalid_request_error: invalid argument: abort'); f.controller.abort(); assert.equal(f.settle(), undefined);
  const g = fixture(); g.begin(); g.fail('cyber_policy: blocked'); g.idle(false);
  await g.commands.get('runtime-recover').handler('Testing owned application with read-only scope.', g.ctx); assert.equal(g.sent.length, 0);
  g.idle(true); g.confirmation(async () => { g.owner('foreign'); return true; });
  await g.commands.get('runtime-recover').handler('Testing owned application with read-only scope.', g.ctx); assert.equal(g.sent.length, 0);
  const h = fixture(); h.begin(); h.fail('invalid_request_error: invalid argument: shutdown'); h.emit('session_shutdown'); assert.equal(h.settle(), undefined);
});
test('budget survives reload and corrupt latest state fails closed instead of replenishing', () => {
  const f = fixture(); f.begin(); f.fail('invalid_request_error: invalid argument: first'); f.settle();
  f.reload(); f.begin('extension'); f.fail('invalid_request_error: invalid argument: second'); assert.equal(f.settle().continue, true);
  f.reload(); f.fail('invalid_request_error: invalid argument: third'); assert.equal(f.settle(), undefined);
  f.branch.push({ type: 'custom', customType: 'pi-runtime-state', data: { version: 1, used: -1 } });
  f.reload(); f.fail('invalid_request_error: invalid argument: corrupt'); assert.equal(f.settle(), undefined);
});
test('no-session cannot automatically recover, and off/on does not replenish the budget', async () => {
  const f = fixture(); (f.ctx.sessionManager as any).getSessionFile = () => undefined;
  f.begin(); f.fail('invalid_request_error: invalid argument: in memory'); assert.equal(f.settle(), undefined);
  const g = fixture(); g.begin(); g.fail('invalid_request_error: invalid argument: first'); g.settle();
  await g.commands.get('runtime-recovery').handler('off', g.ctx);
  g.fail('invalid_request_error: invalid argument: second'); assert.equal(g.settle(), undefined);
  await g.commands.get('runtime-recovery').handler('on', g.ctx); assert.equal(g.settle().continue, true);
  g.fail('invalid_request_error: invalid argument: third'); assert.equal(g.settle(), undefined);
});

test('generic invalid requests and safety-system denials require human review', () => {
  assert.equal(classifyError(error('invalid_request_error')), 'review');
  assert.equal(classifyError(error('invalid_request_error: rejected by our safety system')), 'policy');
  assert.equal(classifyError(error('invalid_request_error: safety system rejected invalid tool arguments')), 'policy');
});
test('explicit mixed policy refusals never automatically continue', () => {
  for (const text of ['policy refusal: invalid tool arguments', 'cybersecurity_policy: invalid tool arguments']) {
    assert.equal(classifyError(error(text)), 'policy');
    const f = fixture(); f.begin(); f.fail(text); assert.equal(f.settle(), undefined);
  }
});
test('idle RPC confirmation is refused before any dialog or late approval', async () => {
  const f = fixture(); f.begin(); f.fail('cyber_policy: blocked'); let dialogs = 0;
  f.confirmation(async () => { dialogs++; return true; });
  await f.commands.get('runtime-recover').handler('Owned local application with read-only authorized scope.', { ...f.ctx, mode: 'rpc', signal: undefined });
  assert.equal(dialogs, 0); assert.equal(f.sent.length, 0);
});
test('duplicate reservation IDs and conflicting fingerprints fail closed rather than refunding', () => {
  for (const conflict of [false, true]) {
    const f = fixture(); f.begin(); f.fail('invalid argument one'); f.settle();
    const latest = structuredClone(f.branch.filter(e => e.customType === 'pi-runtime-state').at(-1).data);
    if (conflict) latest.fingerprints[0] = 'a'.repeat(64);
    else { latest.used = 2; latest.handled.push(latest.handled[0]); latest.fingerprints.push(latest.fingerprints[0]); }
    const entry = { type: 'custom', id: 'corrupt-reservation', customType: 'pi-runtime-state', data: latest };
    f.branch.push(entry); f.entries.push(entry); f.reload(); f.fail('invalid argument two');
    assert.equal(f.settle(), undefined); assert.match(f.notices.join('\n'), /Invalid/);
  }
});
test('JSON credential values are redacted before journaling or feedback', () => {
  const d = diagnostic(error('invalid argument {"api_key":"PRIVATE", "access_token": "SECRET", "authorization":"Bearer TOKEN"}'), 'entry');
  assert.doesNotMatch(d.message, /PRIVATE|SECRET|TOKEN/);
});
test('escaped JSON credential strings are masked completely, including suffixes after escaped quotes', () => {
  const credentials = JSON.stringify({ api_key: 'PREFIX"PRIVATE_SUFFIX', access_token: 'PREFIX\\"TOKEN_SUFFIX', authorization: 'Bearer PREFIX"AUTH_SUFFIX' });
  const d = diagnostic(error('invalid argument ' + credentials), 'entry');
  assert.doesNotMatch(d.message, /PREFIX|PRIVATE_SUFFIX|TOKEN_SUFFIX|AUTH_SUFFIX/);
});
test('tree navigation and reload cannot replenish a task budget from an older branch snapshot', () => {
  const f = fixture(); f.begin(); const original = [...f.branch];
  f.fail('invalid argument one'); f.settle(); f.fail('invalid argument two'); f.settle();
  f.branch.splice(0, f.branch.length, ...original); f.emit('session_tree'); f.reload();
  f.fail('invalid argument three'); assert.equal(f.settle(), undefined);
});
test('handled or queued input cannot replenish budget through an extension custom continuation', () => {
  const f = fixture(); f.begin(); f.fail('invalid argument one'); f.settle(); f.fail('invalid argument two'); f.settle();
  f.emit('input', { source: 'interactive', text: 'handled prompt' });
  f.emit('agent_start'); f.emit('message_end', { message: { role: 'custom', content: 'extension continuation' } });
  f.fail('invalid argument three'); assert.equal(f.settle(), undefined);
  f.emit('input', { source: 'interactive', text: 'queued prompt', streamingBehavior: 'followUp' });
  f.emit('before_agent_start', { prompt: 'queued prompt' }); f.emit('agent_start');
  f.emit('message_end', { message: { role: 'user', content: 'queued prompt' } });
  f.fail('invalid argument four'); assert.equal(f.settle(), undefined);
});
test('admitted transformed/template user message resets only after the complete host prompt phases', () => {
  const f = fixture(); f.begin(); f.fail('invalid argument one'); f.settle(); f.fail('invalid argument two'); f.settle();
  const previous = f.branch.filter(e => e.customType === 'pi-runtime-state').at(-1).data.taskId;
  f.emit('input', { source: 'interactive', text: '/review owned' });
  f.emit('before_agent_start', { prompt: 'Expanded and transformed authorized review' });
  assert.equal(f.branch.filter(e => e.customType === 'pi-runtime-state').at(-1).data.taskId, previous, 'preflight alone is not admission');
  f.emit('agent_start');
  f.emit('message_end', { message: { role: 'system', content: 'system delta' } });
  f.emit('message_end', { message: { role: 'user', content: 'Expanded and transformed authorized review\nimage normalization hint' } });
  const next = f.branch.filter(e => e.customType === 'pi-runtime-state').at(-1).data;
  assert.notEqual(next.taskId, previous); assert.equal(next.used, 0);
  f.fail('invalid argument new admitted task'); assert.equal(f.settle().continue, true);
});

test('approval is invalidated by signal, input, new run and off/on without refunding spend', async () => {
  for (const invalidate of [
    (f: ReturnType<typeof fixture>) => f.controller.abort(),
    (f: ReturnType<typeof fixture>) => f.emit('input', { source: 'interactive', text: 'new input' }),
    (f: ReturnType<typeof fixture>) => f.emit('agent_start'),
    async (f: ReturnType<typeof fixture>) => { await f.commands.get('runtime-recovery').handler('off', f.ctx); await f.commands.get('runtime-recovery').handler('on', f.ctx); },
  ]) {
    const f = fixture(); f.begin(); f.fail('policy refusal: invalid argument');
    f.confirmation(async () => { await invalidate(f); return true; });
    await f.commands.get('runtime-recover').handler('Owned local application; read-only authorized scope.', f.ctx);
    assert.equal(f.sent.length, 0); assert.equal(f.branch.filter(e => e.customType === 'pi-runtime-state').at(-1).data.used, 0);
  }
});
test('reservation precedes manual submission and synchronous failure never refunds it', async () => {
  const f = fixture(); f.begin(); f.fail('policy refusal'); f.approved(true);
  (f.api as any).sendMessage = () => {
    const saved = f.branch.filter(e => e.customType === 'pi-runtime-state').at(-1).data;
    assert.equal(saved.used, 1); assert.equal(saved.pending, null); assert.equal(saved.handled.length, 1);
    throw new Error('offline submission failed');
  };
  await assert.rejects(f.commands.get('runtime-recover').handler('Owned local application; read-only authorized scope.', f.ctx), /offline submission failed/);
  f.reload(); assert.equal(f.branch.filter(e => e.customType === 'pi-runtime-state').at(-1).data.used, 1);
  f.fail('invalid argument second'); assert.equal(f.settle().continue, true);
  f.fail('invalid argument third'); assert.equal(f.settle(), undefined);
});
test('failed persistence never submits feedback or silently restores a healthy budget', () => {
  const f = fixture(); f.begin(); f.fail('invalid argument first');
  (f.api as any).appendEntry = () => { throw new Error('offline journal failed'); };
  assert.equal(f.settle(), undefined); assert.equal(f.sent.length, 0); assert.match(f.notices.join('\n'), /could not be recorded/);
  f.begin(); f.fail('invalid argument new task'); assert.equal(f.settle(), undefined);
});
test('aborted admission and repeated actual user object cannot create another task', () => {
  const f = fixture(); const message = { role: 'user', content: 'owned task' };
  const admit = () => { f.emit('input', { source: 'interactive', text: 'raw' }); f.emit('before_agent_start', { prompt: 'expanded' }); f.emit('agent_start'); f.emit('message_end', { message }); };
  admit(); const first = f.branch.filter(e => e.customType === 'pi-runtime-state').at(-1).data.taskId;
  f.fail('invalid argument first'); f.settle(); admit();
  assert.equal(f.branch.filter(e => e.customType === 'pi-runtime-state').at(-1).data.taskId, first);
  f.controller.abort(); f.begin(); assert.equal(f.branch.filter(e => e.customType === 'pi-runtime-state').at(-1).data.taskId, first);
});

test('model/tree round trips invalidate an outstanding confirmation even when leaf and model return', async () => {
  const f = fixture(); f.begin(); f.fail('cyber_policy: blocked');
  f.confirmation(async () => { f.emit('model_select'); f.emit('model_select'); return true; });
  await f.commands.get('runtime-recover').handler('Owned local application; read-only authorized scope.', f.ctx);
  assert.equal(f.sent.length, 0);
  f.confirmation(async () => { f.emit('session_tree'); f.emit('session_tree'); return true; });
  await f.commands.get('runtime-recover').handler('Owned local application; read-only authorized scope.', f.ctx);
  assert.equal(f.sent.length, 0);
});
