import { ulid } from "ulid";
import type { BackgroundTask } from "./background.ts";

type Live = (index: number, sessionId: string, path: string) => void;
type Finish = (index: number, result: unknown, status: BackgroundTask["status"]) => void;

/**
 * Lets a running foreground dispatch be adopted by a background job without restarting any child.
 * Until `adopt`, per-task live-log and settlement events are only recorded. `adopt` replays them into the
 * job's callbacks and routes every later event there, so the job reports the same task identities.
 */
export function createForegroundHandoff(count: number) {
  const taskIds = Array.from({ length: count }, () => ulid().toUpperCase());
  const live = new Map<number, { sessionId: string; path: string }>();
  const settled = new Map<number, { result: unknown; status: BackgroundTask["status"] }>();
  let sink: { live: Live; finish: Finish } | undefined;
  return {
    taskIds,
    /** Child log became readable (runner `onLiveLog`). */
    onLive(index: number, sessionId: string, path: string) {
      if (sink) sink.live(index, sessionId, path); else live.set(index, { sessionId, path });
    },
    /** Child settled with a background-shaped result. */
    onSettled(index: number, result: unknown, status: BackgroundTask["status"]) {
      if (sink) sink.finish(index, result, status); else settled.set(index, { result, status });
    },
    get adopted() { return sink !== undefined; },
    /** Synchronous: no event can interleave between replay and takeover. */
    adopt(onLive: Live, onFinish: Finish) {
      for (const [index, entry] of live) onLive(index, entry.sessionId, entry.path);
      for (const [index, entry] of settled) onFinish(index, entry.result, entry.status);
      live.clear(); settled.clear();
      sink = { live: onLive, finish: onFinish };
    },
  };
}
