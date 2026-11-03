import type { FoldRule, ToolCallInfo, ToolResultInfo } from '../types.ts';
import { asRecord, idStatusList, num, oneLine, parseJson, plural, records, redact, str } from '../util.ts';

const detailsOf = (result: ToolResultInfo) => asRecord(result.details) ?? {};
const receiptOf = (result: ToolResultInfo) => asRecord(result.details) ?? asRecord(parseJson(result.text)) ?? {};
const jobId = (call: ToolCallInfo) => str(call.args.jobId) ?? '';
const firstSentence = (text: string, max = 160) => oneLine(text.split(/(?<=[.!?。])\s|\n/, 1)[0] ?? '', max);

function subagentArgs(call: ToolCallInfo): string {
  const mode = Array.isArray(call.args.tasks) ? `parallel ×${call.args.tasks.length}` : Array.isArray(call.args.chain) ? `chain ×${call.args.chain.length}` : '';
  const agent = str(call.args.agent), task = str(call.args.task);
  const single = agent ? `${agent}${task ? ` ${JSON.stringify(oneLine(redact(task), 120))}` : ''}` : '';
  return [mode, single, call.args.background === true ? '[background]' : ''].filter(Boolean).join(' ');
}

export const agentRules: Record<string, FoldRule> = {
  subagent: {
    args: subagentArgs,
    ok: (_call, result) => {
      const d = detailsOf(result);
      const background = asRecord(d.background);
      if (background) return `job ${str(background.jobId) ?? '?'} ${str(background.status) ?? 'accepted'}`;
      const results = records(d.results);
      const states = results.slice(0, 6).map(item => `${str(item.agent) ?? '?'}:${str(item.status) ?? '?'}${num(item.exitCode) ? ` exit ${item.exitCode}` : ''}`).join(', ');
      return `${states || 'done'}${results.length > 6 ? ', …' : ''}; ${firstSentence(result.text)}`;
    },
  },
  subagent_status: {
    args: jobId,
    ok: (_call, result) => {
      const d = receiptOf(result);
      return Array.isArray(d.jobs) ? idStatusList(d.jobs, 'job', 'jobId', 'status') : `${str(d.status) ?? 'unknown'}${d.cancelRequested === true ? ' (cancel requested)' : ''}`;
    },
  },
  subagent_cancel: {
    args: jobId,
    ok: (_call, result) => `${str(receiptOf(result).status) ?? 'requested'} (cancellation is a request; not confirmed stopped)`,
  },
  subagent_message: {
    args: call => [jobId(call), str(call.args.mode)].filter(Boolean).join(' '),
    ok: (_call, result) => `${str(receiptOf(result).status) ?? firstSentence(result.text)} (accepted is not applied)`,
  },
  fork: {
    args: call => JSON.stringify(oneLine(redact(str(call.args.title) ?? str(call.args.task) ?? ''), 100)),
    ok: (_call, result) => firstSentence(result.text, 200),
  },
  fork_status: {
    args: jobId,
    ok: (_call, result) => {
      const d = receiptOf(result);
      if (Array.isArray(d.forks)) return `${idStatusList(d.forks, 'job', 'jobId', 'status')}${d.partial === true ? ' (partial)' : ''}`;
      const code = str(d.errorCode);
      return `${str(d.status) ?? 'unknown'}${code ? ` ${code}` : ''}${str(d.delivery) ? `, delivery ${d.delivery}` : ''}`;
    },
  },
  fork_cancel: {
    args: jobId,
    ok: (_call, result) => `${str(receiptOf(result).status) ?? 'requested'} (cancellation is a request; not confirmed exited)`,
  },
  fork_message: {
    args: call => [jobId(call), str(call.args.mode)].filter(Boolean).join(' '),
    ok: (_call, result) => `${str(receiptOf(result).status) ?? firstSentence(result.text)} (accepted is not applied)`,
  },
  monitor_start: { args: monitorArgs, ok: (_call, result) => monitorOutcome(result) },
  monitor_status: { args: call => str(call.args.monitorId) ?? '', ok: (_call, result) => monitorOutcome(result) },
  monitor_stop: { args: call => str(call.args.monitorId) ?? '', ok: (_call, result) => monitorOutcome(result) },
};

/** The receipt already carries a masked source preview; the raw call arguments (which may hold a command) are never used. */
function monitorArgs(call: ToolCallInfo): string {
  const source = asRecord(call.args.source);
  return source ? str(source.kind) ?? '' : '';
}

function monitorOutcome(result: ToolResultInfo): string {
  const d = receiptOf(result);
  if (str(d.error)) return `error: ${oneLine(String(d.error), 200)}`;
  if (Array.isArray(d.monitors)) return plural(d.monitors.length, 'monitor');
  const preview = str(d.sourcePreview);
  return `${str(d.monitorId) ?? '?'} ${str(d.state) ?? 'unknown'}${preview ? ` [${oneLine(preview, 100)}]` : ''}`;
}
