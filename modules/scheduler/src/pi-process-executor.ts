import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";

import type { ExecutionProfile, ProcessIdentity, Schedule } from "./domain.js";
import type { ChildSpawner, PiCommandResolver, SpawnedProcess } from "./runtime-deps.js";
import { capturePiStream, PiOutputDiagnostics } from "./pi-output.js";
import { normalizeAgentDir, resolveAgentDir } from "./paths.js";

export interface PiExecutionRequest {
  runId: string;
  schedule: Pick<Schedule, "title" | "prompt" | "cwd" | "execution" | "projectTrust">;
}

export interface StartedPiProcess {
  process: SpawnedProcess;
  args: string[];
  identity: ProcessIdentity | undefined;
  completion: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; error?: Error }>;
  output: Promise<[string, string]>;
  diagnostics: [PiOutputDiagnostics, PiOutputDiagnostics];
  piVersion: string;
}

export interface PiProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  piErrors: string[];
  actualModel?: { provider: string; model: string };
  ownershipUnknown: boolean;
}

function quoteCommandToken(value: string): string {
  return /[\s"]/u.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/** Stable fingerprint used for the exact command line persisted with a child identity. */
export function commandFingerprint(command: string, args: readonly string[]): string {
  const line = [command, ...args].map(quoteCommandToken).join(" ").trim().toLowerCase();
  return createHash("sha256").update(line).digest("hex");
}

/** Windows-compatible enough for our own argv-shaped command line comparisons. */
export function splitCommandLine(commandLine: string): string[] {
  const parts: string[] = [];
  const matcher = /(?:"((?:\\.|[^"])*)")|([^\s]+)/g;
  for (const match of commandLine.trim().matchAll(matcher)) parts.push((match[1] ?? match[2] ?? "").replace(/\\"/g, '"'));
  return parts;
}

export function commandLineFingerprint(commandLine: string): string {
  const argv = splitCommandLine(commandLine);
  return commandFingerprint(argv[0] ?? "", argv.slice(1));
}

export function buildPiArgs(request: PiExecutionRequest): string[] {
  const profile: ExecutionProfile | undefined = request.schedule.execution;
  return [
    "--mode", "json", "-p", "--name", request.schedule.title ?? `scheduler-${request.runId}`,
    ...(profile?.provider ? ["--provider", profile.provider, "--model", profile.model!] : []),
    ...(profile?.thinkingLevel ? ["--thinking", profile.thinkingLevel] : []),
    ...(request.schedule.projectTrust ? ["--approve"] : []),
    // Opaque task text is piped via stdin, never interpreted as an @attachment
    // or squeezed into Windows' command-line length limit.
  ];
}

export function extractPiErrors(stdout: string, stderr: string): string[] {
  const out = new PiOutputDiagnostics(), err = new PiOutputDiagnostics();
  out.feed(stdout); out.end(); err.feed(stderr); err.end();
  return [...out.result(), ...err.result()];
}

export class PiProcessExecutor {
  constructor(private readonly resolver: PiCommandResolver, private readonly spawner: ChildSpawner, private readonly now = () => new Date().toISOString(), private readonly agentDir?: string) {}

  start(request: PiExecutionRequest): StartedPiProcess {
    const target = this.resolver.resolve();
    const args = [...(target.args ?? []), ...buildPiArgs(request)];
    const agentDir = this.agentDir === undefined ? resolveAgentDir() : normalizeAgentDir(this.agentDir);
    const process = this.spawner.spawn({ command: target.command, args, cwd: request.schedule.cwd, stdin: request.schedule.prompt,
      env: { ...globalThis.process.env, PI_SCHEDULER_CHILD: "1", PI_CODING_AGENT_DIR: agentDir, PI_AGENT_DIR: agentDir } });
    const diagnostics: [PiOutputDiagnostics, PiOutputDiagnostics] = [new PiOutputDiagnostics(), new PiOutputDiagnostics()];
    const completion = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
      // Attach immediately: a Windows command-resolution failure can emit before
      // the runner has persisted the running transition and called wait().
      process.child.once("error", (error) => resolve({ exitCode: null, signal: null, error }));
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      process.child.once("exit", (exitCode, signal) => {
        // Descendants can retain inherited stdio after the owned child has exited.
        drainTimer = setTimeout(() => {
          diagnostics[0].ownershipUnknown = true;
          diagnostics[0].addError("Pi child exited but output pipes did not close within 1500 ms; descendant ownership is unknown.");
          process.child.stdout?.destroy(); process.child.stderr?.destroy();
          resolve({ exitCode, signal });
        }, 1500);
        drainTimer.unref();
      });
      process.child.once("close", (exitCode, signal) => { if (drainTimer) clearTimeout(drainTimer); resolve({ exitCode, signal }); });
    });
    return {
      process,
      args,
      completion,
      diagnostics,
      piVersion: target.version ?? "unknown",
      output: Promise.all([capturePiStream(process.child.stdout, diagnostics[0]), capturePiStream(process.child.stderr, diagnostics[1])]),
      identity: process.pid === undefined ? undefined : {
        pid: process.pid,
        startedAt: this.now(),
        commandFingerprint: commandFingerprint(target.command, args),
      },
    };
  }

  async wait(started: StartedPiProcess): Promise<PiProcessResult> {
    const [[stdout, stderr], exit] = await Promise.all([started.output, started.completion]);
    const spawnError = exit.error?.message;
    return {
      exitCode: exit.exitCode,
      signal: exit.signal,
      stdout,
      stderr,
      piErrors: [...(spawnError ? [spawnError] : []), ...started.diagnostics[0].result(!spawnError), ...started.diagnostics[1].result()],
      actualModel: started.diagnostics[0].actualModel,
      ownershipUnknown: started.diagnostics[0].ownershipUnknown,
    };
  }

  async execute(request: PiExecutionRequest): Promise<{ started: StartedPiProcess; result: PiProcessResult }> {
    const started = this.start(request);
    return { started, result: await this.wait(started) };
  }

  terminate(started: StartedPiProcess): boolean {
    return started.process.child.kill("SIGTERM");
  }
}

export type ChildProcessLike = Pick<ChildProcess, "kill">;
