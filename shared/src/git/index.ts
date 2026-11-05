import { execFile } from 'node:child_process';

/** Variables that relocate git's repository discovery; stripped so a command always describes `cwd`. */
const REPO_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX'];
/**
 * Read-only observation flags: no optional index lock (a refresh must not collide with the user's own git command) and no
 * fsmonitor (a repository's config can name a program for it, which `git status` would then run).
 */
const OBSERVE_FLAGS = ['--no-optional-locks', '-c', 'core.fsmonitor=false'];

export interface RunGitOptions { signal?: AbortSignal; timeoutMs?: number; maxBuffer?: number }

/** Runs `git <args>` in `cwd`; stdout on success, `undefined` for any failure (no git, not a repository, timeout, abort, oversized output). */
export function runGit(cwd: string, args: readonly string[], options: RunGitOptions = {}): Promise<string | undefined> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of REPO_ENV) delete env[key];
  return new Promise(resolve => {
    try {
      execFile('git', [...OBSERVE_FLAGS, ...args], {
        cwd, env, timeout: options.timeoutMs ?? 5000, maxBuffer: options.maxBuffer ?? 1024 * 1024, windowsHide: true, signal: options.signal, encoding: 'utf8',
      }, (error, stdout) => resolve(error ? undefined : stdout));
    } catch { resolve(undefined); }
  });
}
