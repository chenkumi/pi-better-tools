import { stripVTControlCharacters } from "node:util";

const safeDisplay = (text: string) => stripVTControlCharacters(text).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "");

export type FileToolErrorCode =
  | "INVALID_ARGUMENT"
  | "FILE_NOT_FOUND"
  | "FILE_NOT_READABLE"
  | "FILE_NOT_WRITABLE"
  | "FILE_TOO_LARGE"
  | "INVALID_ENCODING"
  | "SYMLINK_UNSUPPORTED"
  | "RANGE_OUT_OF_BOUNDS"
  | "TEXT_NOT_FOUND"
  | "TEXT_NOT_FOUND_IN_RANGE"
  | "AMBIGUOUS_MATCH"
  | "OVERLAPPING_EDITS"
  | "INVALID_REGEX"
  | "REGEX_TIMEOUT"
  | "OPERATION_TIMEOUT"
  | "TOO_MANY_MATCHES"
  | "RESULT_TOO_LARGE"
  | "STALE_FILE"
  | "FILE_ALREADY_EXISTS"
  | "NO_CHANGE"
  | "OPERATION_ABORTED"
  | "IO_ERROR";

export interface FileToolErrorPayload {
  status: "error";
  code: FileToolErrorCode;
  message: string;
  path?: string;
  editIndex?: number;
  lineStart?: number;
  lineEnd?: number;
  lineRange?: { start: number; end: number };
  expectedHash?: string;
  actualHash?: string;
  occurrences?: number;
  candidateRanges?: Array<{ start: number; end: number }>;
  rangePreview?: string;
  recovery?: string;
  causeCode?: string;
}

const FILE_TOOL_ERROR_MARKER = "[FILE_TOOL_ERROR]\n";
const FILE_TOOL_ERROR_CODES: ReadonlySet<string> = new Set<FileToolErrorCode>([
  "INVALID_ARGUMENT",
  "FILE_NOT_FOUND",
  "FILE_NOT_READABLE",
  "FILE_NOT_WRITABLE",
  "FILE_TOO_LARGE",
  "INVALID_ENCODING",
  "SYMLINK_UNSUPPORTED",
  "RANGE_OUT_OF_BOUNDS",
  "TEXT_NOT_FOUND",
  "TEXT_NOT_FOUND_IN_RANGE",
  "AMBIGUOUS_MATCH",
  "OVERLAPPING_EDITS",
  "INVALID_REGEX",
  "REGEX_TIMEOUT",
  "OPERATION_TIMEOUT",
  "TOO_MANY_MATCHES",
  "RESULT_TOO_LARGE",
  "STALE_FILE",
  "FILE_ALREADY_EXISTS",
  "NO_CHANGE",
  "OPERATION_ABORTED",
  "IO_ERROR",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileToolErrorCode(value: unknown): value is FileToolErrorCode {
  return typeof value === "string" && FILE_TOOL_ERROR_CODES.has(value);
}

function isIntegerAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function isLineRange(value: unknown): value is { start: number; end: number } {
  return isRecord(value) && isIntegerAtLeast(value.start, 1) && isIntegerAtLeast(value.end, value.start);
}

function truncateDisplayText(value: string, maxLength: number): string {
  const normalized = value.replace(/\r\n?/g, "\n");
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}…`;
}

function formatRange(range: { start: number; end: number }): string {
  return range.start === range.end ? `${range.start}` : `${range.start}–${range.end}`;
}

export function parseFileToolErrorText(text: string): FileToolErrorPayload | undefined {
  const markerIndex = text.indexOf(FILE_TOOL_ERROR_MARKER);
  if (markerIndex < 0) return undefined;

  try {
    const value: unknown = JSON.parse(text.slice(markerIndex + FILE_TOOL_ERROR_MARKER.length).trim());
    if (!isRecord(value) || value.status !== "error" || !isFileToolErrorCode(value.code) || typeof value.message !== "string") {
      return undefined;
    }

    // Only validated, known fields reach the formatter. Ignore additional fields
    // for compatibility, but reject the entire payload if a known field is malformed.
    const payload: FileToolErrorPayload = { status: "error", code: value.code, message: value.message };
    for (const field of ["path", "expectedHash", "actualHash", "rangePreview", "recovery", "causeCode"] as const) {
      if (!Object.hasOwn(value, field)) continue;
      const fieldValue = value[field];
      if (typeof fieldValue !== "string") return undefined;
      payload[field] = fieldValue;
    }
    for (const field of ["editIndex", "occurrences", "lineStart", "lineEnd"] as const) {
      if (!Object.hasOwn(value, field)) continue;
      const fieldValue = value[field];
      const minimum = field === "lineStart" || field === "lineEnd" ? 1 : 0;
      if (!isIntegerAtLeast(fieldValue, minimum)) return undefined;
      payload[field] = fieldValue;
    }
    if (payload.lineStart !== undefined && payload.lineEnd !== undefined && payload.lineEnd < payload.lineStart) {
      return undefined;
    }
    if (Object.hasOwn(value, "lineRange")) {
      if (!isLineRange(value.lineRange)) return undefined;
      payload.lineRange = { start: value.lineRange.start, end: value.lineRange.end };
    }
    if (Object.hasOwn(value, "candidateRanges")) {
      if (!Array.isArray(value.candidateRanges)) return undefined;
      const candidates: unknown[] = value.candidateRanges;
      payload.candidateRanges = [];
      for (const candidate of candidates) {
        if (!isLineRange(candidate)) return undefined;
        payload.candidateRanges.push({ start: candidate.start, end: candidate.end });
      }
    }
    return payload;
  } catch {
    return undefined;
  }
}

export function formatFileToolErrorForDisplay(text: string, expanded: boolean, tool: "read" | "write" | "edit" = "edit"): string {
  const payload = parseFileToolErrorText(text);
  const label = tool[0].toUpperCase() + tool.slice(1);
  if (!payload) {
    if (tool !== "edit" && text.includes(FILE_TOOL_ERROR_MARKER)) {
      return `✗ ${label} failed · error details unavailable\nMalformed or legacy file error. The original payload remains in the tool result.`;
    }
    return safeDisplay(text);
  }
  const lines = [`✗ ${label} failed · ${payload.code}`, truncateDisplayText(payload.message, 400)];
  if (payload.code === "INVALID_REGEX" && payload.message.includes("regexFlags")) {
    lines.push("Hint: regexFlags accepts only i, m, s, u; omit g and use replaceAll=true.");
  }
  if (!expanded) {
    if (tool !== "edit" && payload.recovery) lines.push(`Recovery: ${truncateDisplayText(payload.recovery, 400)}`);
    return safeDisplay(lines.join("\n"));
  }

  if (payload.path) lines.push(`Path: ${payload.path}`);
  if (payload.editIndex !== undefined) lines.push(`Edit: edits[${payload.editIndex}]`);
  const lineRange = payload.lineRange ?? (payload.lineStart !== undefined && payload.lineEnd !== undefined ? { start: payload.lineStart, end: payload.lineEnd } : undefined);
  if (lineRange) lines.push(`Line range: ${formatRange(lineRange)}`);
  if (payload.candidateRanges && payload.candidateRanges.length > 0) {
    lines.push(`Candidates: ${payload.candidateRanges.map(formatRange).join(", ")}`);
  }
  if (payload.rangePreview) lines.push(`Preview:\n${truncateDisplayText(payload.rangePreview, 1200)}`);
  if (payload.recovery) lines.push(`Recovery: ${truncateDisplayText(payload.recovery, 400)}`);
  return safeDisplay(lines.join("\n"));
}

export class FileToolError extends Error {
  readonly payload: FileToolErrorPayload;

  constructor(code: FileToolErrorCode, message: string, details: Omit<Partial<FileToolErrorPayload>, "status" | "code" | "message"> = {}) {
    const payload: FileToolErrorPayload = { status: "error", code, message, ...details };
    super(`[FILE_TOOL_ERROR]\n${JSON.stringify(payload, null, 2)}`);
    this.name = "FileToolError";
    this.payload = payload;
  }
}

export function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new FileToolError("OPERATION_ABORTED", "The file operation was aborted.", {
      recovery: "Retry after confirming the current file contents.",
    });
  }
}

export function classifyFsError(error: unknown, path: string, operation: "read" | "write" | "edit"): FileToolError {
  if (error instanceof FileToolError) return error;

  const causeCode =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  const causeMessage = error instanceof Error ? error.message : String(error);

  if (error instanceof Error && error.name === "AbortError") {
    return new FileToolError("OPERATION_ABORTED", "The file operation was aborted.", {
      path,
      recovery: "Retry after confirming the current file contents.",
    });
  }

  if (causeCode === "ENOENT" || causeCode === "ENOTDIR") {
    return new FileToolError("FILE_NOT_FOUND", `Cannot ${operation} because the target file does not exist.`, {
      path,
      causeCode,
      recovery: operation === "write" ? "Omit expectedHash or use expectedHash=\"missing\" to create a new file." : "Check the path and read the file again.",
    });
  }
  if (causeCode === "EACCES" || causeCode === "EPERM") {
    return new FileToolError(operation === "read" ? "FILE_NOT_READABLE" : "FILE_NOT_WRITABLE", `Cannot ${operation} the target file due to filesystem permissions.`, {
      path,
      causeCode,
      recovery: "Check file permissions and whether another process has locked the file.",
    });
  }

  return new FileToolError("IO_ERROR", `Filesystem operation failed: ${causeMessage}`, {
    path,
    causeCode,
    recovery: "Inspect the path and filesystem state, then retry after reading the file again.",
  });
}
