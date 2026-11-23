import { ulid } from "ulid";
import { constants as fsConstants } from "node:fs";
import { access, link, lstat, mkdir, open, readFile, rename, rmdir, stat, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { createDiffFeedback } from "./diff-runner.ts";
import { FileToolError, abortIfRequested, classifyFsError, errnoCode } from "./errors.ts";
import { digestHex, matchesVersionToken, shortenDigest, versionToken } from "../../../shared/src/version-token/index.ts";

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

type LineEnding = "\n" | "\r\n" | "\r";

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
  /** Insert newText before the match start or after the match end instead of replacing the match. */
  insert?: "before" | "after";
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
  /** Indexes of the edits whose lineRange missed and were applied to their unique whole-file match. */
  fallbackEdits?: number[];
  /** Model-visible notes about edits that succeeded but may not have done what was meant. */
  notices?: string[];
  /** The edit was validated and diffed but not written; `sha256After` is then what the file would hash to. */
  dryRun?: boolean;
}

export interface EditOptions {
  /** Validate and diff as usual but do not write the file. */
  dryRun?: boolean;
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
  /** size:mtimeMs:ino at snapshot time; a cheap last-moment check, never a substitute for the hash. */
  fingerprint?: string;
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
  replacement: string;
  changed: boolean;
  matchedLineStart: number;
  matchedLineEnd: number;
  /** The lineRange missed and the edit was applied to its unique whole-file match. */
  fallback?: boolean;
}

export const sha256 = digestHex;

/** The compact version token (first 64 bits of the SHA-256 digest) reported by read, write and edit. */
export const sha256Token = versionToken;

const shortenHash = shortenDigest;

export function assertInputSize(size: number, displayPath: string): void {
  if (size > MAX_INPUT_BYTES) {
    throw new FileToolError("FILE_TOO_LARGE", `The input is ${size} bytes, which exceeds the ${MAX_INPUT_BYTES}-byte processing limit.`, {
      path: displayPath,
      recovery: `Keep each file or write below ${MAX_INPUT_BYTES} bytes: split the content into several files, or inspect part of a large existing file with a shell command such as head -c or sed -n.`,
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

const LEGACY_ENCODINGS: ReadonlyArray<[label: string, name: string]> = [
  ["big5", "Big5 (cp950)"],
  ["gbk", "GBK (cp936)"],
  ["shift_jis", "Shift_JIS (cp932)"],
  ["euc-kr", "EUC-KR (cp949)"],
  ["windows-1252", "Windows-1252"],
];

/** Names of the encodings the non-UTF-8 buffer could be: a BOM wins, otherwise every legacy decoder that accepts it. */
export function detectEncodings(buffer: Buffer): string[] {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return ["UTF-16 LE (BOM)"];
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return ["UTF-16 BE (BOM)"];
  const candidates: string[] = [];
  for (const [label, name] of LEGACY_ENCODINGS) {
    try {
      new TextDecoder(label, { fatal: true }).decode(buffer);
      candidates.push(name);
    } catch {
      // not decodable as this encoding
    }
  }
  return candidates;
}

export function decodeUtf8(buffer: Buffer, displayPath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    const candidates = detectEncodings(buffer);
    const detected = candidates.length > 0 ? ` Likely encoding: ${candidates.join(" / ")} (heuristic, several may fit).` : " No known text encoding fits; it may be binary.";
    throw new FileToolError("INVALID_ENCODING", `The file is not valid UTF-8 and cannot be safely processed as text.${detected}`, {
      path: displayPath,
      recovery: "Do not read, write or edit this file with these tools. Inspect it with shell (for example xxd <file> | head), or convert a copy with iconv -f <encoding> -t UTF-8 <file> > <new file>, then retry on UTF-8 content.",
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

function preferredLineEnding(raw: string): LineEnding {
  if (!raw.includes("\r")) return "\n";
  const crlfCount = countOccurrences(raw, "\r\n");
  const lfCount = countOccurrences(raw, "\n") - crlfCount;
  const crCount = countOccurrences(raw, "\r") - crlfCount;
  if (crlfCount > lfCount && crlfCount >= crCount) return "\r\n";
  if (crCount > lfCount && crCount > crlfCount) return "\r";
  return "\n";
}

function restoreNewTextLineEndings(text: string, ending: LineEnding): string {
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
      throw new FileToolError("TOO_MANY_MATCHES", `edits[${editIndex}] exceeded the per-edit match limit of ${maxMatches}.`, {
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
const { parentPort } = require("node:worker_threads");
let cachedText = "";
parentPort.on("message", (workerData) => {
try {
  if (workerData.text !== undefined) cachedText = workerData.text;
  parentPort.postMessage({ type: "started" });
  const expression = new RegExp(workerData.pattern, workerData.flags + "g");
  const matches = [];
  let payloadBytes = 0;
  let tooMany = false;
  let tooLarge = false;
  while (true) {
    const match = expression.exec(cachedText);
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
      if (expression.unicode && index < cachedText.length) {
        const first = cachedText.charCodeAt(index);
        const second = index + 1 < cachedText.length ? cachedText.charCodeAt(index + 1) : 0;
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
});
`;

/** Scoped to one edit validation: no idle workers or retained file data after the call. */
interface RegexSession {
  worker?: Worker;
  text?: string;
}

/** Only i, m, s and u, each at most once; replaceAll (not g) controls global matching. */
export function isSupportedRegexFlags(flags: string): boolean {
  return /^[imsu]*$/.test(flags) && new Set(flags).size === flags.length;
}

function regexTimeoutError(displayPath: string, editIndex: number): FileToolError {
  return new FileToolError("REGEX_TIMEOUT", `edits[${editIndex}].regex exceeded the ${REGEX_TIMEOUT_MS} ms execution time limit.`, {
    path: displayPath,
    editIndex,
    recovery: "Use a simpler regex, narrow lineRange, or use literal oldText.",
  });
}

function validateRegexConfiguration(pattern: string, flags: string, displayPath: string, editIndex: number): void {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    throw new FileToolError("INVALID_REGEX", `edits[${editIndex}].regex exceeds the pattern length limit.`, {
      path: displayPath,
      editIndex,
      recovery: `Use a regex no longer than ${MAX_REGEX_PATTERN_LENGTH} UTF-16 code units.`,
    });
  }
  if (!isSupportedRegexFlags(flags)) {
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
  signal: AbortSignal | undefined,
  session: RegexSession,
): Promise<RegexMatch[]> {
  validateRegexConfiguration(pattern, flags, displayPath, editIndex);
  abortIfRequested(signal);
  if (timeoutMs <= 0) throw regexTimeoutError(displayPath, editIndex);

  return new Promise<RegexMatch[]>((resolve, reject) => {
    const worker = session.worker ??= new Worker(REGEX_WORKER_SOURCE, { eval: true });
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (action: () => void, keepWorker = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const complete = () => {
        worker.removeListener("message", onMessage);
        worker.removeListener("error", onError);
        worker.removeListener("exit", onExit);
        action();
      };
      if (keepWorker) complete();
      // Keep the guarded error listener until termination completes, including abort/error races.
      else void worker.terminate().then(complete, complete);
    };
    const onAbort = () => finish(() => reject(new FileToolError("OPERATION_ABORTED", "The edit operation was aborted.", {
      path: displayPath,
      editIndex,
      recovery: "Read the file again before retrying the edit.",
    })));
    const onTimeout = () => finish(() => reject(regexTimeoutError(displayPath, editIndex)));
    // Worker start-up and the structured clone of a large text are not regex time: the
    // execution budget restarts when the worker reports it began, bounded by a start-up grace.
    timer = setTimeout(onTimeout, timeoutMs + REGEX_STARTUP_GRACE_MS);

    const onMessage = (message: { type?: string; matches?: RegexMatch[]; count?: number; message?: string }) => {
      if (message.type === "started") {
        if (!settled) {
          clearTimeout(timer);
          timer = setTimeout(onTimeout, timeoutMs);
        }
      } else if (message.type === "matches" && Array.isArray(message.matches)) {
        finish(() => resolve(message.matches!), true);
      } else if (message.type === "too_many") {
        finish(() => reject(new FileToolError("TOO_MANY_MATCHES", `edits[${editIndex}] exceeded the per-edit match limit of ${MAX_REGEX_MATCHES}.`, {
          path: displayPath,
          editIndex,
          occurrences: message.count,
          recovery: "Narrow lineRange, use a more specific regex, or split the operation.",
        })));
      } else if (message.type === "too_large") {
        finish(() => reject(new FileToolError("RESULT_TOO_LARGE", `edits[${editIndex}].regex produced more captured match data than the worker limit allows.`, {
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
    };
    const onError = (error: Error) => finish(() => reject(new FileToolError("IO_ERROR", `Regex worker failed (a transient tool fault, not caused by your arguments): ${error.message}`, {
      path: displayPath,
      editIndex,
      recovery: "Retry the operation or use literal oldText.",
    })));
    const onExit = (code: number) => {
      if (!settled) {
        finish(() => reject(new FileToolError("IO_ERROR", `Regex worker exited with code ${code} (a transient tool fault, not caused by your arguments).`, {
          path: displayPath,
          editIndex,
          recovery: "Retry the operation or use literal oldText.",
        })));
      }
    };
    worker.on("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    // Reuse the previous search scope without cloning it again. A changed lineRange sends a
    // fresh independent string, preserving anchors/lookaround and template prefix/suffix rules.
    try {
      worker.postMessage({
        ...(session.text === text ? {} : { text }),
        pattern, flags, maxMatches: MAX_REGEX_MATCHES, maxPayloadBytes: MAX_EDIT_RESULT_BYTES,
      });
      session.text = text;
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
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
      throw new FileToolError("RESULT_TOO_LARGE", `edits[${editIndex}] produced a replacement larger than the ${MAX_EDIT_RESULT_BYTES}-byte result limit.`, {
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

  // Single-line compact metadata: defaults (a whole-file read) are omitted. The
  // line-prefix rule lives in promptGuidelines, not in every result.
  const wholeFile = offset === 1 && lineEnd === totalLines && !truncation.firstLineExceedsLimit;
  const compactMetadata = {
    path: displayPath,
    sha256: metadata.sha256,
    ...(wholeFile ? {} : { lines: truncation.outputLines === 0 ? "none" : `${offset}-${lineEnd}`, total: totalLines }),
  };
  let output = `[FILE_METADATA] ${JSON.stringify(compactMetadata)}\n`;
  if (truncation.firstLineExceedsLimit) {
    output += `[LINE_TOO_LARGE] Line ${offset} exceeds the ${MAX_OUTPUT_BYTES}-byte output limit and cannot be paginated with a line offset. Inspect it with shell instead, for example: sed -n '${offset}p' <file> | cut -c1-2000, or head -c 20000 <file>.`;
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
      recovery: "Target a regular file. For a directory, list it with shell (ls, or rg --files <dir>) and read a file inside; FIFOs and devices are unsupported.",
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
    throw classifyFsError(error, displayPath, "read", absolutePath);
  }
}

function statFingerprint(fileStat: { size: number; mtimeMs: number; ino: number | bigint }): string {
  return `${fileStat.size}:${fileStat.mtimeMs}:${fileStat.ino}`;
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
      const code = errnoCode(error);
      if (code === "EACCES" || code === "EPERM") {
        throw new FileToolError("FILE_NOT_READABLE", "The target file could not be read for safe snapshot validation.", {
          path: displayPath,
          causeCode: code,
          recovery: "Grant read permission before attempting a guarded mutation.",
        });
      }
      throw error;
    }
    assertInputSize(buffer.length, displayPath);
    return { exists: true, buffer, hash: sha256(buffer), mode: fileStat.mode, fingerprint: statFingerprint(fileStat) };
  } catch (error) {
    if (error instanceof FileToolError) throw error;
    const code = errnoCode(error);
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
    throw new FileToolError("FILE_NOT_FOUND", "The target file no longer exists, but expectedHash was supplied.", {
      path: displayPath,
      expectedHash: shortenHash(expectedHash),
      recovery: "Read the path again before deciding whether to recreate it; to create it anew, call write with expectedHash:\"missing\" or omit expectedHash.",
    });
  }
  const normalizedExpectedHash = expectedHash.toLowerCase();
  // Tokens of 16, 32 or 64 characters are all prefixes of the full digest taken from the bytes on disk.
  if (!matchesVersionToken(normalizedExpectedHash, current.hash)) {
    throw new FileToolError("STALE_FILE", "The file changed after it was read; refusing to overwrite stale content.", {
      path: displayPath,
      expectedHash: shortenHash(normalizedExpectedHash),
      actualHash: shortenHash(current.hash),
      recovery: "Read the file again and rebuild the operation using the new content and version token.",
    });
  }
}

async function verifySnapshotUnchanged(absolutePath: string, displayPath: string, snapshot: MutationSnapshot): Promise<MutationSnapshot> {
  const latest = await readMutationSnapshot(absolutePath, displayPath);
  if (snapshot.exists !== latest.exists || snapshot.hash !== latest.hash) {
    throw new FileToolError("STALE_FILE", "The file changed while the operation was being prepared; refusing to commit.", {
      path: displayPath,
      expectedHash: snapshot.exists ? shortenHash(snapshot.hash) : "missing",
      actualHash: latest.exists ? shortenHash(latest.hash) : "missing",
      recovery: "Read the file again and retry the operation.",
    });
  }
  return latest;
}

/**
 * Last check immediately before rename: the hash was verified from a full re-read, so re-stat the
 * target and refuse if size/mtime/inode moved while that read was in flight. This only narrows the
 * unavoidable check-then-rename window; the hash comparison above is unchanged.
 */
async function verifyFingerprintUnchanged(absolutePath: string, displayPath: string, latest: MutationSnapshot): Promise<void> {
  if (!latest.exists || latest.fingerprint === undefined) return;
  let current: string | undefined;
  try {
    current = statFingerprint(await lstat(absolutePath));
  } catch {
    current = undefined;
  }
  if (current !== latest.fingerprint) {
    throw new FileToolError("STALE_FILE", "The file changed immediately before commit; refusing to overwrite it.", {
      path: displayPath,
      expectedHash: shortenHash(latest.hash),
      recovery: "Read the file again and retry the operation.",
    });
  }
}

async function cleanupTemporaryFile(temporaryPath: string): Promise<void> {
  try {
    await unlink(temporaryPath);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") {
      process.emitWarning(`Could not remove temporary file ${temporaryPath}: ${error instanceof Error ? error.message : String(error)}`, {
        code: "PI_FILE_TOOLS_TEMP_CLEANUP",
      });
    }
  }
}

async function applyHandleMode(handle: FileHandle, mode: number, path: string): Promise<void> {
  try {
    await handle.chmod(mode & 0o7777);
  } catch (error) {
    process.emitWarning(`Could not preserve file mode for ${path}: ${error instanceof Error ? error.message : String(error)}`, {
      code: "PI_FILE_TOOLS_MODE_PRESERVATION",
    });
  }
}

async function syncHandle(handle: FileHandle): Promise<void> {
  try {
    await handle.sync();
  } catch (error) {
    const code = errnoCode(error);
    // Some filesystems cannot fsync; durability is best-effort there.
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "ENOSYS" && code !== "EPERM") throw error;
  }
}

// Windows sharing violations (antivirus/indexer/search) can hold a file for seconds: total backoff ~3.1s.
const WINDOWS_RENAME_ATTEMPTS = 12;
const WINDOWS_RENAME_BACKOFF_STEP_MS = 50;
const WINDOWS_RENAME_MAX_DELAY_MS = 500;
const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

async function renameWithRetry(
  from: string,
  to: string,
  signal?: AbortSignal,
  beforeRetry?: () => Promise<void>,
): Promise<void> {
  const attempts = process.platform === "win32" ? WINDOWS_RENAME_ATTEMPTS : 1;
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = errnoCode(error);
      // Windows reports transient sharing violations (antivirus/indexer) as EPERM/EBUSY/EACCES.
      if (attempt >= attempts || code === undefined || !RENAME_RETRY_CODES.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(WINDOWS_RENAME_BACKOFF_STEP_MS * attempt, WINDOWS_RENAME_MAX_DELAY_MS)));
      abortIfRequested(signal);
      // The file may have changed while we waited; the hash check must hold for every attempt.
      await beforeRetry?.();
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

/**
 * Create a target that was missing at snapshot time without ever replacing a path that appeared
 * since. Returns only once the file is committed; on failure nothing it created remains.
 */
async function commitNewFile(
  temporaryPath: string,
  absolutePath: string,
  displayPath: string,
  content: string,
  targetMode: number | undefined,
): Promise<void> {
  const staleError = () => new FileToolError("STALE_FILE", "The target path appeared during file creation; refusing to replace it.", {
    path: displayPath,
    expectedHash: "missing",
    recovery: "Read the newly created path and retry only if overwrite is intended.",
  });
  try {
    // Hard-link creation is atomic and fails instead of replacing a path created after our snapshot.
    await link(temporaryPath, absolutePath);
    return;
  } catch (error) {
    const code = errnoCode(error);
    if (code === "EEXIST") throw staleError();
    if (code === undefined || !LINK_FALLBACK_CODES.has(code)) throw error;
  }
  // Filesystems without hard links (FAT, some network shares): exclusive create instead.
  let targetHandle: FileHandle | undefined;
  let targetCreated = false;
  try {
    try {
      targetHandle = await open(absolutePath, "wx", targetMode);
    } catch (openError) {
      if (errnoCode(openError) === "EEXIST") throw staleError();
      throw openError;
    }
    targetCreated = true;
    await targetHandle.writeFile(content, "utf8");
    await syncHandle(targetHandle);
    await targetHandle.close();
    targetHandle = undefined;
  } catch (fallbackError) {
    if (targetHandle !== undefined) await targetHandle.close().catch(() => undefined);
    if (targetCreated) await cleanupTemporaryFile(absolutePath);
    throw fallbackError;
  }
}

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
  const temporaryPath = join(directory, `.pi-ft-${ulid().toUpperCase()}.tmp`);
  let temporaryHandle: FileHandle | undefined;
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
    const verified = await verifySnapshotUnchanged(absolutePath, displayPath, snapshot);
    abortIfRequested(signal);
    if (snapshot.exists) {
      await verifyFingerprintUnchanged(absolutePath, displayPath, verified);
      abortIfRequested(signal);
      await renameWithRetry(temporaryPath, absolutePath, signal, async () => {
        const retried = await verifySnapshotUnchanged(absolutePath, displayPath, snapshot);
        await verifyFingerprintUnchanged(absolutePath, displayPath, retried);
        abortIfRequested(signal);
      });
    } else {
      await commitNewFile(temporaryPath, absolutePath, displayPath, content, targetMode);
    }
    committed = true;
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
    // Refuse to silently convert an existing non-UTF-8 file to UTF-8.
    if (snapshot.exists && snapshot.buffer) decodeUtf8(snapshot.buffer, displayPath);
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
    throw classifyFsError(error, displayPath, "write", absolutePath);
  }
}

const CONTEXT_CANDIDATES = 5;
const CONTEXT_LINES = 1;
const CONTEXT_LINE_CHARS = 160;
const CLOSEST_SCAN_LINES = 50_000;
const CLOSEST_SCAN_MS = 50;
const CLOSEST_LINE_CHARS = 200;

const clipLine = (line: string, max: number) => (line.length > max ? `${line.slice(0, max)}…` : line);

/** For the first candidates of an ambiguous match: the matched lines with one line of context each side, numbered like read. */
function candidateContext(map: LineMap, rangeStart: number, matches: RegexMatch[]): Array<{ start: number; end: number; preview: string }> {
  const total = lineCount(map);
  return matches.slice(0, CONTEXT_CANDIDATES).map((match) => {
    const start = rangeStart + match.index;
    const first = lineForOffset(map, start);
    const last = lineForOffset(map, Math.max(start, start + match.text.length - 1));
    const from = Math.max(1, first - CONTEXT_LINES);
    const to = Math.min(total, Math.min(last, first + 2) + CONTEXT_LINES);
    const lines: string[] = [];
    for (let line = from; line <= to; line++) lines.push(clipLine(map.text.slice(map.starts[line - 1], lineContentEnd(map, line - 1)), CONTEXT_LINE_CHARS));
    return { start: first, end: last, preview: numberedLines(lines, from) };
  });
}

const normalizeForCompare = (line: string) => line.replace(/\s+/g, " ").trim();
const wordsOf = (line: string) => new Set(line.toLowerCase().match(/[\p{L}\p{N}_$]+/gu) ?? []);

/**
 * The line of the file most like the first non-blank line of a literal that did not match (same text apart from
 * whitespace, one containing the other, or sharing most of its words). Bounded in lines and time. Undefined when
 * nothing is close: a wrong guess would be worse than none.
 */
function closestLine(text: string, map: LineMap, needle: string): { line: number; text: string } | undefined {
  const wanted = needle.split("\n").map(normalizeForCompare).find((line) => line.length >= 3);
  if (!wanted) return undefined;
  const wantedWords = wordsOf(wanted);
  const started = Date.now();
  const total = Math.min(lineCount(map), CLOSEST_SCAN_LINES);
  let best: { line: number; score: number } | undefined;
  for (let index = 0; index < total; index++) {
    if (index % 1000 === 999 && Date.now() - started > CLOSEST_SCAN_MS) break;
    const line = normalizeForCompare(text.slice(map.starts[index], lineContentEnd(map, index)));
    if (line.length < 3) continue;
    let score = 0;
    if (line === wanted) score = 1;
    else if (line.includes(wanted) || (line.length >= 8 && wanted.includes(line))) score = 0.9;
    else if (wantedWords.size >= 2) {
      const words = wordsOf(line);
      let shared = 0;
      for (const word of wantedWords) if (words.has(word)) shared++;
      const union = wantedWords.size + words.size - shared;
      score = union > 0 ? (shared / union) * 0.8 : 0;
    }
    if (score >= 0.6 && (!best || score > best.score)) best = { line: index + 1, score };
    if (best?.score === 1) break;
  }
  if (!best) return undefined;
  return { line: best.line, text: clipLine(text.slice(map.starts[best.line - 1], lineContentEnd(map, best.line - 1)), CLOSEST_LINE_CHARS) };
}

/** True when a regex source has a `^` or `$` anchor outside character classes and escapes. */
export function usesLineAnchors(pattern: string): boolean {
  let inClass = false;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "\\") { index++; continue; }
    if (inClass) { if (char === "]") inClass = false; continue; }
    if (char === "[") { inClass = true; continue; }
    if (char === "^" || char === "$") return true;
  }
  return false;
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
  signal: AbortSignal | undefined,
  session: RegexSession,
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
    session,
  );
}

/** Check one edit's fields and lineRange bounds before any matching; returns its replacement mode. */
function assertEditOperationValid(edit: EditOperation, editIndex: number, map: LineMap, displayPath: string): "literal" | "template" {
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
  if (edit.insert !== undefined) {
    if (edit.insert !== "before" && edit.insert !== "after") {
      throw new FileToolError("INVALID_ARGUMENT", `edits[${editIndex}].insert is invalid.`, {
        path: displayPath,
        editIndex,
        recovery: 'Use "before" or "after", or omit insert to replace the match.',
      });
    }
    if (edit.newText.length === 0) {
      throw new FileToolError("INVALID_ARGUMENT", `edits[${editIndex}].newText cannot be empty when insert is set.`, {
        path: displayPath,
        editIndex,
        recovery: "Provide the text to insert; to delete matched text omit insert and use an empty newText.",
      });
    }
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
  return replacementMode;
}

function searchedPreview(text: string): string {
  const limit = 80;
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

/** Per-regex deadline: the regex time limit from now, never past the overall edit deadline. */
function regexDeadlineFor(deadline: number): number {
  return Math.min(deadline, Date.now() + REGEX_TIMEOUT_MS);
}

/**
 * Match one edit inside its lineRange window (or the whole file). A ranged miss (literal or regex) falls
 * back to the target's unique whole-file match (reported as a fallback); otherwise a miss or an
 * ambiguous non-replaceAll match throws.
 */
async function findScopedMatches(
  view: NormalizedView,
  map: LineMap,
  edit: EditOperation,
  editIndex: number,
  deadline: number,
  displayPath: string,
  signal: AbortSignal | undefined,
  session: RegexSession,
): Promise<{ rangeStart: number; rangeContent: string; operationMatches: RegexMatch[]; fellBack: boolean }> {
  const lineRange = edit.lineRange;
  let fellBack = false;
  let rangeStart = lineRange ? map.starts[lineRange.start - 1] : 0;
  let rangeContent = lineRange
    ? view.text.slice(rangeStart, lineContentEnd(map, lineRange.end - 1))
    : view.text;
  const regexDeadline = regexDeadlineFor(deadline);
  let operationMatches = await collectOperationMatches(rangeContent, edit, displayPath, editIndex, regexDeadline, signal, session);
  assertEditDeadline(deadline, displayPath, editIndex);

  if (operationMatches.length === 0) {
    let candidates: RegexMatch[] = [];
    if (lineRange && rangeContent.length !== view.text.length) {
      candidates = await collectOperationMatches(view.text, edit, displayPath, editIndex, regexDeadlineFor(deadline), signal, session);
    }
    assertEditDeadline(deadline, displayPath, editIndex);
    if (lineRange && candidates.length === 1) {
      // Recover a missed range only when the target is unique in the whole file (the window itself stays a standalone string).
      rangeStart = 0;
      rangeContent = view.text;
      operationMatches = candidates;
      fellBack = true;
    } else {
      throw new FileToolError(lineRange ? "TEXT_NOT_FOUND_IN_RANGE" : "TEXT_NOT_FOUND", `edits[${editIndex}] did not match inside the requested search scope (${edit.oldText !== undefined ? "searched for" : "searched for regex"} ${JSON.stringify(searchedPreview(edit.oldText ?? edit.regex ?? ""))}).`, {
        path: displayPath,
        editIndex,
        lineRange,
        occurrences: candidates.length || undefined,
        candidateRanges: candidates.length > 0 ? candidateRanges(map, 0, candidates) : undefined,
        rangePreview: lineRange ? previewRange(map, lineRange.start, lineRange.end) : undefined,
        closestLine: edit.oldText !== undefined && candidates.length === 0 ? closestLine(view.text, map, edit.oldText) : undefined,
        recovery: lineRange
          ? "Use a candidate range, read the range again, or correct the match. A unique match outside the range is applied automatically; ambiguous matches are not."
          : "Read the file again and copy exact text without the read tool's line-number prefixes. Check whitespace: tabs vs spaces, trailing spaces and CRLF vs LF line endings must match the file exactly.",
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
      candidateContext: candidateContext(map, rangeStart, operationMatches),
      rangePreview: lineRange ? previewRange(map, lineRange.start, lineRange.end) : undefined,
      recovery: "Pick a candidate from candidateContext and set lineRange to its lines, include more surrounding text, use a more specific regex, or explicitly set replaceAll=true when every match should change.",
    });
  }
  return { rangeStart, rangeContent, operationMatches, fellBack };
}

async function validateEdits(
  view: NormalizedView,
  map: LineMap,
  edits: EditOperation[],
  displayPath: string,
  signal?: AbortSignal,
): Promise<MatchedEdit[]> {
  const session: RegexSession = {};
  try {
    return await validateEditsWithSession(view, map, edits, displayPath, signal, session);
  } finally {
    await session.worker?.terminate();
  }
}

async function validateEditsWithSession(
  view: NormalizedView,
  map: LineMap,
  edits: EditOperation[],
  displayPath: string,
  signal: AbortSignal | undefined,
  session: RegexSession,
): Promise<MatchedEdit[]> {
  const matched: MatchedEdit[] = [];
  let changedReplacementBytes = 0;
  const deadline = Date.now() + MAX_EDIT_DURATION_MS;

  for (let editIndex = 0; editIndex < edits.length; editIndex++) {
    abortIfRequested(signal);
    assertEditDeadline(deadline, displayPath, editIndex);
    const edit = edits[editIndex];
    const replacementMode = assertEditOperationValid(edit, editIndex, map, displayPath);
    const lineRange = edit.lineRange;
    const { rangeStart, rangeContent, operationMatches, fellBack } = await findScopedMatches(view, map, edit, editIndex, deadline, displayPath, signal, session);

    const selectedMatches = edit.replaceAll ? operationMatches : operationMatches.slice(0, 1);
    let operationChanged = 0;
    for (let matchIndex = 0; matchIndex < selectedMatches.length; matchIndex++) {
      const match = selectedMatches[matchIndex];
      const replacement = normalizeLf(
        replacementMode === "template"
          ? expandReplacementTemplate(edit.newText, match, rangeContent, displayPath, editIndex)
          : edit.newText,
      );
      const found = rangeStart + match.index;
      // An insertion is a zero-width edit at the start or end of the match (see matchesConflict).
      const matchStart = edit.insert === "after" ? found + match.text.length : found;
      const matchEnd = edit.insert ? matchStart : found + match.text.length;
      const changed = edit.insert ? true : replacement !== match.text;
      if (changed) {
        operationChanged += 1;
        changedReplacementBytes += Buffer.byteLength(replacement, "utf8");
        if (changedReplacementBytes > MAX_EDIT_RESULT_BYTES) {
          throw new FileToolError("RESULT_TOO_LARGE", `The edit call produced more than ${MAX_EDIT_RESULT_BYTES} bytes of replacement content.`, {
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
        replacement,
        changed,
        matchedLineStart: lineForOffset(map, matchStart),
        matchedLineEnd: lineForOffset(map, Math.max(matchStart, matchEnd - 1)),
        ...(fellBack ? { fallback: true } : {}),
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
      throw new FileToolError("TOO_MANY_MATCHES", `The edit call matched more than the total limit of ${MAX_EDIT_MATCHES} replacements.`, {
        path: displayPath,
        editIndex,
        occurrences: matched.length,
        recovery: "Split the operation into smaller calls or narrow lineRange values.",
      });
    }
  }

  sortAndAssertDisjoint(matched, displayPath);
  return matched;
}

/** Sort matches by position in place and reject any pair that overlaps (see matchesConflict). */
function sortAndAssertDisjoint(matched: MatchedEdit[], displayPath: string): void {
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
          recovery: "Merge overlapping changes into one edit or target disjoint text ranges. Only one insertion fits at a given position: \"after\" one match and \"before\" the next one that starts right there are the same position, so combine them into one insert.",
        });
      }
    }
  }
}

function renderRawReplacement(raw: string, edit: MatchedEdit, defaultEnding: LineEnding): string {
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
  defaultEnding: LineEnding,
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
    throw new FileToolError("RESULT_TOO_LARGE", `The edited file would exceed the ${MAX_EDIT_RESULT_BYTES}-byte result size limit (computed ${resultBytes} bytes).`, {
      path: displayPath,
      recovery: "Reduce replacement size or split the file before editing it.",
    });
  }
}

/** Apply sorted, non-overlapping edits; also return each replacement's [start, end) in the output. */
function applyMatchedEdits(
  raw: string,
  matched: MatchedEdit[],
  defaultEnding: LineEnding,
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
  options: EditOptions = {},
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
      throw new FileToolError("FILE_NOT_FOUND", `File not found: ${displayPath}${displayPath === absolutePath ? "" : ` (resolved to ${absolutePath})`}.`, {
        path: displayPath,
        recovery: "Check the path (relative paths resolve against the session cwd) or create the file with write.",
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
    const changedMatches = matched.filter((edit) => edit.changed);
    const fallbackEdits = [...new Set(matched.filter((edit) => edit.fallback).map((edit) => edit.editIndex))].sort((a, b) => a - b);
    const notices = edits.flatMap((edit, editIndex) => edit.regex !== undefined && !/m/.test(edit.regexFlags ?? "") && usesLineAnchors(edit.regex)
      ? [`edits[${editIndex}] uses ^ or $ without regexFlags "m": they matched the start/end of the whole ${edit.lineRange ? "lineRange window" : "file"}, not of each line. Add regexFlags "m" for per-line anchors.`]
      : []);
    const result: EditResult = {
      path: displayPath,
      sha256Before: shortenHash(snapshot.hash)!,
      sha256After: sha256Token(finalText),
      appliedEdits: edits.length,
      matchedCount: matched.length,
      changedCount: changedMatches.length,
      diff: displayDiff.diff,
      patch,
      firstChangedLine: displayDiff.firstChangedLine,
      changedRanges: changedMatches.map((edit) => ({
        editIndex: edit.editIndex,
        matchIndex: edit.matchIndex,
        requestedLineRange: edit.requestedLineRange,
        matchedLineStart: edit.matchedLineStart,
        matchedLineEnd: edit.matchedLineEnd,
      })),
      ...(fallbackEdits.length > 0 ? { fallbackEdits } : {}),
      ...(notices.length > 0 ? { notices } : {}),
      ...(options.dryRun ? { dryRun: true } : {}),
    };

    abortIfRequested(signal);
    if (options.dryRun) return result;
    await atomicWrite(absolutePath, displayPath, finalText, snapshot, signal);
    return result;
  } catch (error) {
    throw classifyFsError(error, displayPath, "edit", absolutePath);
  }
}

/**
 * The lines of the edited file that a unified patch touches, as `start-end` (or one number): from its first to its last
 * added line, a deletion counting as the line that now follows it. Undefined for a patch with no change. The model reads
 * this range back when the compact diff left out the middle.
 */
export function changedLineRange(patch: string): string | undefined {
  let first = Infinity;
  let last = 0;
  let line = 0;
  // A deletion with no kept line after it in its hunk is at the end of the file (a unified diff always carries trailing
  // context otherwise): the "next line" does not exist, so it counts as the file's last line instead.
  let tailDeletion = false;
  const note = (position: number) => { first = Math.min(first, position); last = Math.max(last, position); };
  const closeHunk = () => {
    if (tailDeletion && line > 1) note(line - 1);
    tailDeletion = false;
  };
  for (const text of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (header) { closeHunk(); line = Number(header[1]); continue; }
    if (line === 0 || text.startsWith("\\")) continue;
    if (text.startsWith("+")) { note(line); line++; tailDeletion = false; }
    else if (text.startsWith("-")) { tailDeletion = true; }
    else if (text.startsWith(" ")) {
      if (tailDeletion) { note(line); tailDeletion = false; }
      line++;
    }
  }
  closeHunk();
  if (last === 0) return undefined;
  return first === last ? `${first}` : `${first}-${last}`;
}

export const COMPACT_DIFF_MAX_LINES = 40;
/** When a diff is longer than the limit: this many lines from its start and from its end are kept, the middle is summarised. */
const COMPACT_DIFF_HEAD_LINES = 26;
const COMPACT_DIFF_TAIL_LINES = 12;
export const COMPACT_DIFF_MAX_LINE_CHARS = 200;
const COMPACT_DIFF_CONTEXT = 1;

/**
 * Condense a unified patch for model-visible text: drop file headers, keep at most
 * one context line around each change, bound line count/length and, when it is too long,
 * keep its first and last lines with one summary line between them. The full patch stays
 * available in structured details.
 */
export function compactPatch(patch: string): { text: string; added: number; removed: number; omittedLines: number } {
  const lines = patch.split("\n");
  const out: string[] = [];
  const append = (line: string) => {
    out.push(line.length > COMPACT_DIFF_MAX_LINE_CHARS
      ? `${line.slice(0, COMPACT_DIFF_MAX_LINE_CHARS)}…[+${line.length - COMPACT_DIFF_MAX_LINE_CHARS} chars]`
      : line);
  };
  let added = 0;
  let removed = 0;
  let index = lines.findIndex((line) => line.startsWith("@@"));
  while (index !== -1 && index < lines.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[index]);
    let end = index + 1;
    while (end < lines.length && !lines[end].startsWith("@@")) end++;
    let body = lines.slice(index + 1, end);
    while (body.length > 0 && body[body.length - 1] === "") body.pop();
    for (const line of body) {
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
    let lead = 0;
    while (lead < body.length && body[lead].startsWith(" ")) lead++;
    let tail = 0;
    while (tail < body.length - lead && body[body.length - 1 - tail].startsWith(" ")) tail++;
    const dropLead = Math.max(0, lead - COMPACT_DIFF_CONTEXT);
    const dropTail = Math.max(0, tail - COMPACT_DIFF_CONTEXT);
    body = body.slice(dropLead, body.length - dropTail);
    if (header) {
      const content = body.filter((line) => !line.startsWith("\\"));
      const oldLength = content.filter((line) => !line.startsWith("+")).length;
      const newLength = content.filter((line) => !line.startsWith("-")).length;
      const oldStart = Number(header[1]) + (oldLength > 0 ? dropLead : 0);
      const newStart = Number(header[3]) + (newLength > 0 ? dropLead : 0);
      append(`@@ -${oldStart},${oldLength} +${newStart},${newLength} @@`);
    } else {
      append(lines[index]);
    }
    for (const line of body) append(line);
    index = end < lines.length ? end : -1;
  }
  if (out.length <= COMPACT_DIFF_MAX_LINES) return { text: out.join("\n"), added, removed, omittedLines: 0 };
  const omittedLines = out.length - COMPACT_DIFF_HEAD_LINES - COMPACT_DIFF_TAIL_LINES;
  const text = [...out.slice(0, COMPACT_DIFF_HEAD_LINES), `… ${omittedLines} diff line(s) omitted …`, ...out.slice(out.length - COMPACT_DIFF_TAIL_LINES)].join("\n");
  return { text, added, removed, omittedLines };
}

export function truncateFeedback(content: string): { content: string; truncated: boolean } {
  const result = truncateCompleteLines(content);
  if (!result.truncated) return { content, truncated: false };
  return {
    content: `${result.content}\n[OUTPUT_TRUNCATED] Showing ${result.outputLines}/${result.totalLines} lines and ${result.outputBytes}/${result.totalBytes} bytes.`,
    truncated: true,
  };
}
