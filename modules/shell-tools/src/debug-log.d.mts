export declare const PROJECT_NAME: "pi-shell-tools";
export declare const MAX_LOG_TEXT_CHARS: number;
export declare const MAX_LOG_WAIT_MS: number;

export type FailureDetails =
  | { kind: "exception"; error: unknown }
  | { kind: "error-result"; result: unknown };

export interface FailureDebugLog {
  tool: "bash" | "powershell";
  toolCallId: string;
  cwd?: string;
  sessionId?: string;
  elapsedMs: number;
  input: unknown;
  failure: FailureDetails;
}

/** Returns the created path, or undefined if disabled or logging failed. */
export declare function writeFailureDebugLog(
  record: FailureDebugLog,
  options?: { homeDir?: string; maxWaitMs?: number },
): Promise<string | undefined>;
