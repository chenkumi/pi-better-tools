import { execFile } from 'node:child_process';

const TIMEOUT_MS = 5000;
const MAX_BUFFER = 1024 * 1024;
const MAX_FILES = 20;
const CONTROL = /[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/g;
const CONFLICT = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
/** Variables that relocate git's repository discovery; stripped so the status always describes `cwd`. */
const REPO_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX'];

function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string | undefined> {
  const env = { ...process.env };
  for (const key of REPO_ENV) delete env[key];
  return new Promise(resolve => {
    try {
      execFile('git', args, { cwd, env, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true, signal, encoding: 'utf8' }, (error, stdout) => resolve(error ? undefined : stdout));
    } catch { resolve(undefined); }
  });
}

/** One word per porcelain `XY` status; ignored files give nothing. */
export function tagFromPorcelain(xy: string): string | undefined {
  const x = xy[0] ?? ' ', y = xy[1] ?? ' ';
  if (xy === '??') return 'new';
  if (x === '!' || y === '!') return undefined;
  if (CONFLICT.has(xy)) return 'conflicted';
  if (x === 'R' || x === 'C') return 'renamed';
  if (x === 'D' || y === 'D') return 'deleted';
  const tags = [x !== ' ' ? 'staged' : '', y !== ' ' ? 'unstaged' : ''].filter(Boolean);
  return tags.length ? tags.join(',') : undefined;
}

/** `git status --porcelain=v1 -z` into `[path, tag]` rows; a rename or copy is followed by its source path, which is skipped. */
export function parsePorcelain(output: string): Array<[string, string]> {
  const parts = output.split('\0').filter(Boolean), rows: Array<[string, string]> = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2), tag = tagFromPorcelain(xy);
    if (xy[0] === 'R' || xy[0] === 'C') i++;
    if (tag) rows.push([entry.slice(3).replace(CONTROL, ' ').slice(0, 200), tag]);
  }
  return rows;
}

/**
 * The working tree at compaction time: HEAD, branch and the files that differ from it. Paths and one-word tags only, never
 * diffs or content. Bounded in time and output; anything unexpected (no git, not a repository, timeout) gives no block.
 */
export async function workingTreeLines(cwd: string, signal?: AbortSignal): Promise<string[]> {
  const head = (await git(cwd, ['rev-parse', '--short=7', 'HEAD'], signal))?.trim();
  if (!head || !/^[0-9a-f]{7,40}$/.test(head)) return [];
  const branch = (await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'], signal))?.trim().replace(CONTROL, '').slice(0, 100);
  const status = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], signal);
  if (status === undefined) return [];
  const rows = parsePorcelain(status);
  const lines = [`Working tree at compaction: HEAD ${head}${branch ? ` on ${branch}` : ' (detached)'}; ${rows.length ? `${rows.length} changed` : 'clean'}`];
  for (const [path, tag] of rows.slice(0, MAX_FILES)) lines.push(`- ${path} (${tag})`);
  if (rows.length > MAX_FILES) lines.push(`- … +${rows.length - MAX_FILES} more`);
  return lines;
}
