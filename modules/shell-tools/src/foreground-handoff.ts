import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { MAX_LOG_BYTES, appendTail } from "./background-jobs.js";

/** Safety net: a foreground command without timeoutMs moves to a background job after this long. */
export const DEFAULT_AUTO_BACKGROUND_MS = 300_000;
const MAX_SETTING_MS = 2_147_483_647;

/** `pi-shell-tools.autoBackgroundMs`: positive integer ms, `0` disables; anything else keeps the default. */
export function resolveAutoBackgroundMs(settings: unknown): number {
  const value = (settings as { "pi-shell-tools"?: { autoBackgroundMs?: unknown } } | undefined)?.["pi-shell-tools"]?.autoBackgroundMs;
  if (value === 0) return 0;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_SETTING_MS ? value : DEFAULT_AUTO_BACKGROUND_MS;
}

type Wrap = (operations: BashOperations) => BashOperations;
type OnData = (data: Buffer) => void;

/**
 * Lets a running foreground command be adopted by a background job without restarting it.
 * Until `attach`, output goes to the host (live UI/accumulator) and is also kept in a bounded
 * head+tail record. `attach` replays that record through the job's own log/tail writer, then routes
 * every later chunk there; the job's writer forwards a capped copy back to the host accumulator.
 */
export function createForegroundHandoff() {
  let hostOnData: OnData | undefined;
  let sink: OnData | undefined;
  const head: Buffer[] = [];
  let headBytes = 0, totalBytes = 0, tail: Buffer = Buffer.alloc(0);

  const record = (data: Buffer) => {
    totalBytes += data.length;
    const room = MAX_LOG_BYTES - headBytes;
    if (room > 0) {
      const part = Buffer.from(data.subarray(0, room));
      head.push(part); headBytes += part.length;
    }
    tail = appendTail(tail, data);
  };

  return {
    /** Wrap installed under the foreground run: tees live output into the record until adoption. */
    wrap: ((operations: BashOperations): BashOperations => ({
      exec: (command, cwd, options) => {
        hostOnData = options.onData;
        return operations.exec(command, cwd, {
          ...options,
          onData: data => {
            if (sink) { sink(data); return; }
            record(data);
            hostOnData?.(data);
          },
        });
      },
    })) as Wrap,
    /** True once the job owns the output stream. */
    get attached() { return sink !== undefined; },
    /**
     * Synchronously replay the record through `jobWrap` and take over all later output. Runs inside the job
     * runner, so no output can interleave between replay and takeover.
     */
    attach(jobWrap: Wrap, cwd: string, signal: AbortSignal) {
      let jobOnData: OnData | undefined;
      let replaying = true;
      const stub: BashOperations = { exec: async (_command, _cwd, options) => { jobOnData = options.onData; return { exitCode: 0 }; } };
      void jobWrap(stub).exec("", cwd, {
        signal,
        // The host already received the replayed bytes live; only post-replay capped chunks go back.
        onData: data => { if (!replaying) hostOnData?.(data); },
      });
      if (!jobOnData) throw new Error("Shell job writer did not accept the foreground output stream");
      for (const chunk of head) jobOnData(chunk);
      // Bytes between the retained head and the tail window were never kept: replay only the real tail beyond the head.
      const beyondHead = totalBytes - headBytes;
      if (beyondHead > 0) jobOnData(tail.subarray(Math.max(0, tail.length - beyondHead)));
      replaying = false;
      sink = jobOnData;
    },
  };
}
