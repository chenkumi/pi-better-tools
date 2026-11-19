import type { FoldRule, ToolCallInfo, ToolResultInfo } from '../types.ts';
import { asRecord, num, oneLine, parseJson, plural, records, redact, str } from '../util.ts';

// Goal tools. The plan (rules, decisions, every checkpoint and its command), the verification logs and a person's note are all kept out
// of the line: they stay in the session file and are read back through the recall reference when needed.

const receiptOf = (result: ToolResultInfo) => asRecord(result.details) ?? asRecord(parseJson(result.text)) ?? {};
const goalId = (call: ToolCallInfo) => str(call.args.goalId) ?? '';
const status = (result: ToolResultInfo) => str(receiptOf(result).status) ?? 'unknown';
const checkpointRef = (call: ToolCallInfo) => [goalId(call), typeof call.args.index === 'number' ? `#${call.args.index}` : ''].filter(Boolean).join(' ');

export const goalRules: Record<string, FoldRule> = {
  plan_submit: {
    // Only the title and the number of checkpoints: the plan's text and commands are never copied.
    args: call => {
      const title = str(call.args.title);
      const count = Array.isArray(call.args.checkpoints) ? call.args.checkpoints.length : undefined;
      return [title ? JSON.stringify(oneLine(redact(title), 80)) : '', count === undefined ? '' : plural(count, 'checkpoint')].filter(Boolean).join(' ');
    },
    ok: (_call, result) => {
      const d = receiptOf(result);
      return `queued ${str(d.goalId) ?? '?'} (runs in the background; not finished)`;
    },
  },
  goal_status: {
    args: goalId,
    ok: (_call, result) => {
      const d = receiptOf(result);
      if (Array.isArray(d.goals)) {
        const goals = records(d.goals);
        return goals.length === 0 ? 'no goals' : `${plural(goals.length, 'goal')}: ${goals.slice(0, 6).map(goal => `${str(goal.goalId)?.slice(-6) ?? '?'}=${str(goal.status) ?? '?'}`).join(', ')}${goals.length > 6 ? ', …' : ''}`;
      }
      const checkpoints = records(d.checkpoints);
      const done = checkpoints.filter(checkpoint => checkpoint.status === 'done').length;
      return `${str(d.status) ?? 'unknown'}, ${done}/${checkpoints.length} done`;
    },
  },
  goal_cancel: { args: goalId, ok: (_call, result) => `${status(result)} (a stop request; child processes not confirmed stopped)` },
  goal_pause: { args: goalId, ok: (_call, result) => `${status(result)} (the attempt in progress was stopped and does not count)` },
  goal_resume: { args: goalId, ok: (_call, result) => status(result) },
  goal_retry: { args: checkpointRef, ok: (_call, result) => status(result) },
  goal_resolve: {
    // The person's note is free text: only whether it passed is kept.
    args: call => [checkpointRef(call), call.args.passed === true ? 'passed' : call.args.passed === false ? 'failed' : ''].filter(Boolean).join(' '),
    ok: (_call, result) => status(result),
  },
};

/** image_generate: how many files and where; never the prompt. */
export const imageRules: Record<string, FoldRule> = {
  image_generate: {
    args: call => [str(call.args.backend), num(call.args.count) ? `×${call.args.count}` : ''].filter(Boolean).join(' '),
    ok: (_call, result) => {
      const d = receiptOf(result);
      const files = records(d.files);
      const paths = files.slice(0, 3).map(file => oneLine(redact(str(file.path) ?? '?'), 80)).join(', ');
      return `${str(d.backend) ?? '?'} ${plural(files.length, 'file')}${paths ? `: ${paths}${files.length > 3 ? ', …' : ''}` : ''}`;
    },
  },
};
