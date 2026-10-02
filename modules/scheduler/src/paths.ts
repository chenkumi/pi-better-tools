import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const SCHEDULER_DIRECTORY_NAME = "pi-scheduler";

export interface SchedulerPaths {
  readonly agentDir: string;
  readonly rootDir: string;
  readonly registryPath: string;
  readonly runsPath: string;
  readonly lockPath: string;
  readonly logsDir: string;
}

/**
 * Pi's agent directory can be injected by a launcher/test. The default mirrors
 * Pi's global configuration location without requiring the standalone runner
 * to import Pi runtime modules.
 */
export function normalizeAgentDir(agentDir: string): string {
  const expanded = agentDir === "~" ? homedir() : /^~[/\\\\]/u.test(agentDir) ? join(homedir(), agentDir.slice(2)) : agentDir;
  return resolve(expanded);
}

export function resolveAgentDir(environment: NodeJS.ProcessEnv = process.env): string {
  return normalizeAgentDir(environment.PI_AGENT_DIR || environment.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
}

export function resolveSchedulerPaths(agentDir = resolveAgentDir()): SchedulerPaths {
  agentDir = normalizeAgentDir(agentDir);
  const rootDir = join(agentDir, SCHEDULER_DIRECTORY_NAME);
  return {
    agentDir,
    rootDir,
    registryPath: join(rootDir, "registry.json"),
    runsPath: join(rootDir, "runs.jsonl"),
    lockPath: join(rootDir, "registry.lock"),
    logsDir: join(rootDir, "logs"),
  };
}
