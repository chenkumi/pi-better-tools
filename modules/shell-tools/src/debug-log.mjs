import { ulid } from "ulid";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// A stable settings namespace, independent of the package name and session cwd.
export const PROJECT_NAME = "pi-shell-tools";
export const MAX_LOG_TEXT_CHARS = 65_536;
export const MAX_LOG_WAIT_MS = 2000;

function diagnosticReplacer() {
  const seen = new WeakSet();
  return (_key, value) => {
    if (typeof value === "string" && value.length > MAX_LOG_TEXT_CHARS) {
      const half = MAX_LOG_TEXT_CHARS / 2;
      return `${value.slice(0, half)}\n[... ${value.length - MAX_LOG_TEXT_CHARS} characters omitted ...]\n${value.slice(-half)}`;
    }
    if (typeof value === "bigint") return `${value}n`;
    if (typeof value === "number" && !Number.isFinite(value)) return String(value);
    if (value && typeof value === "object") {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
      if (value instanceof Error) {
        return {
          ...value,
          name: value.name,
          message: value.message,
          stack: value.stack,
          cause: value.cause,
          ...(value instanceof AggregateError ? { errors: value.errors } : {}),
        };
      }
    }
    return value;
  };
}

/** Best-effort opt-in diagnostics; never replace the original tool outcome. */
export async function writeFailureDebugLog(record, options = {}) {
  const maxWaitMs = options.maxWaitMs ?? MAX_LOG_WAIT_MS;
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs <= 0 || maxWaitMs > 2_147_483_647) return undefined;
  const controller = new AbortController();
  const { signal } = controller;
  let enabled = false;
  let timedOut = false;
  let timer;

  function warn(error) {
    if (!enabled) return; // Never expose diagnostics without confirmed opt-in.
    try {
      console.warn(`[${PROJECT_NAME}] Could not write failure debug log: ${error instanceof Error ? error.message : String(error)}`);
    } catch {
      // Even a host-provided console implementation must not mask tool errors.
    }
  }

  async function writeRecord() {
    try {
      const homeDir = options.homeDir ?? homedir();
      // This switch deliberately reads the requested global file, not Pi's
      // merged project settings, SDK overrides, or PI_CODING_AGENT_DIR.
      const settingsPath = join(homeDir, ".pi", "agent", "settings.json");
      const info = await stat(settingsPath);
      signal.throwIfAborted();
      if (!info.isFile()) return undefined; // Do not wait for FIFO/device input.
      const raw = await readFile(settingsPath, { encoding: "utf8", signal });
      signal.throwIfAborted();
      const settings = JSON.parse(raw.replace(/^\uFEFF/, ""));
      if (settings?.[PROJECT_NAME]?.debugLog !== true) return undefined;
      enabled = true;

      const timestamp = new Date().toISOString();
      const payload = JSON.stringify({
        schemaVersion: 1,
        timestamp,
        project: PROJECT_NAME,
        processId: process.pid,
        tool: record.tool,
        toolCallId: record.toolCallId,
        cwd: record.cwd,
        sessionId: record.sessionId,
        elapsedMs: record.elapsedMs,
        input: record.input,
        failure: record.failure,
      }, diagnosticReplacer(), 2) + "\n";
      signal.throwIfAborted();
      const directory = join(homeDir, ".pi", "logs", PROJECT_NAME);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      signal.throwIfAborted();
      // One unique file per failure avoids append interleaving and overwrites
      // across concurrent tools, sessions, and processes. No input forms a path.
      const logPath = join(directory, `${timestamp.replace(/[:.]/g, "-")}-${ulid().toLowerCase()}.json`);
      await writeFile(logPath, payload, { encoding: "utf8", flag: "wx", mode: 0o600, signal });
      return logPath;
    } catch (error) {
      // Missing/unreadable/invalid settings mean opt-in could not be confirmed.
      if (!timedOut) warn(error);
      return undefined;
    }
  }

  try {
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        const error = new Error(`diagnostic I/O exceeded ${maxWaitMs}ms`);
        controller.abort(error);
        warn(error);
        resolve(undefined);
      }, maxWaitMs);
    });
    // stat/mkdir cannot be cancelled at OS level. Return on the deadline and
    // check the signal after they settle so stale work cannot keep progressing.
    return await Promise.race([writeRecord(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
