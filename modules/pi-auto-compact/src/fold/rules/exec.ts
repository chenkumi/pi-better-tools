import type { FoldRule, ToolCallInfo, ToolResultInfo } from '../types.ts';
import { asRecord, formatDuration, list, num, oneLine, parseJson, plural, redact, str, tailLines } from '../util.ts';

const command = (call: ToolCallInfo) => {
  const background = call.args.background === true ? ' [background]' : '';
  return `${JSON.stringify(oneLine(redact(str(call.args.command) ?? ''), 160))}${background}`;
};

/** Pi's bash tool reports a non-zero exit as an error result whose text ends with `Command exited with code N`. */
function shellOutcome(_call: ToolCallInfo, result: ToolResultInfo): string {
  const receipt = /(?:^|\n)job (\S+) running(?:\n|$)/.exec(result.text);
  if (receipt) return `job ${receipt[1]} running`;
  const exit = /Command exited with code (\d+)/.exec(result.text);
  const code = exit ? Number(exit[1]) : result.isError ? undefined : 0;
  const duration = result.durationMs !== undefined ? `, ${formatDuration(result.durationMs)}` : '';
  const truncated = asRecord(result.details)?.truncation ? ', output truncated' : '';
  if (code === undefined) return `failed${duration}: ${oneLine(result.text, 240)}`;
  const body = result.text.replace(/\n*Command exited with code \d+\s*$/, '');
  const tail = tailLines(body, code === 0 ? 2 : 5);
  return `exit ${code}${duration}${truncated}${tail.length ? `; tail: ${tail.map(line => JSON.stringify(line)).join(' ')}` : ''}`;
}

const shell = (): FoldRule => ({ args: command, ok: shellOutcome, errors: 'own' });

const jobStatus = (value: Record<string, unknown>) => {
  const exit = num(value.exitCode), elapsed = num(value.elapsedMs);
  return `${str(value.status) ?? 'unknown'}${exit !== undefined ? ` exit ${exit}` : ''}${elapsed !== undefined ? `, ${formatDuration(elapsed)}` : ''}${value.outputTruncated === true ? ', output truncated' : ''}`;
};

export const execRules: Record<string, FoldRule> = {
  bash: shell(),
  powershell: shell(),
  shell_job_status: {
    args: call => str(call.args.jobId) ?? '',
    ok: (_call, result) => {
      const parsed = parseJson(result.text);
      if (Array.isArray(parsed)) {
        const items = parsed.map(asRecord).filter((item): item is Record<string, unknown> => item !== undefined);
        return `${plural(items.length, 'job')}${items.length ? `: ${items.slice(0, 5).map(item => `${str(item.jobId) ?? '?'}=${str(item.status) ?? '?'}`).join(', ')}${items.length > 5 ? ', …' : ''}` : ''}`;
      }
      const object = asRecord(parsed);
      return object ? jobStatus(object) : oneLine(result.text, 160);
    },
  },
  shell_job_cancel: {
    args: call => str(call.args.jobId) ?? '',
    ok: (_call, result) => {
      const object = asRecord(parseJson(result.text));
      const status = object ? str(object.status) : undefined;
      if (!status) return oneLine(result.text, 160);
      return status === 'cancelling' ? 'cancelling (requested; not yet confirmed stopped)' : jobStatus(object!);
    },
  },
  schedule_prompt: {
    args: call => [str(call.args.action), str(call.args.name) ?? str(call.args.jobId), str(call.args.schedule)].filter(Boolean).map(item => oneLine(redact(item!), 80)).join(' '),
    ok: (_call, result) => scheduleOutcome(result),
  },
  schedule_shell: {
    args: call => [str(call.args.action), str(call.args.name) ?? str(call.args.jobId), str(call.args.schedule), str(call.args.command) ? JSON.stringify(oneLine(redact(String(call.args.command)), 160)) : undefined].filter(Boolean).join(' '),
    ok: (_call, result) => scheduleOutcome(result),
  },
};

function scheduleOutcome(result: ToolResultInfo): string {
  const d = asRecord(result.details) ?? {};
  if (str(d.error)) return `error: ${oneLine(String(d.error), 200)}`;
  const jobs = list(d.jobs);
  const id = str(d.jobId) ?? str(d.jobName);
  if (id) return `job ${id}`;
  return jobs.length || Array.isArray(d.jobs) ? plural(jobs.length, 'job') : oneLine(result.text, 160);
}
