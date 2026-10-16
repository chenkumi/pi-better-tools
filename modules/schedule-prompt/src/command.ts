/**
 * Shell command jobs (local adaptation, not part of the upstream snapshot).
 *
 * Pure helpers shared by the tool, the UI and the scheduler: field validation, working-directory resolution and the
 * in-process approval registry. Nothing here spawns a process.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { MAX_TIMEOUT_MS } from "../../shell-tools/src/timeout-ms.mjs";
import type { CommandShell, CronJob } from "./types.js";

/** Default output-stall deadline when a command job does not set `timeoutMs`. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 300_000;
/** Command runs allowed at once; extra ticks are skipped rather than queued. */
export const MAX_CONCURRENT_COMMANDS = 4;
/** Upper bound for a persisted/typed command (matches the tool schema). */
export const MAX_COMMAND_LENGTH = 8000;
/** Bytes of combined output kept for the result snippet; older output is dropped. */
export const COMMAND_OUTPUT_TAIL_BYTES = 8 * 1024;
/** Defer an early abort until first output (at most this long) so the host kills the tree after the shell spawned its children. */
export const COMMAND_ABORT_GRACE_MS = 500;
/** After an abort, stop waiting for pipe close after this long (the process tree may then still be running). */
export const COMMAND_CLOSE_WAIT_MS = 5_000;
/** Like Pi's bash tool: after the shell exits, settle once the pipes stay silent this long (a descendant may still hold them). */
export const COMMAND_EXIT_IDLE_MS = 250;

export const COMMAND_SHELLS: readonly CommandShell[] = ["bash", "powershell"];

/** Windows defaults to PowerShell (Pi's PowerShell tool), everything else to bash. */
export function defaultCommandShell(platform: NodeJS.Platform = process.platform): CommandShell {
  return platform === "win32" ? "powershell" : "bash";
}

export function isCommandShell(value: unknown): value is CommandShell {
  return typeof value === "string" && (COMMAND_SHELLS as readonly string[]).includes(value);
}

export function isValidCommandTimeout(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_TIMEOUT_MS;
}

/** Fields that only make sense for command jobs / prompt jobs; used to reject mixed jobs. */
const COMMAND_ONLY = ["shell", "cwd", "timeoutMs"] as const;
const PROMPT_ONLY = ["model", "notify", "extensions", "skills"] as const;

/**
 * Structural validation of a job's execution kind. Returns an error message, or undefined when the job is
 * a well-formed prompt job or a well-formed command job. Never touches the file system.
 */
export function jobKindError(job: Partial<CronJob>): string | undefined {
  const hasPrompt = job.prompt !== undefined;
  const hasCommand = job.command !== undefined;
  if (hasPrompt === hasCommand) return "Provide exactly one of 'prompt' or 'command'";
  if (hasPrompt) {
    const stray = COMMAND_ONLY.filter((key) => job[key] !== undefined);
    return stray.length > 0 ? `${stray.map((k) => `'${k}'`).join(", ")} only apply to command jobs` : undefined;
  }
  if (typeof job.command !== "string" || job.command.trim().length === 0) return "'command' must be a non-empty string";
  if (job.command.length > MAX_COMMAND_LENGTH) return `'command' is longer than ${MAX_COMMAND_LENGTH} characters`;
  const stray = PROMPT_ONLY.filter((key) => job[key] !== undefined);
  if (stray.length > 0) return `${stray.map((k) => `'${k}'`).join(", ")} only apply to prompt jobs; command jobs never start a model or wake the parent`;
  if (job.shell !== undefined && !isCommandShell(job.shell)) return "'shell' must be 'bash' or 'powershell'";
  if (job.cwd !== undefined && (typeof job.cwd !== "string" || job.cwd.length === 0)) return "'cwd' must be a non-empty string";
  if (job.timeoutMs !== undefined && !isValidCommandTimeout(job.timeoutMs)) return `'timeoutMs' must be an integer from 1 to ${MAX_TIMEOUT_MS}`;
  return undefined;
}

/** `Command (bash): echo hi` — one label shared by the tool listing, overlay, menu and renderer. */
export function commandLabel(job: Pick<CronJob, "command" | "shell">): string {
  return `Command (${job.shell ?? defaultCommandShell()}): ${job.command ?? ""}`;
}

/** The exact spec a person confirms: what runs, where, with which shell and stall deadline. Used by every confirmation. */
export function commandSpecLines(projectCwd: string, spec: Pick<CronJob, "command" | "shell" | "cwd" | "timeoutMs">): string[] {
  const lines = [
    `Command: ${spec.command ?? ""}`,
    `Shell: ${spec.shell ?? defaultCommandShell()}`,
    `Directory: ${spec.cwd ?? "(project directory)"}`,
  ];
  const resolved = resolveCommandCwd(projectCwd, spec.cwd);
  if (!resolved.ok) lines.push(`Directory problem: ${resolved.error}`);
  else if (resolved.outsideProject) lines.push("Warning: this directory is OUTSIDE the project; the command runs there with your permissions.");
  lines.push(`Stall timeout: ${spec.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS} ms${spec.timeoutMs === undefined ? " (default)" : ""} without output`);
  lines.push("Runs unattended on every trigger with your permissions; output is shown in chat only and is never sent to the model.");
  return lines;
}

export type ResolvedCwd = { ok: true; cwd: string; outsideProject: boolean } | { ok: false; error: string };

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false; // different drive/root
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

/**
 * Resolve a command job's working directory to a real, existing directory.
 *
 * Relative values resolve against the project cwd. Both sides go through realpath, so symlinks and junctions cannot
 * make an outside directory look inside (and a swapped link is detected again at every fire). `path.relative` is
 * case-insensitive on Windows, and the `..` test is segment-aware so a sibling like `proj-evil` or `..cache` is
 * classified correctly. Callers must re-run this at fire time; the result is a snapshot, not a capability.
 */
export function resolveCommandCwd(projectCwd: string, requested?: string): ResolvedCwd {
  let root: string;
  try {
    root = fs.realpathSync(projectCwd);
  } catch (error) {
    return { ok: false, error: `Project directory is not accessible: ${error instanceof Error ? error.message : String(error)}` };
  }
  let real: string;
  try {
    real = fs.realpathSync(requested === undefined ? root : path.resolve(root, requested));
  } catch {
    return { ok: false, error: `Working directory does not exist: ${requested ?? projectCwd}` };
  }
  try {
    if (!fs.statSync(real).isDirectory()) return { ok: false, error: `Working directory is not a directory: ${real}` };
  } catch (error) {
    return { ok: false, error: `Working directory is not accessible: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, cwd: real, outsideProject: !isInside(root, real) };
}

/** Normalize for fingerprinting: Windows paths are case-insensitive. */
function cwdKey(cwd: string): string {
  return process.platform === "win32" ? cwd.toLowerCase() : cwd;
}

/**
 * In-process memory of which command specs a person approved during this Pi process.
 *
 * It is deliberately NOT persisted: a job file can be hand-edited or arrive with a cloned repository, so a stored flag
 * would prove nothing. Only a directory outside the project requires it; inside the (trusted) project a persisted job
 * runs without a fresh approval, exactly like the existing prompt jobs.
 */
export class CommandApprovals {
  private readonly approved = new Set<string>();

  static fingerprint(command: string, shell: CommandShell, realCwd: string): string {
    return JSON.stringify([command, shell, cwdKey(realCwd)]);
  }

  approve(command: string, shell: CommandShell, realCwd: string): void {
    this.approved.add(CommandApprovals.fingerprint(command, shell, realCwd));
  }

  isApproved(command: string, shell: CommandShell, realCwd: string): boolean {
    return this.approved.has(CommandApprovals.fingerprint(command, shell, realCwd));
  }

  clear(): void {
    this.approved.clear();
  }
}
