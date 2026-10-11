/**
 * Session-global message indices — the single definition of the `#N` index space.
 *
 * Recall (`src/core/load-messages.ts`) numbers every `type == "message"` entry
 * in session-file order, counting across compaction windows and abandoned
 * branches. Compaction summaries must emit the same numbers, but `normalize`
 * historically numbered the selected window from zero. This module owns the
 * counting rule so both sides agree by construction.
 *
 * Created for the summary/recall index-space fix; not ported from upstream.
 */
import { scanSessionEntries } from "./session-lines.js";

/** Entries counted by the global `#N` index: persisted message entries. */
export const isCountedMessageEntry = (entry: any): boolean =>
  entry?.type === "message" && entry.message != null;

/**
 * Map session entry ids to their global message index (position among counted
 * message entries in array order, which matches session-file order).
 *
 * Entries without a usable id are still counted (they occupy an index) but
 * produce no map entry. Duplicate ids are ambiguous — dropped fail-closed so
 * callers emit no ref instead of a wrong one (mirrors tool-output-budget).
 */
export const buildGlobalIndexById = (entries: readonly any[]): Map<string, number> => {
  const byId = new Map<string, number>();
  const ambiguous = new Set<string>();
  let messageIndex = 0;
  for (const entry of entries) {
    if (!isCountedMessageEntry(entry)) continue;
    const id = entry?.id;
    if (typeof id === "string" && id.length > 0) {
      if (byId.has(id) || ambiguous.has(id)) {
        byId.delete(id);
        ambiguous.add(id);
      } else {
        byId.set(id, messageIndex);
      }
    }
    messageIndex++;
  }
  return byId;
};

/**
 * Build the same map by parsing a session JSONL file. Malformed lines are
 * skipped silently (load-messages already warns). Returns undefined when the
 * file cannot be read.
 */
export const loadGlobalIndexById = (sessionFile: string): Map<string, number> | undefined => {
  // Streamed like load-messages (upstream pi-vcc #26): no whole-file string.
  const entries: any[] = [];
  let retainedBytes = 0;
  let overBudget = false;
  const scan = scanSessionEntries(sessionFile, (entry) => {
    if (!isCountedMessageEntry(entry)) return;
    const bytes = (typeof entry.id === "string" ? entry.id.length * 2 : 0) + 256;
    if (retainedBytes + bytes > 8 * 1024 * 1024) { overBudget = true; return; }
    retainedBytes += bytes;
    // Counting needs only identity and a message sentinel, not raw payloads.
    entries.push({ type: "message", id: entry.id, message: {} });
  });
  if (scan.missing || scan.incomplete || overBudget) return undefined;
  return buildGlobalIndexById(entries);
};
