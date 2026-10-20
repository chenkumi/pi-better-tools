import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import { parentPort, workerData } from "node:worker_threads";

// Load the diff module dynamically so the parent can tell when startup (module loading) has
// finished: its compute budget starts at the "ready" message, not at worker construction.
const { FILE_HEADERS_ONLY, formatPatch, structuredPatch } = await import("diff");

// Pure computation only: this worker never opens or writes the edited file.
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const NO_NEWLINE_MARKER = "\\ No newline at end of file";

class OutputLimitError extends Error {}

// Segmented diff: jsdiff costs O(lines x changes) when changes are spread over a large window.
// Cut the window at runs of at least MIN_RUN identical lines (> 2 * context, so whole-file jsdiff
// would also have started a new hunk there) and diff each changed region with its own context.
// Any such cut yields a valid line diff: the skipped runs are identical on both sides.
const SEGMENT_MIN_LINES = 1000;
const MIN_RUN = 10;
const RESYNC_WINDOW = 64;

function splitLines(text) {
  const lines = [];
  let start = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", start)) {
    lines.push(text.slice(start, index + 1));
    start = index + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

function blockEqual(a, i, b, j) {
  if (i + MIN_RUN > a.length || j + MIN_RUN > b.length) return false;
  for (let k = 0; k < MIN_RUN; k++) if (a[i + k] !== b[j + k]) return false;
  return true;
}

function resync(a, b, i, j) {
  for (let total = 1; total <= 2 * RESYNC_WINDOW; total++) {
    for (let p = Math.max(0, total - RESYNC_WINDOW); p <= Math.min(total, RESYNC_WINDOW); p++) {
      if (blockEqual(a, i + p, b, j + total - p)) return { p, q: total - p };
    }
  }
  return undefined;
}

// Line ranges [{ oldStart, oldEnd, newStart, newEnd }] to diff independently, each with up to
// `context` identical lines on both sides. The last range runs to the end when no resync is found.
function segmentRanges(a, b, context) {
  const ranges = [];
  let i = 0;
  let j = 0;
  for (;;) {
    while (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; }
    if (i === a.length && j === b.length) return ranges;
    const lead = Math.min(context, i, j);
    const oldStart = i - lead;
    const newStart = j - lead;
    const found = resync(a, b, i, j);
    if (!found) {
      ranges.push({ oldStart, oldEnd: a.length, newStart, newEnd: b.length });
      return ranges;
    }
    i += found.p;
    j += found.q;
    ranges.push({ oldStart, oldEnd: Math.min(a.length, i + context), newStart, newEnd: Math.min(b.length, j + context) });
  }
}

// One calculation per region; returns undefined on cooperative timeout.
function diffHunks(displayPath, oldContent, newContent, context, timeoutMs) {
  const started = performance.now();
  const remaining = () => Math.max(1, timeoutMs - (performance.now() - started));
  const options = () => ({ context, timeout: remaining() });
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  if (oldLines.length + newLines.length < SEGMENT_MIN_LINES) {
    return structuredPatch(displayPath, displayPath, oldContent, newContent, undefined, undefined, options())?.hunks;
  }
  const hunks = [];
  for (const range of segmentRanges(oldLines, newLines, context)) {
    const piece = structuredPatch(displayPath, displayPath,
      oldLines.slice(range.oldStart, range.oldEnd).join(""), newLines.slice(range.newStart, range.newEnd).join(""),
      undefined, undefined, options());
    if (!piece) return undefined;
    for (const hunk of piece.hunks) {
      hunk.oldStart += range.oldStart;
      hunk.newStart += range.newStart;
      hunks.push(hunk);
    }
  }
  return hunks;
}

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

// oldContent/newContent are only the changed window (see computeDiffWindow); whole-file line
// facts for numbering width and the trailing gap come from the parent.
function makeFeedback({
  oldContent, newContent, lineOffset, oldSplitCount, newSplitCount, oldActualCount, context,
  displayPath, timeoutMs, maxOutputBytes,
}) {
  if (typeof oldContent !== "string" || typeof newContent !== "string" || typeof displayPath !== "string" ||
      !isCount(lineOffset) || !isCount(oldSplitCount) || !isCount(newSplitCount) || !isCount(oldActualCount) || !isCount(context) ||
      !Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
      !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0 || maxOutputBytes > MAX_OUTPUT_BYTES) {
    throw new Error("Invalid worker input");
  }

  // Exactly one diff calculation; the parent watchdog remains the authoritative limit.
  const hunks = diffHunks(displayPath, oldContent, newContent, context, timeoutMs);
  if (!hunks) return { type: "error", code: "OPERATION_TIMEOUT" };
  // Restore whole-file coordinates for the trimmed unchanged head.
  for (const hunk of hunks) {
    hunk.oldStart += lineOffset;
    hunk.newStart += lineOffset;
  }
  const structured = { oldFileName: displayPath, newFileName: displayPath, hunks };

  let outputBytes = 0;
  const reserve = (bytes) => {
    if (bytes > maxOutputBytes - outputBytes) throw new OutputLimitError();
    outputBytes += bytes;
  };

  // Count the exact FILE_HEADERS_ONLY format before formatPatch allocates its output.
  // Include every line separator, including the final newline, and EOF markers.
  reserve(10 + 2 * Buffer.byteLength(displayPath, "utf8"));
  for (const hunk of structured.hunks) {
    const oldStart = hunk.oldStart - (hunk.oldLines === 0 ? 1 : 0);
    const newStart = hunk.newStart - (hunk.newLines === 0 ? 1 : 0);
    reserve(Buffer.byteLength(`@@ -${oldStart},${hunk.oldLines} +${newStart},${hunk.newLines} @@\n`, "utf8"));
    for (const line of hunk.lines) reserve(Buffer.byteLength(line, "utf8") + 1);
  }

  const width = String(Math.max(oldSplitCount, newSplitCount)).length;
  const display = [];
  const append = (prefix, body) => {
    // Reserve before concatenation/join, not after constructing a possibly huge result.
    reserve(Buffer.byteLength(prefix, "utf8") + Buffer.byteLength(body, "utf8") + (display.length === 0 ? 0 : 1));
    display.push(prefix + body);
  };
  const gap = () => append(` ${" ".repeat(width)} `, "…");
  let firstChangedLine;
  let previousOldEnd = 1;
  for (const hunk of structured.hunks) {
    if (hunk.oldStart > previousOldEnd) gap();
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      // A patch annotation is not a source line and must never shift line numbers.
      if (line === NO_NEWLINE_MARKER) continue;
      const kind = line[0];
      const body = line.slice(1);
      if (kind === "+") {
        firstChangedLine ??= newLine;
        append(`+${String(newLine++).padStart(width, " ")} `, body);
      } else if (kind === "-") {
        firstChangedLine ??= newLine;
        append(`-${String(oldLine++).padStart(width, " ")} `, body);
      } else if (kind === " ") {
        append(` ${String(oldLine++).padStart(width, " ")} `, body);
        newLine++;
      } else {
        throw new Error("Unexpected patch line");
      }
    }
    previousOldEnd = oldLine;
  }
  if (structured.hunks.length > 0 && previousOldEnd <= oldActualCount) gap();

  const diff = display.join("\n");
  // formatPatch mutates starts for zero-length hunks. Never give it the original
  // hunks used for display coordinates (including insertion/deletion of whole files).
  const patch = formatPatch({
    ...structured,
    hunks: structured.hunks.map((hunk) => ({ ...hunk, lines: hunk.lines.slice() })),
  }, FILE_HEADERS_ONLY);
  // Defensive check in case the installed formatter's serialization changes.
  if (Buffer.byteLength(diff, "utf8") + Buffer.byteLength(patch, "utf8") > maxOutputBytes) {
    throw new OutputLimitError();
  }
  return { type: "result", diff, patch, ...(firstChangedLine === undefined ? {} : { firstChangedLine }) };
}

try {
  parentPort.postMessage({ type: "ready" });
  parentPort.postMessage(makeFeedback(workerData));
} catch (error) {
  const resourceFailure = error instanceof OutputLimitError || error?.code === "ERR_STRING_TOO_LONG" || error?.code === "ERR_WORKER_OUT_OF_MEMORY";
  parentPort.postMessage({ type: "error", code: resourceFailure ? "RESULT_TOO_LARGE" : "IO_ERROR" });
} finally {
  parentPort.close();
}
