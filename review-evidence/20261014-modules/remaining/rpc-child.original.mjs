import fs from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
const guard = JSON.parse(process.env.PI_FORK_GUARD);
const mode = process.argv[2];
const record = row => fs.appendFileSync(join(process.cwd(), 'rpc-observed.jsonl'), JSON.stringify(row) + '\n');
const reply = (c, data) => process.stdout.write(JSON.stringify({ type: 'response', id: c.id, command: c.type, success: true, data }) + '\n');
process.send({ channel: 'pi-fork', token: guard.token, type: 'verified', tools: guard.tools });
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const c = JSON.parse(line); record({ type: c.type });
  if (c.type === 'get_state') reply(c, { sessionId: guard.sessionId });
  else if (c.type === 'get_session_stats' && mode === 'cancel-at-stats') process.send({ channel: 'review-stats-barrier' });
  else if (c.type === 'get_session_stats') reply(c, { tokens: { input: 1, output: 1, total: 2 }, cost: 0 });
  else if (c.type === 'prompt') { reply(c, { disposition: 'started' }); process.send({ channel: 'pi-fork', token: guard.token, type: 'settled', quiet: true }); }
  else if (c.type === 'get_last_assistant_text') reply(c, { text: 'safe protocol stand-in result' });
  else reply(c, {});
});
lines.on('close', () => { if (process.connected) process.disconnect(); });
