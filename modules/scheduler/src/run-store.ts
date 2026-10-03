import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { atomicWriteFile } from "./atomic-rename.js";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { appendRunEvent, isTerminalRunStatus, transitionRun, type ProcessIdentity, type Run, type RunEvent, type RunStatus } from "./domain.js";
import { withAdvisoryLock } from "./locking.js";

export interface RunStoreOptions {
  runsPath: string;
  lockPath: string;
  logsDir: string;
  maxHistory?: number;
  maxOutputBytes?: number;
}

/** Lines that are not valid run objects are returned separately so one bad line cannot take the scheduler down. */
function parseRuns(text: string): { runs: Run[]; bad: string[] } {
  const runs: Run[] = [];
  const bad: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || typeof (value as Run).runId !== "string" || typeof (value as Run).scheduleId !== "string" || typeof (value as Run).status !== "string") throw new Error("not a run");
      runs.push(value as Run);
    } catch {
      bad.push(line);
    }
  }
  return { runs, bad };
}

export function truncateOutput(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return `${new StringDecoder("utf8").write(bytes.subarray(0, maxBytes))}\n[truncated]`;
}

export class RunStore {
  private readonly maxHistory: number;
  private readonly maxOutputBytes: number;
  private logCleanupError?: string;
  private readonly quarantined = new Set<string>();

  diagnostics() { return { maxHistory: this.maxHistory, maxOutputBytes: this.maxOutputBytes, logCleanupError: this.logCleanupError, quarantinedLines: this.quarantined.size }; }

  constructor(private readonly options: RunStoreOptions) {
    this.maxHistory = options.maxHistory ?? 500;
    this.maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
  }

  async list(scheduleId?: string): Promise<Run[]> {
    try {
      const { runs, bad } = parseRuns(await readFile(this.options.runsPath, "utf8"));
      await this.quarantine(bad);
      return scheduleId ? runs.filter((run) => run.scheduleId === scheduleId) : runs;
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT") return [];
      throw error;
    }
  }

  /** Back up each distinct bad line once (the next rewrite drops it from runs.jsonl) and keep going without it. */
  private async quarantine(bad: readonly string[]): Promise<void> {
    const fresh = bad.filter((line) => !this.quarantined.has(line));
    if (!fresh.length) return;
    for (const line of fresh) this.quarantined.add(line);
    try { await appendFile(`${this.options.runsPath}.corrupt`, fresh.map((line) => `${line}
`).join(""), "utf8"); }
    catch { /* best effort; the line is still skipped */ }
  }

  /**
   * Atomically (under the history lock) appends `run`, or `whenBusy` instead if the schedule already has
   * active or orphaned work. Returns the record that was written.
   */
  async appendUnlessBusy(run: Run, whenBusy: (run: Run) => Run): Promise<Run> {
    return withAdvisoryLock(this.options.lockPath, async () => {
      const runs = await this.list();
      const busy = runs.some((item) => item.scheduleId === run.scheduleId && (!isTerminalRunStatus(item.status) || item.status === "orphaned"));
      const record = busy ? whenBusy(run) : run;
      await this.writeAll(this.retain([...runs, record]));
      return record;
    });
  }

  async append(run: Run): Promise<void> {
    await withAdvisoryLock(this.options.lockPath, async () => {
      const runs = await this.list();
      const retained = this.retain([...runs, run]);
      await this.writeAll(retained);
    });
  }

  async transition(runId: string, to: RunStatus, at: string, details: Partial<Run> = {}): Promise<Run> {
    return withAdvisoryLock(this.options.lockPath, async () => {
      const runs = await this.list();
      const index = runs.findIndex((run) => run.runId === runId);
      if (index < 0) throw new Error(`Unknown run: ${runId}`);
      const updated = transitionRun(runs[index], to, at, details);
      runs[index] = updated;
      await this.writeAll(this.retain(runs));
      return updated;
    });
  }

  async appendEvent(runId: string, event: RunEvent): Promise<Run> {
    return withAdvisoryLock(this.options.lockPath, async () => {
      const runs = await this.list();
      const index = runs.findIndex((run) => run.runId === runId);
      if (index < 0) throw new Error(`Unknown run: ${runId}`);
      const updated = appendRunEvent(runs[index], event);
      runs[index] = updated;
      await this.writeAll(this.retain(runs));
      return updated;
    });
  }

  /** Cancellation and synchronous spawn authorization share the history lock. */
  async startQueued(runId: string, at: string, start: () => ProcessIdentity | undefined | false, details: Partial<Run> = {}): Promise<Run> {
    return withAdvisoryLock(this.options.lockPath, async () => {
      const runs = await this.list();
      const index = runs.findIndex((run) => run.runId === runId);
      if (index < 0 || runs[index].status !== "queued") throw new Error("Run is not queued");
      const run = runs[index];
      if (run.events.some((e) => e.type === "cancel_requested")) {
        runs[index] = transitionRun(run, "cancelled", at);
      } else {
        try {
          const identity = start();
          runs[index] = identity === false ? transitionRun(run, "cancelled", at) : transitionRun(run, "running", at, { ...details, processIdentity: identity });
        }
        catch (error) { runs[index] = transitionRun(run, "failed", at, { error: String(error) }); }
      }
      await this.writeAll(runs);
      return runs[index];
    });
  }

  /** A void ExtensionAPI call is submission, not proof that Pi started an agent. */
  async submitQueued(runId: string, at: string, submit: () => "submitted" | "busy" | false): Promise<Run> {
    return withAdvisoryLock(this.options.lockPath, async () => {
      const runs = await this.list();
      const index = runs.findIndex((run) => run.runId === runId);
      if (index < 0 || runs[index].status !== "queued") throw new Error("Run is not queued");
      const run = runs[index];
      if (run.events.some((event) => event.type === "cancel_requested")) {
        runs[index] = transitionRun(run, "cancelled", at);
      } else {
        try {
          const result = submit();
          runs[index] = result === false ? transitionRun(run, "cancelled", at)
            : result === "busy" ? transitionRun(run, "skipped_busy", at, { error: "Session became busy before prompt submission." })
            : appendRunEvent(run, { type: "diagnostic", at, detail: "session_prompt_submitted; awaiting owned message_start" });
        } catch (error) {
          runs[index] = transitionRun(run, "failed_preflight", at, { error: String(error) });
        }
      }
      await this.writeAll(this.retain(runs));
      return runs[index];
    });
  }

  async beginCancellation(runId: string, at: string): Promise<Run> {
    return withAdvisoryLock(this.options.lockPath, async () => {
      const runs = await this.list();
      const index = runs.findIndex((run) => run.runId === runId);
      if (index < 0) throw new Error(`Unknown run: ${runId}`);
      if (isTerminalRunStatus(runs[index].status) || runs[index].status === "cancelling") return runs[index];
      runs[index] = transitionRun(runs[index], "cancelling", at);
      await this.writeAll(runs);
      return runs[index];
    });
  }

  /** Final outcome and cancellation are resolved atomically, never using a stale status. */
  async finish(runId: string, outcome: "succeeded" | "failed" | "cancelled" | "failed_preflight" | "skipped_busy" | "orphaned", at: string, details: Partial<Run> = {}): Promise<Run> {
    return withAdvisoryLock(this.options.lockPath, async () => {
      const runs = await this.list();
      const index = runs.findIndex((run) => run.runId === runId);
      if (index < 0) throw new Error(`Unknown run: ${runId}`);
      const current = runs[index];
      if (isTerminalRunStatus(current.status)) {
        // A submission can already be terminal before profile cleanup runs.
        // Keep its immutable outcome, but do not lose a subsequent restore diagnostic.
        if (details.restoreError) {
          runs[index] = { ...current, restoreError: details.restoreError, effectiveProfile: details.effectiveProfile ?? current.effectiveProfile };
          await this.writeAll(this.retain(runs));
          return runs[index];
        }
        return current;
      }
      const cancelled = outcome !== "orphaned" && (current.status === "cancelling" || current.events.some((e) => e.type === "cancel_requested"));
      runs[index] = transitionRun(current, cancelled ? "cancelled" : outcome, at, { ...details, ...(cancelled ? { error: undefined } : {}) });
      await this.writeAll(this.retain(runs));
      return runs[index];
    });
  }

  async requestCancellation(runId: string, at: string): Promise<Run> {
    return withAdvisoryLock(this.options.lockPath, async () => {
      const runs = await this.list();
      const index = runs.findIndex((run) => run.runId === runId);
      if (index < 0) throw new Error(`Unknown run: ${runId}`);
      const run = runs[index];
      if (isTerminalRunStatus(run.status) || run.events.some((event) => event.type === "cancel_requested")) return run;
      runs[index] = appendRunEvent(run, { type: "cancel_requested", at });
      await this.writeAll(runs);
      return runs[index];
    });
  }

  private retain(runs: Run[]): Run[] {
    const recent = new Set(runs.slice(-this.maxHistory));
    // Orphan entries are safety barriers, not disposable history.
    return runs.filter((run) => recent.has(run) || !isTerminalRunStatus(run.status) || run.status === "orphaned");
  }

  async writeOutput(runId: string, stream: "stdout" | "stderr", output: string): Promise<string> {
    await mkdir(this.options.logsDir, { recursive: true });
    const path = join(this.options.logsDir, `${runId}.${stream}.log`);
    await writeFile(path, truncateOutput(output, this.maxOutputBytes), "utf8");
    return path;
  }

  private async writeAll(runs: readonly Run[]): Promise<void> {
    await atomicWriteFile(this.options.runsPath, runs.map((run) => JSON.stringify(run)).join("\n") + (runs.length ? "\n" : ""));
    // History commits first. Only canonical scheduler ULID (or legacy UUID) log names are owned;
    // never recurse, follow symlinks, or remove unrecognized files.
    try {
      const retained = new Set(runs.map((run) => run.runId.toLowerCase()));
      for (const file of await readdir(this.options.logsDir, { withFileTypes: true })) {
        const match = /^([0-9a-hjkmnp-tv-z]{26}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})\.(stdout|stderr)\.log$/i.exec(file.name);
        if (file.isFile() && match && !retained.has(match[1].toLowerCase())) await rm(join(this.options.logsDir, file.name), { force: true });
      }
      this.logCleanupError = undefined;
    } catch (error) {
      // Cleanup does not reclassify a completed business run; retry next write.
      this.logCleanupError = (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : String(error).slice(0, 4096);
    }
  }
}
