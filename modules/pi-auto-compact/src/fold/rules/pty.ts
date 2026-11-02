import type { FoldRule, ToolCallInfo, ToolResultInfo } from '../types.ts';
import { asRecord, list, num, oneLine, plural, redact, str, tailLines } from '../util.ts';

const detailsOf = (result: ToolResultInfo) => asRecord(result.details) ?? {};
const session = (call: ToolCallInfo) => str(call.args.sessionId) ?? '';

/** pty_read and pty_write(readAfterMs): the screen text is already masked by the tool; it is kept as a short tail only. */
function readOutcome(result: ToolResultInfo): string {
  const d = detailsOf(result);
  const cursor = asRecord(d.cursor);
  const flags = [d.truncated === true ? 'truncated' : '', d.exited === true ? 'exited' : '', str(d.waitFor) === 'timeout' ? 'waitFor timed out' : ''].filter(Boolean);
  const tail = tailLines(result.text.replace(/\[(?:cursor|pty-terminal)[^\]]*\]/g, ''), 5);
  const range = cursor && num(cursor.from) !== undefined ? `cursor ${num(cursor.from)}–${num(cursor.to)}` : '';
  return [range, ...flags].filter(Boolean).join(', ') + (tail.length ? `; tail: ${tail.map(line => JSON.stringify(line)).join(' ')}` : '');
}

export const ptyRules: Record<string, FoldRule> = {
  pty_spawn: {
    args: call => JSON.stringify(oneLine(redact(str(call.args.command) ?? ''), 80)),
    ok: (_call, result) => { const d = detailsOf(result); return `session ${str(d.sessionId) ?? '?'}${str(d.state) ? ` ${d.state}` : ''}`; },
  },
  pty_list: {
    args: () => '',
    ok: (_call, result) => {
      const sessions = list(result.details).map(asRecord).filter((item): item is Record<string, unknown> => item !== undefined);
      return `${plural(sessions.length, 'session')}${sessions.length ? `: ${sessions.slice(0, 5).map(item => `${str(item.sessionId) ?? '?'}=${str(item.state) ?? '?'}`).join(', ')}${sessions.length > 5 ? ', …' : ''}` : ''}`;
    },
  },
  pty_read: { args: session, ok: (_call, result) => readOutcome(result) },
  pty_write: { args: session, ok: (_call, result) => (asRecord(detailsOf(result).cursor) ? readOutcome(result) : 'ok') },
  /** The secret never reaches the model; neither the typed text nor any result text is kept, only whether it was delivered. */
  pty_keyin: {
    args: session,
    errors: 'hidden',
    ok: (_call, result) => { const d = detailsOf(result); return d.delivered === false ? `not sent (${str(d.reason) ?? 'cancelled'})` : 'secret sent (content hidden)'; },
  },
  pty_resize: { args: session, ok: call => `${num(call.args.cols) ?? '?'}×${num(call.args.rows) ?? '?'}` },
  pty_wait_exit: {
    args: session,
    ok: (_call, result) => {
      const d = detailsOf(result);
      if (d.timedOut === true) return 'timed out waiting (still running)';
      return `exit ${num(d.exitCode) ?? '?'}${str(d.signal) ? ` signal ${d.signal}` : ''}`;
    },
  },
  pty_kill: {
    args: session,
    ok: (_call, result) => {
      const d = detailsOf(result);
      return `${d.released === true ? 'released' : `not released${d.exited === true ? ' (exited)' : ''}`}${d.escalatedToSigkill === true ? ', escalated to SIGKILL' : ''} (a kill is a request; a remote process tree may remain)`;
    },
  },
};
