import { ulid } from "ulid";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SCHEDULER_DIRECTORY_NAME } from "./paths.js";

/** Opt-in, best-effort diagnostics. Never persist tool arguments or prompts. */
export class ToolDebugLogger {
  constructor(private readonly homeDir = homedir()) {}

  async logFailure(toolName: string, toolCallId: string, error: unknown): Promise<void> {
    try {
      // Deliberately read the requested global file, not cwd/project settings or
      // scheduler state. Re-read on every failure so toggling needs no reload.
      const settings: unknown = JSON.parse(await readFile(join(this.homeDir, ".pi", "agent", "settings.json"), "utf8"));
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) return;
      const project = (settings as Record<string, unknown>)[SCHEDULER_DIRECTORY_NAME];
      if (!project || typeof project !== "object" || Array.isArray(project)
        || (project as Record<string, unknown>).debugLog !== true) return;

      const timestamp = new Date().toISOString();
      const record = {
        schemaVersion: 1,
        timestamp,
        project: SCHEDULER_DIRECTORY_NAME,
        toolName: toolName.slice(0, 128),
        toolCallId: toolCallId.slice(0, 512),
        pid: process.pid,
        error: error instanceof Error ? {
          name: error.name.slice(0, 128),
          message: error.message.slice(0, 4096),
          stack: error.stack?.slice(0, 16_384),
        } : { name: "NonError", message: String(error).slice(0, 4096) },
      };
      const directory = join(this.homeDir, ".pi", "logs", SCHEDULER_DIRECTORY_NAME);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // Exclusive, collision-resistant files avoid shared append locks across hosts.
      const file = `${timestamp.replace(/[:.]/gu, "-")}-${ulid().toLowerCase()}.log`;
      await writeFile(join(directory, file), JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    } catch {
      // Missing/invalid settings or diagnostic IO must not mask the tool failure.
    }
  }
}
