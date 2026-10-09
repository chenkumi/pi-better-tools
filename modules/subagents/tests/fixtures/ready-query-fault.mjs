import fs from 'node:fs';
import readline from 'node:readline';
const guard = JSON.parse(process.env.PI_SUBAGENTS_GUARD);
const mode = process.argv[2];
const slash = guard.model.indexOf('/');
fs.writeFileSync(guard.startupPath, JSON.stringify({ id: guard.id, cwd: guard.cwd, model: guard.model, thinkingLevel: guard.thinkingLevel, childTrusted: guard.childTrusted }));
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  const request = JSON.parse(line);
  const file = process.argv[process.argv.indexOf('--session') + 1];
  const response = JSON.stringify({ type: 'response', id: request.id, command: request.type, success: true, data: { sessionId: guard.id, sessionFile: file, model: { provider: guard.model.slice(0, slash), id: guard.model.slice(slash + 1) }, thinkingLevel: guard.thinkingLevel } }) + '\n';
  // One write supplies the successful handshake and fault before its await resumes.
  const startupFault = mode === 'startup-invalid-json' ? '{broken JSON\n' : mode === 'startup-mainline' ? JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: 'forbidden startup mainline' } }) + '\n' : '';
  process.stdout.write(response + startupFault);
});
let answered = false;
process.on('message', request => {
  if (request.type !== 'query') return;
  fs.writeFileSync(guard.cwd + '/query-request-seen', request.queryId);
  process.send({ channel: 'pi-subagent-query', token: guard.bridgeToken, type: 'query_result', queryId: request.queryId, status: 'completed', output: 'must not survive protocol failure', usage: { totalTokens: 7 }, provider: guard.model.slice(0, slash), model: guard.model.slice(slash + 1) }, () => { answered = true; });
});
input.on('close', () => {
  const suffix = mode.endsWith('-tail') ? '' : '\n';
  const fault = mode.startsWith('invalid-json') ? '{broken JSON' + suffix : JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: 'forbidden mainline' } }) + suffix;
  if (mode === 'hold-fault') {
    const release = guard.cwd + '/release-query-close';
    const watcher = fs.watch(guard.cwd, () => { if (fs.existsSync(release)) { watcher.close(); process.disconnect(); } });
    process.stdout.write(fault);
  } else process.stdout.write(answered && mode !== 'clean' ? fault : '', () => { process.disconnect(); });
});
