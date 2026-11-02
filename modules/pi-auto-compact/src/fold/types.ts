export interface ToolCallInfo {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * Only what the session actually persists on a toolResult message. `structuredContent` is not persisted, so a rule must work
 * from the text and `details`.
 */
export interface ToolResultInfo {
  /** Session entry id; becomes the recall id. Absent when the result is not part of a session entry. */
  entryId?: string;
  text: string;
  details?: unknown;
  isError: boolean;
  durationMs?: number;
}

/**
 * - `text`: failures show a bounded excerpt of the result text (default).
 * - `own`: the rule decides, because a failure is a normal outcome (a command that exits non-zero).
 * - `hidden`: never show the result text (secrets).
 */
export type ErrorMode = 'text' | 'own' | 'hidden';

export interface FoldRule {
  /** Shown in brackets; defaults to the tool name. */
  label?: string;
  /** Key call arguments, already bounded and masked. */
  args: (call: ToolCallInfo) => string;
  /** Outcome of a successful call. */
  ok: (call: ToolCallInfo, result: ToolResultInfo) => string;
  errors?: ErrorMode;
  /** Longest error excerpt; defaults to 400. */
  errorMax?: number;
}
