import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { FileToolError, type FileToolErrorCode } from "./errors.js";

export const DIFF_TIMEOUT_MS = 2_000;
export const DIFF_WORKER_OLD_GENERATION_MB = 256;
export const MAX_DIFF_OUTPUT_BYTES = 50 * 1024 * 1024;
export const DIFF_CONTEXT_LINES = 4;
const COMPARE_CHUNK = 64 * 1024;

export interface DiffFeedback {
  diff: string;
  patch: string;
  firstChangedLine?: number;
}

/** Internal fault-injection seam only; never expose these through a tool schema. */
export interface DiffRunnerTestOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  workerFactory?: (url: URL, options: WorkerOptions) => Worker;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The changed region plus context, and the whole-file line facts the worker needs for display. */
export interface DiffWindow {
  oldWindow: string;
  newWindow: string;
  /** Number of unchanged lines before the window (identical in both files). */
  lineOffset: number;
  oldSplitCount: number;
  newSplitCount: number;
  oldActualCount: number;
}

function commonPrefixLength(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  let index = 0;
  // Chunked equality uses native string comparison instead of a per-character JS loop.
  while (index < max) {
    const end = Math.min(index + COMPARE_CHUNK, max);
    if (left.slice(index, end) === right.slice(index, end)) {
      index = end;
      continue;
    }
    while (left.charCodeAt(index) === right.charCodeAt(index)) index++;
    return index;
  }
  return max;
}

function commonSuffixLength(left: string, right: string, max: number): number {
  let length = 0;
  while (length < max) {
    const next = Math.min(length + COMPARE_CHUNK, max);
    if (left.slice(left.length - next, left.length - length) === right.slice(right.length - next, right.length - length)) {
      length = next;
      continue;
    }
    while (left.charCodeAt(left.length - length - 1) === right.charCodeAt(right.length - length - 1)) length++;
    return length;
  }
  return max;
}

function countNewlines(text: string, start = 0, end = text.length): number {
  let count = 0;
  for (let index = text.indexOf("\n", start); index !== -1 && index < end; index = text.indexOf("\n", index + 1)) count++;
  return count;
}

/**
 * Trim the unchanged head and tail at line boundaries, keeping `context` lines around the change,
 * so diff cost scales with the edit instead of the file. Prefix/suffix trimming preserves a valid
 * minimal line diff; hunk coordinates are restored in the worker via `lineOffset`.
 */
export function computeDiffWindow(oldContent: string, newContent: string, context = DIFF_CONTEXT_LINES): DiffWindow {
  const prefix = commonPrefixLength(oldContent, newContent);
  const suffix = commonSuffixLength(oldContent, newContent, Math.min(oldContent.length, newContent.length) - prefix);

  // Start of the line containing the first difference, then back off `context` whole lines.
  let start = prefix === 0 ? 0 : oldContent.lastIndexOf("\n", prefix - 1) + 1;
  for (let line = 0; line < context && start > 0; line++) {
    start = start >= 2 ? oldContent.lastIndexOf("\n", start - 2) + 1 : 0;
  }

  // End after the first newline inside the common suffix (so both files have it), plus `context` lines.
  let oldEnd = oldContent.length;
  let newline = oldContent.indexOf("\n", oldContent.length - suffix);
  if (newline !== -1) {
    oldEnd = newline + 1;
    for (let line = 0; line < context && oldEnd < oldContent.length; line++) {
      newline = oldContent.indexOf("\n", oldEnd);
      oldEnd = newline === -1 ? oldContent.length : newline + 1;
    }
  }
  const tailLength = oldContent.length - oldEnd;
  const newEnd = newContent.length - tailLength;

  const lineOffset = countNewlines(oldContent, 0, start);
  const tailNewlines = countNewlines(oldContent, oldEnd);
  const oldSplitCount = lineOffset + countNewlines(oldContent, start, oldEnd) + tailNewlines + 1;
  const newSplitCount = lineOffset + countNewlines(newContent, start, newEnd) + tailNewlines + 1;
  return {
    oldWindow: oldContent.slice(start, oldEnd),
    newWindow: newContent.slice(start, newEnd),
    lineOffset,
    oldSplitCount,
    newSplitCount,
    oldActualCount: oldContent.length === 0 ? 0 : oldSplitCount - (oldContent.endsWith("\n") ? 1 : 0),
  };
}

/** Pure feedback calculation. The caller must await this BEFORE committing any file. */
export async function createDiffFeedback(
  oldContent: string,
  newContent: string,
  displayPath: string,
  signal?: AbortSignal,
  options: DiffRunnerTestOptions = {},
): Promise<DiffFeedback> {
  // Start before worker construction: serialization and worker/module startup count too.
  const started = performance.now();
  const timeoutMs = options.timeoutMs ?? DIFF_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_DIFF_OUTPUT_BYTES;
  const failure = (code: FileToolErrorCode, message: string, causeCode?: string) => new FileToolError(code, message, {
    path: displayPath,
    ...(causeCode === undefined ? {} : { causeCode }),
    recovery: "Read the file again, then retry with a smaller edit or narrower search scope.",
  });
  const aborted = () => failure("OPERATION_ABORTED", "Diff generation was aborted; no edit was committed.");
  const timedOut = () => failure("OPERATION_TIMEOUT", "Diff generation exceeded its time limit; no edit was committed.");
  const tooLarge = () => failure("RESULT_TOO_LARGE", "Diff feedback exceeded its resource limit; no edit was committed.");
  const ioError = () => failure("IO_ERROR", "The diff worker failed to return valid feedback; no edit was committed.");
  const classifyWorkerError = (error: unknown) => {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
    return code === "ERR_WORKER_OUT_OF_MEMORY" || code === "ERR_STRING_TOO_LONG"
      ? tooLarge()
      : failure("IO_ERROR", "The diff worker could not run; no edit was committed.", code);
  };

  if (signal?.aborted) throw aborted();
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > DIFF_TIMEOUT_MS ||
      !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0 || maxOutputBytes > MAX_DIFF_OUTPUT_BYTES) {
    throw failure("IO_ERROR", "Invalid internal diff worker limits.");
  }
  if (timeoutMs === 0) throw timedOut();

  return new Promise<DiffFeedback>((resolve, reject) => {
    let worker: Worker | undefined;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error?: FileToolError, result?: DiffFeedback): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // Keep the guarded error listener until termination has completed. In particular,
      // an error racing an abort must not become an unhandled EventEmitter error.
      void (async () => {
        try {
          if (worker) await worker.terminate();
        } catch (terminationError) {
          error ??= classifyWorkerError(terminationError);
        } finally {
          worker?.off("message", onMessage);
          worker?.off("messageerror", onMessageError);
          worker?.off("error", onError);
          worker?.off("exit", onExit);
        }
        // Abort/deadline may also cross while waiting for successful worker teardown.
        error ??= signal?.aborted ? aborted() : performance.now() - started >= timeoutMs ? timedOut() : undefined;
        if (error) reject(error);
        else if (result) resolve(result);
        else reject(ioError());
      })();
    };
    const expiredOrAborted = (): boolean => {
      if (settled) return true;
      if (signal?.aborted) {
        finish(aborted());
        return true;
      }
      if (performance.now() - started >= timeoutMs) {
        finish(timedOut());
        return true;
      }
      return false;
    };
    const onAbort = () => finish(aborted());
    const onError = (error: unknown) => {
      if (!expiredOrAborted()) finish(classifyWorkerError(error));
    };
    const onMessageError = () => {
      if (!expiredOrAborted()) finish(ioError());
    };
    const onExit = () => {
      // Even a successful exit without a result is a protocol failure.
      if (!expiredOrAborted()) finish(ioError());
    };
    const onMessage = (message: unknown) => {
      if (expiredOrAborted()) return;
      if (!isRecord(message)) return finish(ioError());
      if (message.type === "error") {
        if (message.code === "RESULT_TOO_LARGE") return finish(tooLarge());
        if (message.code === "OPERATION_TIMEOUT") return finish(timedOut());
        return finish(ioError());
      }
      if (message.type !== "result" || typeof message.diff !== "string" || typeof message.patch !== "string" ||
          (message.firstChangedLine !== undefined &&
           (typeof message.firstChangedLine !== "number" || !Number.isSafeInteger(message.firstChangedLine) ||
            message.firstChangedLine < 1 || message.firstChangedLine > newContent.length + 1))) {
        return finish(ioError());
      }
      // Do not trust the worker's accounting, including the byte/code-unit distinction.
      // The code-unit check cheaply rejects huge strings before scanning their UTF-8 size.
      if (message.diff.length + message.patch.length > maxOutputBytes ||
          Buffer.byteLength(message.diff, "utf8") + Buffer.byteLength(message.patch, "utf8") > maxOutputBytes) {
        return finish(tooLarge());
      }
      if (expiredOrAborted()) return;
      finish(undefined, {
        diff: message.diff,
        patch: message.patch,
        ...(message.firstChangedLine === undefined ? {} : { firstChangedLine: message.firstChangedLine as number }),
      });
    };

    // A parent timer, rather than jsdiff's cooperative timeout, can interrupt busy JS.
    timer = setTimeout(() => finish(signal?.aborted ? aborted() : timedOut()), timeoutMs);
    try {
      const factory = options.workerFactory ?? ((url: URL, workerOptions: WorkerOptions) => new Worker(url, workerOptions));
      const window = computeDiffWindow(oldContent, newContent);
      worker = factory(new URL("./diff-worker.mjs", import.meta.url), {
        workerData: {
          oldContent: window.oldWindow,
          newContent: window.newWindow,
          lineOffset: window.lineOffset,
          oldSplitCount: window.oldSplitCount,
          newSplitCount: window.newSplitCount,
          oldActualCount: window.oldActualCount,
          context: DIFF_CONTEXT_LINES,
          displayPath,
          timeoutMs,
          maxOutputBytes,
        },
        // This worker is plain ESM JavaScript, not TS: do not inherit host loaders or --test.
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: DIFF_WORKER_OLD_GENERATION_MB },
      });
      worker.on("message", onMessage);
      worker.on("messageerror", onMessageError);
      worker.on("error", onError);
      worker.on("exit", onExit);
      signal?.addEventListener("abort", onAbort, { once: true });
      // Covers cancellation or a deadline crossed during synchronous construction.
      expiredOrAborted();
    } catch (error) {
      finish(signal?.aborted ? aborted() : performance.now() - started >= timeoutMs ? timedOut() : classifyWorkerError(error));
    }
  });
}
