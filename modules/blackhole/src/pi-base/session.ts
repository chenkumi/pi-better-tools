// Session file tree-walking utilities.

import type { FileEntry } from "@earendil-works/pi-coding-agent";

/**
 * Walk from `leafId` up through `parentId` to the root, returning the
 * ancestor chain. Stops at root (parentId null) or if a cycle is detected.
 *
 * Returns the chain from leaf to root (leaf first, root last).
 * Returns empty array if `leafId` is not found in `entries`.
 *
 * Accepts `FileEntry[]` — the raw session entries including the header.
 * The header (which lacks id/parentId) is ignored automatically.
 */
export function getAncestorChain(entries: FileEntry[], leafId: string): string[] {
  const byId = new Map<string, { id: string; parentId: string | null }>();
  for (const entry of entries) {
    // Skip session header — it has no id/parentId
    if (entry.type === "session") continue;
    // All non-header entries share id/parentId via SessionEntryBase;
    // construct the shape explicitly instead of casting the union.
    byId.set(entry.id, { id: entry.id, parentId: entry.parentId ?? null });
  }

  const chain: string[] = [];
  let current = byId.get(leafId);
  const visited = new Set<string>();

  while (current) {
    if (visited.has(current.id)) break;
    visited.add(current.id);
    chain.push(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  return chain;
}
