import { statSync } from "fs";
import type { Message } from "@earendil-works/pi-ai";
import { renderMessage, type RenderedEntry } from "./render-entries";
import { isCountedMessageEntry } from "./global-indices.js";
import { scanSessionEntries } from "./session-lines.js";

export interface LoadedMessages {
  rendered: RenderedEntry[];
  rawMessages: Message[];
  entryIds: string[];
  incomplete: boolean;
  reasons: string[];
  retainedBytes: number;
  scanStats: ReturnType<typeof scanSessionEntries>;
}

// ── Session-file cache (LRU, invalidated by mtime) ─────────────────────────

interface CacheEntry {
  result: LoadedMessages;
  mtimeMs: number;
  timestamp: number;
  bytes: number;
}

const MAX_CACHE_SIZE = 3;
const CACHE_TTL_MS = 2_000;
const cache = new Map<string, CacheEntry>();
export const MESSAGE_RETAIN_MAX_BYTES = 8 * 1024 * 1024;
export const MESSAGE_CACHE_MAX_BYTES = 16 * 1024 * 1024;
export const messageCacheStats = () => ({ records: cache.size, retainedBytes: [...cache.values()].reduce((n, e) => n + e.bytes, 0) });

function cacheKey(
  sessionFile: string,
  full: boolean,
  allowedEntryIds: Set<string> | undefined,
): string {
  let hash = `${sessionFile}::${full}`;
  if (allowedEntryIds !== undefined) {
    // Include the full set as sorted JSON for collision-free caching
    hash += `::${JSON.stringify([...allowedEntryIds].sort())}`;
  }
  return hash;
}

function getCached(
  sessionFile: string,
  full: boolean,
  allowedEntryIds?: Set<string>,
): LoadedMessages | undefined {
  const key = cacheKey(sessionFile, full, allowedEntryIds);
  const entry = cache.get(key);
  if (!entry) return undefined;

  // Check TTL (mtime-based invalidation)
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }

  // Verify file mtime hasn't changed
  try {
    const mtimeMs = statSync(sessionFile).mtimeMs;
    if (mtimeMs !== entry.mtimeMs) {
      cache.delete(key);
      return undefined;
    }
  } catch {
    cache.delete(key);
    return undefined;
  }

  return entry.result;
}

function setCache(
  sessionFile: string,
  full: boolean,
  allowedEntryIds: Set<string> | undefined,
  result: LoadedMessages,
): void {
  try {
    const mtimeMs = statSync(sessionFile).mtimeMs;
    const key = cacheKey(sessionFile, full, allowedEntryIds);
    const bytes = result.retainedBytes + key.length * 2;
    if (bytes > MESSAGE_CACHE_MAX_BYTES) return;
    cache.delete(key);
    for (const [k, entry] of cache) if (Date.now() - entry.timestamp > CACHE_TTL_MS) cache.delete(k);
    while (cache.size >= MAX_CACHE_SIZE || messageCacheStats().retainedBytes + bytes > MESSAGE_CACHE_MAX_BYTES) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
    cache.set(key, { result, mtimeMs, timestamp: Date.now(), bytes });
  } catch {
    // Can't stat the file — don't cache
  }
}

export const loadAllMessages = (
  sessionFile: string,
  full: boolean,
  allowedEntryIds?: Set<string>,
  selectedIndices?: Set<number>,
): LoadedMessages => {
  // Selected expansion deliberately bypasses the generic cache; other payloads
  // are parsed for stable counting but never retained/rendered.
  const cached = selectedIndices ? undefined : getCached(sessionFile, full, allowedEntryIds);
  if (cached) return cached;

  const rendered: RenderedEntry[] = [];
  const rawMessages: Message[] = [];
  const entryIds: string[] = [];

  let messageIndex = 0;
  let retainedBytes = 0;
  let retainedLimit = false;
  // Streamed per upstream pi-vcc #26: never materialize the whole session
  // file as one string (V8 limit). Counting rule shared with
  // src/core/global-indices.ts — both index spaces must agree by construction.
  const scan = scanSessionEntries(sessionFile, (e) => {
    if (!isCountedMessageEntry(e)) return;

    const index = messageIndex++;
    const allowed = (!allowedEntryIds || allowedEntryIds.has(e.id)) && (!selectedIndices || selectedIndices.has(index));
    if (!allowed) return;
    const entryId = e.id != null ? String(e.id) : "";
    // Conservative serialized-payload charge plus UTF16 rendered strings and
    // per-record overhead. This is a byte admission budget, not a heap meter.
    const rawBytes = Buffer.byteLength(JSON.stringify(e.message), "utf8") * 4 + entryId.length * 4 + 256;
    if (retainedBytes + rawBytes > MESSAGE_RETAIN_MAX_BYTES) { retainedLimit = true; return; }
    const entry = renderMessage(e.message, index, entryId, full);
    const bytes = rawBytes + entry.summary.length * 2 + (entry.files ?? []).reduce((n, f) => n + f.length * 2, 0);
    if (retainedBytes + bytes > MESSAGE_RETAIN_MAX_BYTES) { retainedLimit = true; return; }
    retainedBytes += bytes;
    rendered.push(entry);
    rawMessages.push(e.message);
    entryIds.push(entryId);
  });
  if (scan.missing) {
    // Pi does not create a new session's JSONL until its first persisted
    // entry: empty current-session history, not a failure. Not cached — the
    // file may appear at any moment.
    return { rendered, rawMessages, entryIds, incomplete: false, reasons: [], retainedBytes, scanStats: scan };
  }
  if (scan.parseErrors > 0) {
    console.warn(`blackhole: ${scan.parseErrors} malformed JSONL line(s) in ${sessionFile}`);
  }

  const reasons = [...scan.reasons, ...(retainedLimit ? ["retained_limit"] : [])];
  const result: LoadedMessages = { rendered, rawMessages, entryIds, incomplete: reasons.length > 0, reasons, retainedBytes, scanStats: scan };
  if (!selectedIndices) setCache(sessionFile, full, allowedEntryIds, result);
  return result;
};
