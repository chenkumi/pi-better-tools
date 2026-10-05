import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FileToolError } from "./errors.js";

const id = "(?:[0-9a-hjkmnp-tv-z]{26}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
const managedRun = new RegExp(`(?:^|/)subagent-sessions/${id}/runs/${id}/transcript\\.jsonl\\.partial$`);

/** Advisory only: never read a guessed file or replace the user's requested path. */
export async function hintMissingSubagentLog(
  error: FileToolError,
  absolutePath: string,
  probe: (path: string) => Promise<{ isFile(): boolean }> = lstat,
): Promise<FileToolError> {
  if (error.payload.code !== "FILE_NOT_FOUND" || !managedRun.test(absolutePath.replaceAll("\\", "/"))) return error;
  const candidate = join(dirname(absolutePath), "transcript.jsonl");
  let recovery: string;
  try {
    const info = await probe(candidate);
    if (!info.isFile()) return error;
    recovery = `The live subagent log may have been renamed during finalization. Retry read explicitly with path ${JSON.stringify(candidate)}; the same run-local offset can be reused. This is a path hint, not proof the job completed. Use the completion notification for the committed conversation log; its offsets may differ.`;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code !== "ENOENT") return error;
    recovery = "Neither the requested live subagent transcript nor its same-directory final transcript exists. Wait for the background job notification and use its logPath, or check job status. Do not infer completion from a missing log.";
  }
  return new FileToolError(error.payload.code, error.payload.message, { ...error.payload, recovery });
}
