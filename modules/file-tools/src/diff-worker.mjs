import { Buffer } from "node:buffer";
import { parentPort, workerData } from "node:worker_threads";
import { FILE_HEADERS_ONLY, formatPatch, structuredPatch } from "diff";

// Pure computation only: this worker never opens or writes the edited file.
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const NO_NEWLINE_MARKER = "\\ No newline at end of file";

class OutputLimitError extends Error {}

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
  const structured = structuredPatch(displayPath, displayPath, oldContent, newContent, undefined, undefined, {
    context,
    timeout: timeoutMs,
  });
  if (!structured) return { type: "error", code: "OPERATION_TIMEOUT" };
  // Restore whole-file coordinates for the trimmed unchanged head.
  for (const hunk of structured.hunks) {
    hunk.oldStart += lineOffset;
    hunk.newStart += lineOffset;
  }

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
  parentPort.postMessage(makeFeedback(workerData));
} catch (error) {
  const resourceFailure = error instanceof OutputLimitError || error?.code === "ERR_STRING_TOO_LONG" || error?.code === "ERR_WORKER_OUT_OF_MEMORY";
  parentPort.postMessage({ type: "error", code: resourceFailure ? "RESULT_TOO_LARGE" : "IO_ERROR" });
} finally {
  parentPort.close();
}
