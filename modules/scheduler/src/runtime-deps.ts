import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Dependencies that need platform or clock effects are injected behind these contracts. */
export interface Clock {
  now(): Date;
}

export interface TimerHandle {
  clear(): void;
}

export interface TimerFactory {
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
}

export interface SpawnRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Literal opaque prompt input; avoids CLI @file argument interpretation. */
  stdin?: string;
}

export interface SpawnedProcess {
  readonly child: ChildProcess;
  readonly pid: number | undefined;
}

export interface ChildSpawner {
  spawn(request: SpawnRequest): SpawnedProcess;
}

export interface PiCommand {
  command: string;
  args?: readonly string[];
  /** Read from the resolved installation, not assumed equal to the host SDK. */
  version?: string;
}

export interface PiCommandResolver {
  resolve(): PiCommand;
}

export interface ProcessIdentitySnapshot {
  pid: number;
  startedAt: string;
  commandLine: string;
}

export interface ProcessInspector {
  inspect(pid: number): Promise<ProcessIdentitySnapshot | undefined>;
}

export interface ProcessTerminator {
  terminateTree(pid: number): Promise<void>;
}

export interface CommandRunnerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options?: { cwd?: string }): Promise<CommandRunnerResult>;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export const nodeChildSpawner: ChildSpawner = {
  spawn(request) {
    const child = nodeSpawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: request.env,
      stdio: [request.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (request.stdin !== undefined) {
      child.stdin!.once("error", (error) => child.emit("error", error));
      child.stdin!.end(request.stdin);
    }
    return { child, pid: child.pid };
  },
};

export const environmentPiCommandResolver: PiCommandResolver = {
  resolve: () => {
    const configured = process.env.PI_COMMAND?.trim();
    if (configured) return { command: configured };

    // npm's Windows `pi.cmd` shim cannot be spawned directly by Node without a shell.
    // Invoke its installed JavaScript entry through the current Node executable instead.
    if (process.platform === "win32" && process.env.APPDATA) {
      const cliPath = join(process.env.APPDATA, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
      if (existsSync(cliPath)) {
        let version: string | undefined;
        try { const metadata = JSON.parse(readFileSync(join(cliPath, "../../../package.json"), "utf8")); if (typeof metadata.version === "string") version = metadata.version; }
        catch { /* Custom/corrupt installs remain explicitly unknown in diagnostics. */ }
        return { command: process.execPath, args: [cliPath], version };
      }
    }
    return { command: "pi" };
  },
};

export const nodeCommandRunner: CommandRunner = {
  async run(command, args, options) {
    return new Promise<CommandRunnerResult>((resolve, reject) => {
      const child = nodeSpawn(command, [...args], { cwd: options?.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (exitCode) => resolve({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }));
    });
  },
};
