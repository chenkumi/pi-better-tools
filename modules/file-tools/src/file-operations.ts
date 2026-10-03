import { createHash } from "node:crypto";
import { ulid } from "ulid";
import { constants as fsConstants } from "node:fs";
import { access, link, lstat, mkdir, open, readFile, rename, rmdir, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { Worker } from "node:worker_threads";
import { createDiffFeedback } from "./diff-runner.js";
import { FileToolError, abortIfRequested, classifyFsError } from "./errors.js";

export const MAX_OUTPUT_LINES = 2000;
export const MAX_OUTPUT_BYTES = 50 * 1024;
export const MAX_ERROR_PREVIEW_LINES = 20;
export const MAX_ERROR_PREVIEW_BYTES = 4 * 1024;
export const MAX_REGEX_PATTERN_LENGTH = 4096;
export const MAX_REGEX_MATCHES = 10_000;
export const MAX_EDIT_MATCHES = 20_000;
export const MAX_EDIT_RESULT_BYTES = 50 * 1024 * 1024;
export const MAX_INPUT_BYTES = 50 * 1024 * 1024;
export const MAX_EDIT_OPERATIONS = 100;
export const MAX_EDIT_DURATION_MS = 10_000;
export const REGEX_TIMEOUT_MS = 1000;
const REGEX_STARTUP_GRACE_MS = 2000;
export const MAX_CANDIDATE_RANGES = 20;
export const SHA256_TOKEN_LENGTH = 32;

export interface TruncationDetails {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  lastLinePartial: false;
  firstLineExceedsLimit: boolean;
  maxLines: number;
  maxBytes: number;
}

export interface ReadTextResult {
  text: string;
  details: {
    truncation?: TruncationDetails;
    path: string;
    sha256: string;
    totalLines: number;
    lineStart: number;
    lineEnd: number;
  };
}

export interface WriteResult {
  path: string;
  sha256: string;
  bytes: number;
  created: boolean;
}

export interface LineRange {
  start: number;
  end: number;
}

export interface EditOperation {
  oldText?: string;
  regex?: string;
  regexFlags?: string;
  newText: string;
  lineRange?: LineRange;
  replaceAll?: boolean;
  replacementMode?: "literal" | "template";
}

export type RangeEdit = EditOperation;

export interface EditResult {
  path: string;
  sha256Before: string;
  sha256After: string;
  appliedEdits: number;
  matchedCount: number;
  changedCount: number;
  diff: string;
  patch: string;
  firstChangedLine?: number;
  changedRanges: Array<{
    editIndex: number;
    matchIndex: number;
    requestedLineRange?: LineRange;
    matchedLineStart: number;
    matchedLineEnd: number;
  }>;
}

interface LineMap {
  text: string;
  starts: number[];
}

interface NormalizedView {
  text: string;
  /** Sorted normalized offsets of each "\n" that was collapsed from a raw "\r\n". */
  crlfOffsets: number[];
}

interface MutationSnapshot {
  exists: boolean;
  buffer?: Buffer;
  hash?: string;
  mode?: number;
}

interface RegexMatch {
  index: number;
  text: string;
  captures: Array<string | undefined>;
  groups?: Record<string, string | undefined>;
}

interface MatchedEdit {
  editIndex: number;
  matchIndex: number;
  requestedLineRange?: LineRange;
  matchStart: number;
  matchEnd: number;
  rawStart: number;
  rawEnd: number;
  matchedText: string;
  replacement: string;
  changed: boolean;
  matchedLineStart: number;
  matchedLineEnd: number;
}

export function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Return the first 128 bits of a SHA-256 digest as a compact version token. */
export function sha256Token(content: Buffer | string): string {
  return sha256(content).slice(0, SHA256_TOKEN_LENGTH);
}

function shortenHash(hash: string | undefined): string | undefined {
  return hash && hash.length > SHA256_TOKEN_LENGTH ? hash.slice(0, SHA256_TOKEN_LENGTH) : hash;
}

export function assertInputSize(size: number, displayPath: string): void {
  if (size > MAX_INPUT_BYTES) {
    throw new FileToolError("FILE_TOO_LARGE", `The file exceeds the ${MAX_INPUT_BYTES}-byte processing limit.`, {
      path: displayPath,
      recovery: `Reduce the file below ${MAX_INPUT_BYTES} bytes or use a streaming/binary-aware tool.`,
    });
  }
}

export function assertValidUtf16(text: string, displayPath: string, editIndex?: number): void {
  assertValidUtf16Range(text, 0, text.length, displayPath, editIndex);
}

/** Validate code units in [from, to), consulting neighbors outside the range for pairing. */
function assertValidUtf16Range(text: string, from: number, to: number, displayPath: string, editIndex?: number): void {
  const start = Math.max(0, from);
  const end = Math.min(text.length, to);
  for (let index = start; index < end; index++) {
    const code = text.charCodeAt(index);
    const unpaired = code >= 0xd800 && code <= 0xdbff
      ? !(index + 1 < text.length && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff)
      : code >= 0xdc00 && code <= 0xdfff
        ? !(index > 0 && text.charCodeAt(index - 1) >= 0xd800 && text.charCodeAt(index - 1) <= 0xdbff)
        : false;
    if (unpaired) {
      throw new FileToolError("INVALID_ARGUMENT", "The supplied text contains an unpaired UTF-16 surrogate and cannot be represented exactly as UTF-8.", {
        path: displayPath,
        ...(editIndex === undefined ? {} : { editIndex }),
        recovery: "Provide valid Unicode scalar values instead of lone UTF-16 surrogates.",
      });
    }
  }
}

function assertEditDeadline(deadline: number, displayPath: string, editIndex?: number): void {
  if (Date.now() > deadline) {
    throw new FileToolError("OPERATION_TIMEOUT", "The edit operation exceeded its total validation time limit.", {
      path: displayPath,
      ...(editIndex === undefined ? {} : { editIndex }),
      recovery: "Split the edit into smaller operations or narrow the search scope.",
    });
  }
}

export function decodeUtf8(buffer: Buffer, displayPath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    throw new FileToolError("INVALID_ENCODING", "The file is not valid UTF-8 and cannot be safely processed as text.", {
      path: displayPath,
      recovery: "Use a binary-aware tool or convert the file to valid UTF-8 before editing it.",
    });
  }
}

export function splitBom(text: string): { bom: string; text: string } {
  return text.startsWith("\uFEFF") ? { bom: "\uFEFF", text: text.slice(1) } : { bom: "", text };
}

export function normalizeLf(text: string): string {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

function createNormalizedView(raw: string): NormalizedView {
  // Avoid a per-character offset table: only CRLF collapses shift offsets (a lone CR maps 1:1).
  if (!raw.includes("\r")) return { text: raw, crlfOffsets: [] };
  const crlfOffsets: number[] = [];
  for (let index = raw.indexOf("\r\n"); index !== -1; index = raw.indexOf("\r\n", index + 2)) {
    crlfOffsets.push(index - crlfOffsets.length);
  }
  return { text: normalizeLf(raw), crlfOffsets };
}

/** Map a normalized offset (0..text.length) to the start of the same position in the raw text. */
function rawOffsetFor(view: NormalizedView, offset: number): number {
  let low = 0;
  let high = view.crlfOffsets.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (view.crlfOffsets[middle] < offset) low = middle + 1;
    else high = middle;
  }
  return offset + low;
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + needle.length)) count++;
  return count;
}

function preferredLineEnding(raw: string): "\n" | "\r\n" | "\r" {
  if (!raw.includes("\r")) return "\n";
  const crlfCount = countOccurrences(raw, "\r\n");
  const lfCount = countOccurrences(raw, "\n") - crlfCount;
  const crCount = countOccurrences(raw, "\r") - crlfCount;
  if (crlfCount > lfCount && crlfCount >= crCount) return "\r\n";
  if (crCount > lfCount && crCount > crlfCount) return "\r";
  return "\n";
}

function restoreNewTextLineEndings(text: string, ending: "\n" | "\r\n" | "\r"): string {
  const normalized = normalizeLf(text);
  if (ending === "\r\n") return normalized.replace(/\n/g, "\r\n");
  if (ending === "\r") return normalized.replace(/\n/g, "\r");
  return normalized;
}

function buildLineMap(content: string): LineMap {
  // Record line starts only; materializing every line string is costly for large files.
  const starts = [0];
  for (let index = content.indexOf("\n"); index !== -1; index = content.indexOf("\n", index + 1)) starts.push(index + 1);
  return { text: content, starts };
}

function lineCount(map: LineMap): number {
  return map.starts.length;
}

/** Offset just past the content of 0-based line `index`, excluding its "\n". */
function lineContentEnd(map: LineMap, index: number): number {
  return index + 1 < map.starts.length ? map.starts[index + 1] - 1 : map.text.length;
}

function lineForOffset(map: LineMap, offset: number): number {
  let low = 0;
  let high = map.starts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (map.starts[middle] <= offset) low = middle + 1;
    else high = middle - 1;
  }
  return Math.max(1, high + 1);
}

function collectLiteralMatches(
  haystack: string,
  needle: string,
  displayPath: string,
  editIndex: number,
  maxMatches = MAX_REGEX_MATCHES,
): RegexMatch[] {
  const matches: RegexMatch[] = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    matches.push({ index, text: needle, captures: [] });
    if (matches.length > maxMatches) {
      throw new FileToolError("TOO_MANY_MATCHES", `edits[${editIndex}] exceeded the match limit.`, {
        path: displayPath,
        editIndex,
        occurrences: matches.length,
        recovery: "Narrow lineRange, use a more specific oldText, or split the operation.",
      });
    }
    // Intentionally step by one so overlapping occurrences count as ambiguous / OVERLAPPING_EDITS.
    from = index + 1;
  }
  return matches;
}

const REGEX_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
try {
  parentPort.postMessage({ type: "started" });
  const expression = new RegExp(workerData.pattern, workerData.flags + "g");
  const matches = [];
  let payloadBytes = 0;
  let tooMany = false;
  let tooLarge = false;
  while (true) {
    const match = expression.exec(workerData.text);
    if (match === null) break;
    const captures = Array.prototype.slice.call(match, 1);
    const groups = match.groups;
    payloadBytes += Buffer.byteLength(match[0], "utf8");
    for (const capture of captures) if (capture !== undefined) payloadBytes += Buffer.byteLength(capture, "utf8");
    if (groups) for (const value of Object.values(groups)) if (value !== undefined) payloadBytes += Buffer.byteLength(value, "utf8");
    if (payloadBytes > workerData.maxPayloadBytes) {
      tooLarge = true;
      break;
    }
    matches.push({ index: match.index, text: match[0], captures, groups });
    if (matches.length > workerData.maxMatches) {
      tooMany = true;
      break;
    }
    if (match[0] === "") {
      const index = expression.lastIndex;
      if (expression.unicode && index < workerData.text.length) {
        const first = workerData.text.charCodeAt(index);
        const second = index + 1 < workerData.text.length ? workerData.text.charCodeAt(index + 1) : 0;
        expression.lastIndex += first >= 0xD800 && first <= 0xDBFF && second >= 0xDC00 && second <= 0xDFFF ? 2 : 1;
      } else {
        expression.lastIndex += 1;
      }
    }
  }
  parentPort.postMessage(
    tooLarge
      ? { type: "too_large" }
      : tooMany
        ? { type: "too_many", count: matches.length }
        : { type: "matches", matches },
  );
} catch (error) {
  parentPort.postMessage({ type: "invalid", message: error instanceof Error ? error.message : String(error) });
}
`;

function validateRegexConfiguration(pattern: string, flags: string, displayPath: string, editIndex: number): void {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    throw new FileToolError("INVALID_REGEX", `edits[${editIndex}].regex exceeds the pattern length limit.`, {
      path: displayPath,
      editIndex,
      recovery: `Use a regex no longer than ${MAX_REGEX_PATTERN_LENGTH} UTF-16 code units.`,
    });
  }
  if (!/^[imsu]*$/.test(flags) || new Set(flags).size !== flags.length) {
    throw new FileToolError("INVALID_REGEX", `edits[${editIndex}].regexFlags contains unsupported or duplicate flags.`, {
      path: displayPath,
      editIndex,
      recovery: "Use each of i, m, s, and u at most once. replaceAll controls global matching.",
    });
  }
  try {
    new RegExp(pattern, flags);
  } catch (error) {
    throw new FileToolError("INVALID_REGEX", `edits[${editIndex}].regex is invalid: ${error instanceof Error ? error.message : String(error)}`, {
      path: displayPath,
      editIndex,
      recovery: "Correct the ECMAScript regular expression and retry.",
    });
  }
}

async function collectRegexMatches(
  text: string,
  pattern: string,
  flags: string,
  displayPath: string,
  editIndex: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RegexMatch[]> {
  validateRegexConfiguration(pattern, flags, displayPath, editIndex);
  abortIfRequested(signal);
  if (timeoutMs <= 0) {
    throw new FileToolError("REGEX_TIMEOUT", `edits[${editIndex}].regex exceeded the execution time limit.`, {
      path: displayPath,
      editIndex,
      recovery: "Use a simpler regex, narrow lineRange, or use literal oldText.",
    });
  }

  return new Promise<RegexMatch[]>((resolve, reject) => {
    const worker = new Worker(REGEX_WORKER_SOURCE, {
      eval: true,
      workerData: {
        text,
        pattern,
        flags,
        maxMatches: MAX_REGEX_MATCHES,
        maxPayloadBytes: MAX_EDIT_RESULT_BYTES,
      },
    });
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate().then(action, action);
    };
    const onAbort = () => finish(() => reject(new FileToolError("OPERATION_ABORTED", "The edit operation was aborted.", {
      path: displayPath,
      editIndex,
      recovery: "Read the file again before retrying the edit.",
    })));
    const onTimeout = () => finish(() => reject(new FileToolError("REGEX_TIMEOUT", `edits[${editIndex}].regex exceeded the execution time limit.`, {
      path: displayPath,
      editIndex,
      recovery: "Use a simpler regex, narrow lineRange, or use literal oldText.",
    })));
    // Worker start-up and the structured clone of a large text are not regex time: the
    // execution budget restarts when the worker reports it began, bounded by a start-up grace.
    timer = setTimeout(onTimeout, timeoutMs + REGEX_STARTUP_GRACE_MS);

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    worker.on("message", (message: { type?: string; matches?: RegexMatch[]; count?: number; message?: string }) => {
      if (message.type === "started") {
        if (!settled) {
          clearTimeout(timer);
          timer = setTimeout(onTimeout, timeoutMs);
        }
      } else if (message.type === "matches" && Array.isArray(message.matches)) {
        finish(() => resolve(message.matches!));
      } else if (message.type === "too_many") {
        finish(() => reject(new FileToolError("TOO_MANY_MATCHES", `edits[${editIndex}] exceeded the match limit.`, {
          path: displayPath,
          editIndex,
          occurrences: message.count,
          recovery: "Narrow lineRange, use a more specific regex, or split the operation.",
        })));
      } else if (message.type === "too_large") {
        finish(() => reject(new FileToolError("RESULT_TOO_LARGE", `edits[${editIndex}].regex produced too much captured match data.`, {
          path: displayPath,
          editIndex,
          recovery: "Use smaller capture groups, a narrower lineRange, or literal oldText.",
        })));
      } else {
        finish(() => reject(new FileToolError("INVALID_REGEX", `edits[${editIndex}].regex is invalid: ${message.message ?? "unknown regex error"}`, {
          path: displayPath,
          editIndex,
          recovery: "Correct the ECMAScript regular expression and retry.",
        })));
      }
    });
    worker.once("error", (error) => finish(() => reject(new FileToolError("IO_ERROR", `Regex worker failed: ${error.message}`, {
      path: displayPath,
      editIndex,
      recovery: "Retry the operation or use literal oldText.",
    }))));
    worker.once("exit", (code) => {
      if (!settled && code !== 0) {
        finish(() => reject(new FileToolError("IO_ERROR", `Regex worker exited with code ${code}.`, {
          path: displayPath,
          editIndex,
          recovery: "Retry the operation or use literal oldText.",
        })));
      }
    });
  });
}

function expandReplacementTemplate(
  template: string,
  match: RegexMatch,
  input: string,
  displayPath: string,
  editIndex: number,
): string {
  const output: string[] = [];
  let outputBytes = 0;
  const append = (value: string) => {
    outputBytes += Buffer.byteLength(value, "utf8");
    if (outputBytes > MAX_EDIT_RESULT_BYTES) {
      throw new FileToolError("RESULT_TOO_LARGE", `edits[${editIndex}] produced an oversized replacement.`, {
        path: displayPath,
        editIndex,
        recovery: "Reduce replacement size or avoid expansive $` and $' template tokens.",
      });
    }
    output.push(value);
  };

  const tokenPattern = /\$([$&'`]|\d{1,2}|<[^>]*>)/g;
  let cursor = 0;
  while (true) {
    const tokenMatch = tokenPattern.exec(template);
    if (!tokenMatch) break;
    append(template.slice(cursor, tokenMatch.index));
    const token = tokenMatch[0];
    const reference = tokenMatch[1];
    if (reference === "$") append("$");
    else if (reference === "&") append(match.text);
    else if (reference === "`") append(input.slice(0, match.index));
    else if (reference === "'") append(input.slice(match.index + match.text.length));
    else if (reference.startsWith("<")) {
      const name = reference.slice(1, -1);
      append(match.groups ? (Object.hasOwn(match.groups, name) ? match.groups[name] ?? "" : "") : token);
    } else {
      let captureIndex = Number(reference);
      if (captureIndex > match.captures.length && reference.length === 2) {
        captureIndex = Number(reference[0]);
        if (captureIndex >= 1 && captureIndex <= match.captures.length) {
          append(`${match.captures[captureIndex - 1] ?? ""}${reference[1]}`);
          cursor = tokenPattern.lastIndex;
          continue;
        }
      }
      append(captureIndex >= 1 && captureIndex <= match.captures.length ? match.captures[captureIndex - 1] ?? "" : token);
    }
    cursor = tokenPattern.lastIndex;
  }
  append(template.slice(cursor));
  return output.join("");
}

function numberedLines(lines: string[], firstLine: number): string {
  const lastLine = firstLine + Math.max(0, lines.length - 1);
  const width = String(lastLine).length;
  return lines.map((line, index) => `${String(firstLine + index).padStart(width, " ")}│${line}`).join("\n");
}

function truncateCompleteLines(content: string, maxLines = MAX_OUTPUT_LINES, maxBytes = MAX_OUTPUT_BYTES): TruncationDetails {
  const lines = content.split("\n");
  const totalBytes = Buffer.byteLength(content, "utf8");
  const firstLineBytes = Buffer.byteLength(lines[0] ?? "", "utf8");
  if (firstLineBytes > maxBytes) {
    return {
      content: "",
      truncated: true,
      truncatedBy: "bytes",
      totalLines: lines.length,
      totalBytes,
      outputLines: 0,
      outputBytes: 0,
      lastLinePartial: false,
      firstLineExceedsLimit: true,
      maxLines,
      maxBytes,
    };
  }

  const output: string[] = [];
  let bytes = 0;
  let truncatedBy: "lines" | "bytes" | null = null;
  for (let index = 0; index < lines.length; index++) {
    if (output.length >= maxLines) {
      truncatedBy = "lines";
      break;
    }
    const addition = `${output.length > 0 ? "\n" : ""}${lines[index]}`;
    const additionBytes = Buffer.byteLength(addition, "utf8");
    if (bytes + additionBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    output.push(lines[index]);
    bytes += additionBytes;
  }

  const outputContent = output.join("\n");
  const truncated = output.length < lines.length;
  return {
    content: outputContent,
    truncated,
    truncatedBy: truncated ? truncatedBy ?? "lines" : null,
    totalLines: lines.length,
    totalBytes,
    outputLines: output.length,
    outputBytes: Buffer.byteLength(outputContent, "utf8"),
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}

function previewRange(map: LineMap, lineStart: number, lineEnd: number): string {
  const selected: string[] = [];
  const last = Math.min(lineEnd, lineStart - 1 + MAX_ERROR_PREVIEW_LINES, lineCount(map));
  for (let index = lineStart - 1; index < last; index++) {
    selected.push(map.text.slice(map.starts[index], lineContentEnd(map, index)));
  }
  const preview = numberedLines(selected, lineStart);
  const truncated = truncateCompleteLines(preview, MAX_ERROR_PREVIEW_LINES, MAX_ERROR_PREVIEW_BYTES);
  const omitted = lineEnd - lineStart + 1 - selected.length;
  return `${truncated.content}${omitted > 0 ? `\n… ${omitted} more line(s) omitted` : ""}`;
}

export function readTextBuffer(
  buffer: Buffer,
  displayPath: string,
  offset = 1,
  limit?: number,
): ReadTextResult {
  assertInputSize(buffer.length, displayPath);
  const rawText = decodeUtf8(buffer, displayPath);
  const { text } = splitBom(rawText);
  const normalized = normalizeLf(text);
  // Count lines and locate the requested span without materializing a full-file
  // lines array. As with split("\n"), empty files and trailing newlines have an
  // empty final line. Retain the original buffer as the hash/snapshot source.
  let totalLines = 1;
  let selectionStart = 0;
  let selectionEnd = normalized.length;
  const lastRequestedLine = limit === undefined ? Infinity : offset + limit - 1;
  for (let newline = normalized.indexOf("\n"); newline !== -1; newline = normalized.indexOf("\n", newline + 1)) {
    if (totalLines === lastRequestedLine) selectionEnd = newline;
    totalLines++;
    if (totalLines === offset) selectionStart = newline + 1;
  }
  if (offset > totalLines) {
    throw new FileToolError("RANGE_OUT_OF_BOUNDS", `offset ${offset} is beyond the end of the file.`, {
      path: displayPath,
      lineStart: offset,
      lineEnd: offset,
      recovery: `Use an offset between 1 and ${totalLines}.`,
    });
  }

  const requestedEnd = Math.min(totalLines, lastRequestedLine);
  const selectedCount = requestedEnd - offset + 1;
  // Width is based on the entire requested span, not just the displayed page.
  const width = String(requestedEnd).length;
  const prefixBytes = width + 3; // UTF-8 byte length of the padded number and │.
  const totalBytes = Buffer.byteLength(normalized.slice(selectionStart, selectionEnd), "utf8") + selectedCount * prefixBytes;
  const page: string[] = [];
  let position = selectionStart;
  let outputBytes = 0;
  let truncatedBy: "lines" | "bytes" | null = null;
  for (let index = 0; index < selectedCount; index++) {
    if (page.length >= MAX_OUTPUT_LINES) {
      truncatedBy = "lines";
      break;
    }
    const newline = normalized.indexOf("\n", position);
    const end = newline === -1 ? selectionEnd : Math.min(newline, selectionEnd);
    const overhead = prefixBytes + (index === 0 ? 0 : 1);
    const remaining = MAX_OUTPUT_BYTES - outputBytes - overhead;
    // UTF-8 bytes are never fewer than UTF-16 code units for validated text.
    // Reject oversized lines before slicing or building a numbered string.
    if (end - position > remaining) {
      truncatedBy = "bytes";
      break;
    }
    const body = normalized.slice(position, end);
    const bytes = Buffer.byteLength(body, "utf8");
    if (bytes > remaining) {
      truncatedBy = "bytes";
      break;
    }
    page.push(`${String(offset + index).padStart(width, " ")}│${body}`);
    outputBytes += overhead + bytes;
    position = end + 1;
  }
  const truncation: TruncationDetails = {
    content: page.join("\n"),
    truncated: page.length < selectedCount,
    truncatedBy,
    totalLines: selectedCount,
    totalBytes,
    outputLines: page.length,
    outputBytes,
    lastLinePartial: false,
    firstLineExceedsLimit: page.length === 0 && truncatedBy === "bytes",
    maxLines: MAX_OUTPUT_LINES,
    maxBytes: MAX_OUTPUT_BYTES,
  };
  const lineEnd = truncation.outputLines === 0 ? offset - 1 : offset + truncation.outputLines - 1;
  const metadata = {
    path: displayPath,
    sha256: sha256Token(buffer),
    totalLines,
    lineStart: offset,
    lineEnd,
  };

  let output = `[FILE_METADATA] ${JSON.stringify(metadata)}\n`;
  output += "[LINE_PREFIX] Each displayed line starts with <absolute-line-number>│. The prefix is metadata and is not part of the file.\n";
  if (truncation.firstLineExceedsLimit) {
    output += `[LINE_TOO_LARGE] Line ${offset} exceeds the ${MAX_OUTPUT_BYTES}-byte output limit and cannot be paginated with a line offset.`;
  } else {
    output += truncation.content;
  }

  const userLimited = limit !== undefined && requestedEnd < totalLines;
  if (truncation.firstLineExceedsLimit && offset < totalLines) {
    output += `\n[READ_CONTINUATION] nextOffset=${offset + 1}; totalLines=${totalLines}; reason=oversized_line_skipped`;
  } else if (!truncation.firstLineExceedsLimit && (truncation.truncated || userLimited)) {
    const nextOffset = lineEnd + 1;
    output += `\n[READ_CONTINUATION] nextOffset=${nextOffset}; totalLines=${totalLines}; reason=${truncation.truncated ? truncation.truncatedBy : "limit"}`;
  }

  return {
    text: output,
    details: {
      ...metadata,
      ...(truncation.truncated ? { truncation } : {}),
    },
  };
}

/** Reject FIFOs, devices and directories before any unbounded read can block. */
export function assertRegularReadableFile(fileStat: { isFile(): boolean }, displayPath: string): void {
  if (!fileStat.isFile()) {
    throw new FileToolError("FILE_NOT_READABLE", "The target is not a regular file.", {
      path: displayPath,
      recovery: "Target a regular file rather than a directory, FIFO, device, or other special path.",
    });
  }
}

export async function readTextFile(
  absolutePath: string,
  displayPath: string,
  offset = 1,
  limit?: number,
  signal?: AbortSignal,
): Promise<ReadTextResult> {
  abortIfRequested(signal);
  try {
    const fileStat = await stat(absolutePath);
    assertRegularReadableFile(fileStat, displayPath);
    assertInputSize(fileStat.size, displayPath);
    const buffer = await readFile(absolutePath, { signal });
    abortIfRequested(signal);
    return readTextBuffer(buffer, displayPath, offset, limit);
  } catch (error) {
    throw classifyFsError(error, displayPath, "read");
  }
}

async function readMutationSnapshot(absolutePath: string, displayPath: string): Promise<MutationSnapshot> {
  try {
    const fileStat = await lstat(absolutePath);
    if (fileStat.isSymbolicLink()) {
      throw new FileToolError("SYMLINK_UNSUPPORTED", "Refusing to mutate a symbolic-link path because atomic replacement would replace the link itself.", {
        path: displayPath,
        recovery: "Resolve and target the link's real file explicitly, or replace the symlink outside this tool.",
      });
    }
    if (!fileStat.isFile()) {
      throw new FileToolError("FILE_NOT_WRITABLE", "The mutation target is not a regular file.", {
        path: displayPath,
        recovery: "Target a regular UTF-8 file rather than a directory, device, or other special path.",
      });
    }
    assertInputSize(fileStat.size, displayPath);
    try {
      await access(absolutePath, fsConstants.R_OK);
    } catch {
      throw new FileToolError("FILE_NOT_READABLE", "The target file cannot be read for safe snapshot validation.", {
        path: displayPath,
        recovery: "Grant read permission before attempting a guarded mutation.",
      });
    }
    try {
      await access(absolutePath, fsConstants.W_OK);
    } catch {
      throw new FileToolError("FILE_NOT_WRITABLE", "The target file is not writable.", {
        path: displayPath,
        recovery: "Grant write permission or target a writable file.",
      });
    }
    let buffer: Buffer;
    try {
      buffer = await readFile(absolutePath);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code === "EACCES" || code === "EPERM") {
        throw new FileToolError("FILE_NOT_READABLE", "The target file could not be read for safe snapshot validation.", {
          path: displayPath,
          causeCode: typeof code === "string" ? code : undefined,
          recovery: "Grant read permission before attempting a guarded mutation.",
        });
      }
      throw error;
    }
    assertInputSize(buffer.length, displayPath);
    return { exists: true, buffer, hash: sha256(buffer), mode: fileStat.mode };
  } catch (error) {
    if (error instanceof FileToolError) throw error;
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return { exists: false };
    throw error;
  }
}

function verifyExpectedHash(current: MutationSnapshot, expectedHash: string | undefined, displayPath: string): void {
  if (expectedHash === undefined) return;
  if (expectedHash === "missing") {
    if (current.exists) {
      throw new FileToolError("FILE_ALREADY_EXISTS", "The target was expected to be missing, but it already exists.", {
        path: displayPath,
        actualHash: shortenHash(current.hash),
        expectedHash,
        recovery: "Read the existing file, then retry with its SHA-256 version token if overwrite is intended.",
      });
    }
    return;
  }
  if (!current.exists) {
    throw new FileToolError("FILE_NOT_FOUND", "The target file no longer exists.", {
      path: displayPath,
      expectedHash: shortenHash(expectedHash),
      recovery: "Read the path again before deciding whether to recreate it.",
    });
  }
  const normalizedExpectedHash = expectedHash.toLowerCase();
  const expectedMatches = normalizedExpectedHash.length === SHA256_TOKEN_LENGTH
    ? current.hash?.startsWith(normalizedExpectedHash) === true
    : normalizedExpectedHash.length === 64 && current.hash === normalizedExpectedHash;
  if (!expectedMatches) {
    throw new FileToolError("STALE_FILE", "The file changed after it was read; refusing to overwrite stale content.", {
      path: displayPath,
      expectedHash: shortenHash(normalizedExpectedHash),
      actualHash: shortenHash(current.hash),
      recovery: "Read the file again and rebuild the operation using the new content and version token.",
    });
  }
}

async function verifySnapshotUnchanged(absolutePath: string, displayPath: string, snapshot: MutationSnapshot): Promise<void> {
  const latest = await readMutationSnapshot(absolutePath, displayPath);
  if (snapshot.exists !== latest.exists || snapshot.hash !== latest.hash) {
    throw new FileToolError("STALE_FILE", "The file changed while the operation was being prepared; refusing to commit.", {
      path: displayPath,
      expectedHash: snapshot.exists ? shortenHash(snapshot.hash) : "missing",
      actualHash: latest.exists ? shortenHash(latest.hash) : "missing",
      recovery: "Read the file again and retry the operation.",
    });
  }
}

async function cleanupTemporaryFile(temporaryPath: string): Promise<void> {
  try {
    await unlink(temporaryPath);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") {
      process.emitWarning(`Could not remove temporary file ${temporaryPath}: ${error instanceof Error ? error.message : String(error)}`, {
        code: "PI_FILE_TOOLS_TEMP_CLEANUP",
      });
    }
  }
}

async function applyHandleMode(handle: Awaited<ReturnType<typeof open>>, mode: number, path: string): Promise<void> {
  try {
    await handle.chmod(mode & 0o7777);
  } catch (error) {
    process.emitWarning(`Could not preserve file mode for ${path}: ${error instanceof Error ? error.message : String(error)}`, {
      code: "PI_FILE_TOOLS_MODE_PRESERVATION",
    });
  }
}

async function syncHandle(handle: Awaited<ReturnType<typeof open>>): Promise<void> {
  try {
    await handle.sync();
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    // Some filesystems cannot fsync; durability is best-effort there.
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "ENOSYS" && code !== "EPERM") throw error;
  }
}

async function renameWithRetry(from: string, to: string, signal?: AbortSignal): Promise<void> {
  const attempts = process.platform === "win32" ? 5 : 1;
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      // Windows reports transient sharing violations (antivirus/indexer) as EPERM/EBUSY.
      if (attempt >= attempts || (code !== "EPERM" && code !== "EBUSY")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
      abortIfRequested(signal);
    }
  }
}

async function removeCreatedDirectories(leaf: string, createdRoot: string | undefined): Promise<void> {
  if (createdRoot === undefined) return;
  let current = leaf;
  while (true) {
    try {
      await rmdir(current);
    } catch {
      return; // Best effort: stop at the first non-empty or unremovable directory.
    }
    if (current === createdRoot) return;
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

const LINK_FALLBACK_CODES = new Set(["EPERM", "ENOSYS", "EACCES", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EMLINK", "EINVAL"]);

async function atomicWrite(
  absolutePath: string,
  displayPath: string,
  content: string,
  snapshot: MutationSnapshot,
  signal?: AbortSignal,
): Promise<void> {
  abortIfRequested(signal);
  const directory = dirname(absolutePath);
  const createdRoot = await mkdir(directory, { recursive: true });
  const temporaryPath = `${absolutePath}.pi-file-tools-${process.pid}-${ulid().toLowerCase()}.tmp`;
  let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryCreated = false;
  let committed = false;
  const targetMode = snapshot.exists ? snapshot.mode : 0o666 & ~process.umask();
  try {
    // Keep the temporary file owner-only until the payload is written; the target mode is then
    // applied to the temporary handle, before the commit, so no committed file is left with 0o600.
    temporaryHandle = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    await temporaryHandle.writeFile(content, "utf8");
    if (targetMode !== undefined) await applyHandleMode(temporaryHandle, targetMode, absolutePath);
    await syncHandle(temporaryHandle);
    await temporaryHandle.close();
    temporaryHandle = undefined;
    abortIfRequested(signal);
    await verifySnapshotUnchanged(absolutePath, displayPath, snapshot);
    abortIfRequested(signal);
    if (snapshot.exists) {
      await renameWithRetry(temporaryPath, absolutePath, signal);
      committed = true;
    } else {
      const staleError = () => new FileToolError("STALE_FILE", "The target path appeared during file creation; refusing to replace it.", {
        path: displayPath,
        expectedHash: "missing",
        recovery: "Read the newly created path and retry only if overwrite is intended.",
      });
      try {
        // Hard-link creation is atomic and fails instead of replacing a path created after our snapshot.
        await link(temporaryPath, absolutePath);
        committed = true;
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
        if (code === "EEXIST") throw staleError();
        if (typeof code !== "string" || !LINK_FALLBACK_CODES.has(code)) throw error;
        // Filesystems without hard links (FAT, some network shares): exclusive create instead.
        let targetHandle: Awaited<ReturnType<typeof open>> | undefined;
        let targetCreated = false;
        try {
          try {
            targetHandle = await open(absolutePath, "wx", targetMode);
          } catch (openError) {
            const openCode = typeof openError === "object" && openError !== null && "code" in openError ? openError.code : undefined;
            if (openCode === "EEXIST") throw staleError();
            throw openError;
          }
          targetCreated = true;
          await targetHandle.writeFile(content, "utf8");
          await syncHandle(targetHandle);
          await targetHandle.close();
          targetHandle = undefined;
          committed = true;
        } catch (fallbackError) {
          if (targetHandle !== undefined) await targetHandle.close().catch(() => undefined);
          if (targetCreated && !committed) await cleanupTemporaryFile(absolutePath);
          throw fallbackError;
        }
      }
    }
    // rename/link is the commit point. Cancellation after this point must not turn a committed write into an error.
  } catch (error) {
    if (temporaryHandle !== undefined) {
      await temporaryHandle.close().catch(() => undefined);
    }
    if (temporaryCreated) await cleanupTemporaryFile(temporaryPath);
    if (!committed) await removeCreatedDirectories(directory, createdRoot);
    throw error;
  }
  if (temporaryCreated) await cleanupTemporaryFile(temporaryPath);
}

export async function writeTextFile(
  absolutePath: string,
  displayPath: string,
  content: string,
  expectedHash?: string,
  signal?: AbortSignal,
): Promise<WriteResult> {
  abortIfRequested(signal);
  try {
    const snapshot = await readMutationSnapshot(absolutePath, displayPath);
    verifyExpectedHash(snapshot, expectedHash, displayPath);
    assertValidUtf16(content, displayPath);
    assertInputSize(Buffer.byteLength(content, "utf8"), displayPath);
    const nextHash = sha256(content);
    if (snapshot.exists && snapshot.hash === nextHash) {
      throw new FileToolError("NO_CHANGE", "The supplied content is identical to the existing file.", {
        path: displayPath,
        actualHash: shortenHash(snapshot.hash),
        recovery: "Do not call write when no content change is needed.",
      });
    }
    await atomicWrite(absolutePath, displayPath, content, snapshot, signal);
    return {
      path: displayPath,
      sha256: shortenHash(nextHash)!,
      bytes: Buffer.byteLength(content, "utf8"),
      created: !snapshot.exists,
    };
  } catch (error) {
    throw classifyFsError(error, displayPath, "write");
  }
}

function candidateRanges(map: LineMap, rangeStart: number, matches: RegexMatch[]): Array<{ start: number; end: number }> {
  return matches.slice(0, MAX_CANDIDATE_RANGES).map((match) => {
    const start = rangeStart + match.index;
    const end = start + match.text.length;
    return {
      start: lineForOffset(map, start),
      end: lineForOffset(map, Math.max(start, end - 1)),
    };
  });
}

function matchesConflict(left: MatchedEdit, right: MatchedEdit): boolean {
  const leftEmpty = left.matchStart === left.matchEnd;
  const rightEmpty = right.matchStart === right.matchEnd;
  if (leftEmpty && rightEmpty) return left.matchStart === right.matchStart;
  if (leftEmpty) return left.matchStart > right.matchStart && left.matchStart < right.matchEnd;
  if (rightEmpty) return right.matchStart > left.matchStart && right.matchStart < left.matchEnd;
  return left.matchStart < right.matchEnd && right.matchStart < left.matchEnd;
}

async function collectOperationMatches(
  content: string,
  edit: EditOperation,
  displayPath: string,
  editIndex: number,
  regexDeadline: number,
  signal?: AbortSignal,
): Promise<RegexMatch[]> {
  if (edit.oldText !== undefined) {
    return collectLiteralMatches(content, normalizeLf(edit.oldText), displayPath, editIndex);
  }
  return collectRegexMatches(
    content,
    edit.regex!,
    edit.regexFlags ?? "",
    displayPath,
    editIndex,
    regexDeadline - Date.now(),
    signal,
  );
}

async function validateEdits(
  view: NormalizedView,
  map: LineMap,
  edits: EditOperation[],
  displayPath: string,
  signal?: AbortSignal,
): Promise<MatchedEdit[]> {
  const matched: MatchedEdit[] = [];
  let changedReplacementBytes = 0;
  const deadline = Date.now() + MAX_EDIT_DURATION_MS;

  for (let editIndex = 0; editIndex < edits.length; editIndex++) {
    abortIfRequested(signal);
    assertEditDeadline(deadline, displayPath, editIndex);
    const edit = edits[editIndex];
    const hasOldText = typeof edit.oldText === "string";
    const hasRegex = typeof edit.regex === "string";
    if (hasOldText === hasRegex || typeof edit.newText !== "string") {
      throw new FileToolError("INVALID_ARGUMENT", `edits[${editIndex}] must provide exactly one of oldText or regex and must provide string newText.`, {
        path: displayPath,
        editIndex,
        recovery: "Provide one matching mode and a replacement string.",
      });
    }
    if ((hasOldText && edit.oldText!.length === 0) || (hasRegex && edit.regex!.length === 0)) {
      throw new FileToolError("INVALID_ARGUMENT", `edits[${editIndex}] cannot use an empty oldText or regex.`, {
        path: displayPath,
        editIndex,
        recovery: "Provide a non-empty literal or regular expression.",
      });
    }
    assertValidUtf16(edit.newText, displayPath, editIndex);
    if (edit.regexFlags !== undefined && !hasRegex) {
      throw new FileToolError("INVALID_ARGUMENT", `edits[${editIndex}].regexFlags requires regex.`, {
        path: displayPath,
        editIndex,
        recovery: "Remove regexFlags or use regex matching.",
      });
    }
    const replacementMode = edit.replacementMode ?? "literal";
    if (replacementMode !== "literal" && replacementMode !== "template") {
      throw new FileToolError("INVALID_ARGUMENT", `edits[${editIndex}].replacementMode is invalid.`, {
        path: displayPath,
        editIndex,
        recovery: "Use literal or template.",
      });
    }
    if (replacementMode === "template" && !hasRegex) {
      throw new FileToolError("INVALID_ARGUMENT", `edits[${editIndex}].replacementMode=template requires regex.`, {
        path: displayPath,
        editIndex,
        recovery: "Use literal replacementMode for oldText edits.",
      });
    }
    if (edit.replaceAll !== undefined && typeof edit.replaceAll !== "boolean") {
      throw new FileToolError("INVALID_ARGUMENT", `edits[${editIndex}].replaceAll must be a boolean.`, {
        path: displayPath,
        editIndex,
        recovery: "Use true to replace every match or false to require one match.",
      });
    }

    const lineRange = edit.lineRange;
    if (lineRange && (!Number.isInteger(lineRange.start) || !Number.isInteger(lineRange.end) || lineRange.start < 1 || lineRange.end < lineRange.start)) {
      throw new FileToolError("INVALID_ARGUMENT", `edits[${editIndex}].lineRange is invalid.`, {
        path: displayPath,
        editIndex,
        lineRange,
        recovery: "Use positive 1-based start/end values with end greater than or equal to start.",
      });
    }
    if (lineRange && lineRange.end > lineCount(map)) {
      throw new FileToolError("RANGE_OUT_OF_BOUNDS", `edits[${editIndex}].lineRange extends beyond the end of the file.`, {
        path: displayPath,
        editIndex,
        lineRange,
        recovery: `Use a range within lines 1-${lineCount(map)}.`,
      });
    }

    let rangeStart = lineRange ? map.starts[lineRange.start - 1] : 0;
    let rangeContent = lineRange
      ? view.text.slice(rangeStart, lineContentEnd(map, lineRange.end - 1))
      : view.text;
    const regexDeadline = Math.min(deadline, Date.now() + REGEX_TIMEOUT_MS);
    let operationMatches = await collectOperationMatches(rangeContent, edit, displayPath, editIndex, regexDeadline, signal);
    assertEditDeadline(deadline, displayPath, editIndex);

    if (operationMatches.length === 0) {
      let candidates: RegexMatch[] = [];
      if (lineRange && rangeContent.length !== view.text.length) {
        const candidateRegexDeadline = Math.min(deadline, Date.now() + REGEX_TIMEOUT_MS);
        candidates = await collectOperationMatches(view.text, edit, displayPath, editIndex, candidateRegexDeadline, signal);
      }
      assertEditDeadline(deadline, displayPath, editIndex);
      if (lineRange && edit.oldText !== undefined && candidates.length === 1) {
        // Recover a missed range only when the literal is unique in the whole file.
        rangeStart = 0;
        rangeContent = view.text;
        operationMatches = candidates;
      } else {
        throw new FileToolError(lineRange ? "TEXT_NOT_FOUND_IN_RANGE" : "TEXT_NOT_FOUND", `edits[${editIndex}] did not match inside the requested search scope.`, {
          path: displayPath,
          editIndex,
          lineRange,
          occurrences: candidates.length || undefined,
          candidateRanges: candidates.length > 0 ? candidateRanges(map, 0, candidates) : undefined,
          rangePreview: lineRange ? previewRange(map, lineRange.start, lineRange.end) : undefined,
          recovery: lineRange
            ? "Use a candidate range, read the range again, or correct the match. A unique literal match outside the range is applied automatically; ambiguous matches are not."
            : "Read the file again and copy exact text without the read tool's line-number prefixes.",
        });
      }
    }
    if (!edit.replaceAll && operationMatches.length > 1) {
      throw new FileToolError("AMBIGUOUS_MATCH", `edits[${editIndex}] matched more than once inside the requested search scope.`, {
        path: displayPath,
        editIndex,
        lineRange,
        occurrences: operationMatches.length,
        candidateRanges: candidateRanges(map, rangeStart, operationMatches),
        rangePreview: lineRange ? previewRange(map, lineRange.start, lineRange.end) : undefined,
        recovery: "Provide lineRange, include more surrounding text, use a more specific regex, or explicitly set replaceAll=true.",
      });
    }

    const selectedMatches = edit.replaceAll ? operationMatches : operationMatches.slice(0, 1);
    let operationChanged = 0;
    for (let matchIndex = 0; matchIndex < selectedMatches.length; matchIndex++) {
      const match = selectedMatches[matchIndex];
      const replacement = normalizeLf(
        replacementMode === "template"
          ? expandReplacementTemplate(edit.newText, match, rangeContent, displayPath, editIndex)
          : edit.newText,
      );
      const matchStart = rangeStart + match.index;
      const matchEnd = matchStart + match.text.length;
      const changed = replacement !== match.text;
      if (changed) {
        operationChanged += 1;
        changedReplacementBytes += Buffer.byteLength(replacement, "utf8");
        if (changedReplacementBytes > MAX_EDIT_RESULT_BYTES) {
          throw new FileToolError("RESULT_TOO_LARGE", "The edit call produced too much replacement content.", {
            path: displayPath,
            editIndex,
            recovery: "Reduce replacement size or split the edit into smaller operations.",
          });
        }
      }
      matched.push({
        editIndex,
        matchIndex,
        requestedLineRange: lineRange,
        matchStart,
        matchEnd,
        rawStart: rawOffsetFor(view, matchStart),
        rawEnd: rawOffsetFor(view, matchEnd),
        matchedText: match.text,
        replacement,
        changed,
        matchedLineStart: lineForOffset(map, matchStart),
        matchedLineEnd: lineForOffset(map, Math.max(matchStart, matchEnd - 1)),
      });
    }
    if (operationChanged === 0) {
      throw new FileToolError("NO_CHANGE", `edits[${editIndex}] would not change the file.`, {
        path: displayPath,
        editIndex,
        lineRange,
        recovery: "Remove the no-op edit or provide different replacement text.",
      });
    }
    assertEditDeadline(deadline, displayPath, editIndex);
    if (matched.length > MAX_EDIT_MATCHES) {
      throw new FileToolError("TOO_MANY_MATCHES", "The edit call exceeded the total replacement limit.", {
        path: displayPath,
        editIndex,
        occurrences: matched.length,
        recovery: "Split the operation into smaller calls or narrow lineRange values.",
      });
    }
  }

  matched.sort((left, right) => left.matchStart - right.matchStart || left.matchEnd - right.matchEnd);
  for (let leftIndex = 0; leftIndex < matched.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < matched.length; rightIndex++) {
      const left = matched[leftIndex];
      const right = matched[rightIndex];
      if (right.matchStart > left.matchEnd) break;
      if (matchesConflict(left, right)) {
        throw new FileToolError("OVERLAPPING_EDITS", `edits[${left.editIndex}] overlaps edits[${right.editIndex}].`, {
          path: displayPath,
          editIndex: right.editIndex,
          recovery: "Merge overlapping changes into one edit or target disjoint text ranges.",
        });
      }
    }
  }

  return matched;
}

function renderRawReplacement(raw: string, edit: MatchedEdit, defaultEnding: "\n" | "\r\n" | "\r"): string {
  const matchedRaw = raw.slice(edit.rawStart, edit.rawEnd);
  const ending = matchedRaw.includes("\r\n")
    ? "\r\n"
    : matchedRaw.includes("\r")
      ? "\r"
      : matchedRaw.includes("\n")
        ? "\n"
        : defaultEnding;
  return restoreNewTextLineEndings(edit.replacement, ending);
}

function validateResultSize(
  raw: string,
  matched: MatchedEdit[],
  defaultEnding: "\n" | "\r\n" | "\r",
  displayPath: string,
  prefixBytes = 0,
): void {
  let resultBytes = prefixBytes + Buffer.byteLength(raw, "utf8");
  for (const edit of matched) {
    if (!edit.changed) continue;
    resultBytes -= Buffer.byteLength(raw.slice(edit.rawStart, edit.rawEnd), "utf8");
    resultBytes += Buffer.byteLength(renderRawReplacement(raw, edit, defaultEnding), "utf8");
  }
  if (resultBytes > MAX_EDIT_RESULT_BYTES) {
    throw new FileToolError("RESULT_TOO_LARGE", "The edited file would exceed the configured result size limit.", {
      path: displayPath,
      recovery: "Reduce replacement size or split the file before editing it.",
    });
  }
}

/** Apply sorted, non-overlapping edits; also return each replacement's [start, end) in the output. */
function applyMatchedEdits(
  raw: string,
  matched: MatchedEdit[],
  defaultEnding: "\n" | "\r\n" | "\r",
): { text: string; replacedRanges: Array<[number, number]> } {
  const parts: string[] = [];
  const replacedRanges: Array<[number, number]> = [];
  let cursor = 0;
  let outputLength = 0;
  for (const edit of matched) {
    if (!edit.changed) continue;
    const unchanged = raw.slice(cursor, edit.rawStart);
    const replacement = renderRawReplacement(raw, edit, defaultEnding);
    parts.push(unchanged, replacement);
    outputLength += unchanged.length;
    replacedRanges.push([outputLength, outputLength + replacement.length]);
    outputLength += replacement.length;
    cursor = edit.rawEnd;
  }
  parts.push(raw.slice(cursor));
  return { text: parts.join(""), replacedRanges };
}

/**
 * LF-normalized edited text, spliced from the already-normalized view instead of rescanning the
 * whole output. A replacement boundary can fuse a CR and LF into one CRLF line break; only then
 * does the splice differ from normalizeLf(updatedRaw), so fall back to the full scan.
 */
function normalizedAfterEdits(
  view: NormalizedView,
  matched: MatchedEdit[],
  updatedRaw: string,
  replacedRanges: Array<[number, number]>,
): string {
  const fusesLineBreak = (offset: number) => updatedRaw.charCodeAt(offset - 1) === 13 && updatedRaw.charCodeAt(offset) === 10;
  if (replacedRanges.some(([start, end]) => fusesLineBreak(start) || fusesLineBreak(end))) return normalizeLf(updatedRaw);
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of matched) {
    if (!edit.changed) continue;
    parts.push(view.text.slice(cursor, edit.matchStart), edit.replacement);
    cursor = edit.matchEnd;
  }
  parts.push(view.text.slice(cursor));
  return parts.join("");
}

export async function editTextFile(
  absolutePath: string,
  displayPath: string,
  edits: RangeEdit[],
  expectedHash?: string,
  signal?: AbortSignal,
): Promise<EditResult> {
  abortIfRequested(signal);
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new FileToolError("INVALID_ARGUMENT", "edit.edits must contain at least one replacement.", {
      path: displayPath,
      recovery: "Provide at least one edit operation.",
    });
  }
  if (edits.length > MAX_EDIT_OPERATIONS) {
    throw new FileToolError("INVALID_ARGUMENT", `edit.edits cannot contain more than ${MAX_EDIT_OPERATIONS} operations.`, {
      path: displayPath,
      recovery: "Split the edit into smaller operations.",
    });
  }
  try {
    const snapshot = await readMutationSnapshot(absolutePath, displayPath);
    if (!snapshot.exists || !snapshot.buffer) {
      throw new FileToolError("FILE_NOT_FOUND", "The target file does not exist.", {
        path: displayPath,
        recovery: "Check the path or create the file with write.",
      });
    }
    verifyExpectedHash(snapshot, expectedHash, displayPath);

    const rawText = decodeUtf8(snapshot.buffer, displayPath);
    const { bom, text } = splitBom(rawText);
    const view = createNormalizedView(text);
    const map = buildLineMap(view.text);
    const matched = await validateEdits(view, map, edits, displayPath, signal);
    const defaultEnding = preferredLineEnding(text);
    validateResultSize(text, matched, defaultEnding, displayPath, Buffer.byteLength(bom, "utf8"));
    const { text: updatedRaw, replacedRanges } = applyMatchedEdits(text, matched, defaultEnding);
    if (updatedRaw === text) {
      throw new FileToolError("NO_CHANGE", "The edits produced content identical to the original file.", {
        path: displayPath,
        recovery: "Remove no-op edits or verify special characters in newText.",
      });
    }

    const finalText = bom + updatedRaw;
    // Matching can split surrogate pairs and capture expansion can create lone surrogates,
    // even when newText itself is valid. Never silently encode these as U+FFFD. The original
    // text was decoded from valid UTF-8, so only replacements and their junctions can be invalid.
    for (const [start, end] of replacedRanges) {
      assertValidUtf16Range(updatedRaw, start - 1, end + 1, displayPath);
    }
    const normalizedUpdated = normalizedAfterEdits(view, matched, updatedRaw, replacedRanges);
    const displayDiff = await createDiffFeedback(view.text, normalizedUpdated, displayPath, signal);
    const patch = displayDiff.patch;
    const result: EditResult = {
      path: displayPath,
      sha256Before: shortenHash(snapshot.hash)!,
      sha256After: sha256Token(finalText),
      appliedEdits: edits.length,
      matchedCount: matched.length,
      changedCount: matched.filter((edit) => edit.changed).length,
      diff: displayDiff.diff,
      patch,
      firstChangedLine: displayDiff.firstChangedLine,
      changedRanges: matched.filter((edit) => edit.changed).map((edit) => ({
        editIndex: edit.editIndex,
        matchIndex: edit.matchIndex,
        requestedLineRange: edit.requestedLineRange,
        matchedLineStart: edit.matchedLineStart,
        matchedLineEnd: edit.matchedLineEnd,
      })),
    };

    abortIfRequested(signal);
    await atomicWrite(absolutePath, displayPath, finalText, snapshot, signal);
    return result;
  } catch (error) {
    throw classifyFsError(error, displayPath, "edit");
  }
}

export function truncateFeedback(content: string): { content: string; truncated: boolean } {
  const result = truncateCompleteLines(content);
  if (!result.truncated) return { content, truncated: false };
  return {
    content: `${result.content}\n[OUTPUT_TRUNCATED] Showing ${result.outputLines}/${result.totalLines} lines and ${result.outputBytes}/${result.totalBytes} bytes.`,
    truncated: true,
  };
}
