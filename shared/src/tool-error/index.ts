// Agent-facing tool failures carry a stable code at the start of the message, because only `content` and `isError`
// reach the model (details and structuredContent do not). Format: `CODE: message`, e.g. `PTY_SESSION_EXITED: ...`.
// Existing modules keep their own codes (FORK_*, NOTE_*, OUTPUT_TOO_LARGE, ...); this is the shape new codes follow.

const CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** `CODE: message`, for failures a tool returns (with `isError: true`) instead of throwing. */
export function codedText(code: string, message: string): string {
  if (!CODE_PATTERN.test(code)) throw new TypeError(`Invalid tool error code: ${code}`);
  // Re-wrapping an already coded message (new ToolError(code, existing.message)) must not stack the prefix.
  return message.startsWith(`${code}: `) ? message : `${code}: ${message}`;
}

export class ToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(codedText(code, message), options);
    this.name = 'ToolError';
    this.code = code;
  }
}

/** Reads the code from a ToolError, or from a leading `CODE:` prefix of any error message; undefined when absent. */
export function toolErrorCode(error: unknown): string | undefined {
  if (error instanceof ToolError) return error.code;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /^([A-Z][A-Z0-9_]*): /.exec(message)?.[1];
}
