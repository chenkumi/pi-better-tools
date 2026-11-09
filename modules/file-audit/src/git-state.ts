import { createHash } from "node:crypto";
import { runGit } from "../../../shared/src/git/index.ts";
import { safeText } from "./presentation.ts";

const TIMEOUT_MS = 2000;
const MAX_STATUS_BYTES = 4 * 1024 * 1024;
/** Pi's own bookkeeping under `<cwd>/.pi` (Fork records and transcripts, schedule files) is left out of the digest: it moves without the user or the agent touching the project. Other `.pi` files (settings, agent configs, skills) are project files and still count. */
const PI_BOOKKEEPING = [":(exclude).pi/forks", ":(exclude,glob).pi/schedule-prompts*.json", ":(exclude,glob).pi/agent/schedule-prompts*.json", ":(exclude,glob).pi/schedule-commands*", ":(exclude,glob).pi/agent/schedule-commands*"];
/** What a reply left behind: the commit, the branch (none when detached) and a digest of `git status`. No paths, no content. */
export interface GitState { head: string; branch?: string; tree: string }
export interface GitChange { branch?: { from?: string; to?: string }; head?: { from: string; to: string }; tree?: true }

const git = (cwd: string, args: string[], signal?: AbortSignal) => runGit(cwd, args, { signal, timeoutMs: TIMEOUT_MS, maxBuffer: MAX_STATUS_BYTES });

/** Undefined outside a repository, before the first commit, or when git is missing, slow or fails: the notice is advisory. */
export async function captureGitState(cwd: string, signal?: AbortSignal): Promise<GitState | undefined> {
  const [head, branch, status] = await Promise.all([
    git(cwd, ["rev-parse", "HEAD"], signal),
    git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"], signal),
    git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--", ":/", ...PI_BOOKKEEPING], signal),
  ]);
  const sha = head?.trim();
  if (!sha || !/^[0-9a-f]{40,64}$/.test(sha) || status === undefined) return undefined;
  const name = branch?.trim();
  return { head: sha, ...(name ? { branch: name } : {}), tree: createHash("sha256").update(status).digest("hex") };
}

export function diffGitState(before: GitState, after: GitState): GitChange | undefined {
  const change: GitChange = {};
  if (before.branch !== after.branch) change.branch = { from: before.branch, to: after.branch };
  if (before.head !== after.head) change.head = { from: before.head, to: after.head };
  if (before.tree !== after.tree) change.tree = true;
  return Object.keys(change).length ? change : undefined;
}

const branchText = (name: string | undefined) => name === undefined ? "(detached)" : safeText(name, 100);
/** One short line; details are for the agent to fetch with git status / git diff. */
export function gitNotice(change: GitChange): string {
  const parts = [
    ...(change.branch ? [`branch ${branchText(change.branch.from)} → ${branchText(change.branch.to)}`] : []),
    ...(change.head ? [`HEAD ${change.head.from.slice(0, 7)} → ${change.head.to.slice(0, 7)}`] : []),
    ...(change.tree ? ["working tree changed"] : []),
  ];
  return `Git state differs from your last reply: ${parts.join("; ")}. Use git status or git diff for details.`;
}

/**
 * The git state each reply left behind, so the next user input can tell what moved in between. `mark` runs at session start
 * and when a run settles; `detect` compares with it, refreshes it and reports the difference once.
 */
export class GitWatch {
  private baseline: Promise<GitState | undefined> | undefined;
  private epoch = 0;
  reset(): void { this.epoch++; this.baseline = undefined; }
  mark(cwd: string): void {
    this.epoch++;
    this.baseline = captureGitState(cwd).catch(() => undefined);
  }
  async detect(cwd: string, signal?: AbortSignal): Promise<GitChange | undefined> {
    const epoch = this.epoch, pending = this.baseline;
    if (!pending) return undefined;
    const before = await pending;
    if (!before) return undefined;
    const after = await captureGitState(cwd, signal);
    if (!after || epoch !== this.epoch) return undefined;
    this.baseline = Promise.resolve(after);
    return diffGitState(before, after);
  }
}
