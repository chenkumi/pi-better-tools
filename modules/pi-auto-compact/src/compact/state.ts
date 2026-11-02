import { formatRef } from '../fold/ref.ts';
import { asRecord, clip, oneLine, redact, str } from '../fold/util.ts';
import type { Item } from './items.ts';

const MAX_FILES = 30;
const MAX_COMMITS = 10;
const GOAL_MAX = 600;
/** `git commit` output: `[branch abc1234] subject` (a root commit adds `(root-commit)`). */
const COMMIT_LINE = /^\[[^\]\s]+(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.+)$/m;
const GIT_COMMIT = /\bgit\s+(?:-\S+\s+(?:\S+\s+)?)*commit\b/;

/** The first request of the session. Fixed for the whole session, so it can sit at the top without disturbing the cache. */
export function goalLine(items: readonly Item[]): string | undefined {
  const first = items.find(item => item.kind === 'user' && item.text.trim());
  return first ? `Goal (first request): ${clip(oneLine(first.text, GOAL_MAX), GOAL_MAX)}` : undefined;
}

/**
 * State that the sliding window would lose, gathered from the whole history before the cut: files written or edited and
 * commits made. Changes at every compaction, so it belongs at the very end of the summary.
 */
export function stateLines(items: readonly Item[]): string[] {
  const files = new Map<string, string>();
  const commits: string[] = [];
  for (const item of items) {
    for (const { call, result } of item.calls) {
      if (!result || result.isError) continue;
      if (call.name === 'write' || call.name === 'edit') {
        const path = str(call.args.path) ?? str(asRecord(result.details)?.path);
        if (!path) continue;
        files.delete(path);
        files.set(path, `- ${oneLine(path, 200)} (${call.name})${result.ref ? ` ${formatRef(result.ref)}` : ''}`);
      } else if ((call.name === 'bash' || call.name === 'powershell') && GIT_COMMIT.test(str(call.args.command) ?? '')) {
        const match = COMMIT_LINE.exec(result.text);
        if (match) commits.push(`- ${match[1]!.slice(0, 7)} ${clip(oneLine(redact(match[2]!), 120), 120)}${result.ref ? ` ${formatRef(result.ref)}` : ''}`);
      }
    }
  }
  const out: string[] = [];
  if (files.size) out.push('Files changed (oldest first):', ...[...files.values()].slice(-MAX_FILES));
  if (commits.length) out.push('Commits (oldest first):', ...commits.slice(-MAX_COMMITS));
  return out;
}
